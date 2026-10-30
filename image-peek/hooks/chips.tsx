// Chips: the "▣ Image N" a picture is clicked by, in the band above the prompt
// and under a sent message. In the fullscreen layout a chip shows its picture
// on hover: it lights the picture's hover scope, and the band holds the
// preview for that scope and shows it while the chip is hovered (a card drawn
// over the transcript would be painted over by the rows after it). So every
// picture whose chip can be hovered has a preview in the band. On the main
// screen (no pointer) small thumbnails are drawn inline instead.

import type { EngineInterface, PluginOptions, RenderElement, RenderInput } from 'claude-code'

import type { PeekImage } from '../types'
import { drafts, forRow, sent } from './list'
import { openPane } from './pane'
import { INLINE, draw } from './picture'
import { pictures } from './pictures'
import { isDebugOn, isFullscreen, probe } from './session'

type $ = EngineInterface
type Input = RenderInput<'UserMessage' | 'AbovePrompt'>
/** Where a chip is drawn: in the band above the prompt, or under its message. */
type Where = 'band' | 'message'

/** Fewest rows a hover preview is drawn in; with fewer the band shows a hint. */
const MIN_CARD_ROWS = 6

/** The hover group that ties a chip to its preview in the band. */
const scopeOf = (img: PeekImage) => `peek-${img.id}`.slice(0, 64)

const KEYS: Record<Where, { box: string; button: string }> = {
  band: { box: 'band', button: 'draft' },
  message: { box: 'chip', button: 'peek' },
}

/**
 * Whether chips show their pictures on hover: a terminal in the fullscreen
 * layout, where a pointer reaches them. The band goes by the last layout a
 * drawing reported, as its own drawing may report none; a row goes by its own.
 */
function canHover(e: Input, where: Where) {
  if (e.surface !== 'terminal') return false
  return where === 'band' ? isFullscreen() : e.viewport?.isFullscreen === true
}

/** The pictures whose chips can be hovered: the draft's in the band, the sent ones' in the transcript. */
const hoverable = (list: readonly PeekImage[]) => [...drafts(list), ...sent(list)]

/** A picture's chip, pressed to show it big in the pane; it lights the picture's hover scope. */
function chip($: $, e: Input, img: PeekImage, where: Where): RenderElement {
  const { Button, Text } = $.ui.resolve(e)
  return (
    <Button key={`${KEYS[where].button}-${img.id}`} plain onPress={() => openPane($, img)}>
      <Text color="cyan" hover={{ scope: scopeOf(img), bold: true, underline: true }}>▣ Image {img.n}</Text>
    </Button>
  )
}

/** A chip whose hover shows the picture's preview in the band (the fullscreen layout). */
function hoverChip($: $, e: Input, img: PeekImage, where: Where): RenderElement {
  const { Box } = $.ui.resolve(e)
  return (
    <Box key={`${KEYS[where].box}-${img.id}`} hover={{ scope: scopeOf(img) }}>
      {chip($, e, img, where)}
    </Box>
  )
}

/** The band's preview for a hoverable picture, hidden until its chip is hovered; with no picture, a hint to click. */
function preview($: $, e: Input, img: PeekImage, picture: RenderElement | undefined): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key={`preview-${img.id}`} flexDirection="column" display="none" hover={{ scope: scopeOf(img), display: 'flex' }}>
      <Text color="cyan" wrap="truncate">
        Image {img.n}
        {picture ? '' : ' · click to open'}
      </Text>
      {picture}
    </Box>
  )
}

/**
 * The band above the prompt: a chip for each picture in the draft, with its
 * thumbnail on the main screen, and fullscreen the hidden previews every
 * hoverable chip shows. Undefined when the band has nothing to show.
 */
export async function drawBand($: $, e: RenderInput<'AbovePrompt'>, options: PluginOptions): Promise<RenderElement | undefined> {
  if (e.props.hasSurvey) return undefined
  const list = await pictures($)
  const inPrompt = drafts(list)
  const isHover = canHover(e, 'band')
  const hovered = isHover ? hoverable(list) : []
  if (inPrompt.length === 0 && hovered.length === 0) return undefined
  const { Box } = $.ui.resolve(e)
  if (e.surface !== 'terminal') {
    return (
      <Box flexDirection="row" gap={2}>
        {inPrompt.map(img => chip($, e, img, 'band'))}
      </Box>
    )
  }
  // A preview, its title and the chip row fit the band whole: taller, it
  // scrolls, and the chips go out from under the pointer, the hover stuck.
  // With too little room (a small window, a tall prompt, a turn running)
  // a one-line hint stands in for a picture too small to see.
  const room = e.props.maxRows - (inPrompt.length > 0 ? 1 : 0)
  const bigRows = room - 1
  const hasRoom = bigRows >= MIN_CARD_ROWS
  const previews = hasRoom
    ? await Promise.all(hovered.map(img => draw($, e, options, img, 'card', e.props.bodyColumns - 2, bigRows)))
    : []
  const rows = Math.max(2, Math.min(INLINE.rows, e.props.maxRows - 1))
  const pics = isHover ? [] : await Promise.all(inPrompt.map(img => draw($, e, options, img, 'inline', INLINE.columns, rows)))
  return (
    <Box flexDirection="column">
      {room >= 1 && hovered.map((img, i) => preview($, e, img, previews[i]))}
      {inPrompt.length > 0 && (
        <Box flexDirection="row" gap={isHover ? 2 : 3}>
          {inPrompt.map((img, i) =>
            isHover ? (
              hoverChip($, e, img, 'band')
            ) : (
              <Box key={`band-${img.id}`} flexDirection="column">
                {chip($, e, img, 'band')}
                {pics[i]}
              </Box>
            ),
          )}
        </Box>
      )}
    </Box>
  )
}

/**
 * A sent prompt's row with a chip per picture under it: `own` draws the row
 * itself. Undefined when the row has no pictures.
 */
export async function drawRow(
  $: $,
  e: RenderInput<'UserMessage'>,
  options: PluginOptions,
  own: () => Promise<RenderElement>,
): Promise<RenderElement | undefined> {
  if (!e.props.text.includes('[Image #')) return undefined
  const list = await pictures($)
  const mine = forRow(list, e.requestId, e.props.text)
  if (await isDebugOn($)) {
    void probe($, 'UserMessage', { requestId: e.requestId, matched: mine.length, ids: list.map(img => img.messageId) })
  }
  if (mine.length === 0) return undefined

  const row = await own()
  if (e.surface !== 'terminal') {
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="row" gap={2}>
          {mine.map(img => (
            <Button key={`peek-${img.id}`} plain label={`▣ Image ${img.n}`} onPress={() => openPane($, img)} />
          ))}
        </Box>
      </Box>
    )
  }

  const { Box, Text } = $.ui.resolve(e)
  if (!canHover(e, 'message')) {
    const thumbs = await Promise.all(mine.map(img => draw($, e, options, img, 'inline', INLINE.columns, INLINE.rows)))
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="row" flexWrap="wrap" gap={2} marginLeft={2}>
          {mine.map((img, i) => (
            <Box key={`thumb-${img.id}`} flexDirection="column">
              <Text dimColor>Image {img.n}</Text>
              {thumbs[i]}
            </Box>
          ))}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {row}
      <Box flexDirection="row" gap={2} marginLeft={2}>
        {mine.map(img => hoverChip($, e, img, 'message'))}
      </Box>
    </Box>
  )
}
