// Chips: the "▣ Image N" a picture is clicked by, and in the fullscreen
// layout the preview a hovered chip shows. A chip lights its picture's hover
// scope; the band above the prompt holds the preview for that scope and shows
// it while the chip is hovered (a card drawn over the transcript would be
// painted over by the rows after it). So every picture whose chip can be
// hovered has a preview in the band: `hoverable` says which those are.

import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { PeekImage } from '../types'
import { drafts, sent } from './list'

type $ = EngineInterface
type Input = RenderInput<'UserMessage' | 'AbovePrompt'>
/** Where a chip is drawn: in the band above the prompt, or under its message. */
type Where = 'band' | 'message'

/** The hover group that ties a chip to its preview in the band. */
const scopeOf = (img: PeekImage) => `peek-${img.id}`.slice(0, 64)

const KEYS: Record<Where, { box: string; button: string }> = {
  band: { box: 'band', button: 'draft' },
  message: { box: 'chip', button: 'peek' },
}

/** The pictures whose chips can be hovered: the draft's in the band, the sent ones' in the transcript. */
export const hoverable = (list: readonly PeekImage[]) => [...drafts(list), ...sent(list)]

/** A picture's chip, pressed to show it big; it lights the picture's hover scope. */
export function chip($: $, e: Input, img: PeekImage, where: Where, onPress: () => unknown): RenderElement {
  const { Button, Text } = $.ui.resolve(e)
  return (
    <Button key={`${KEYS[where].button}-${img.id}`} plain onPress={onPress}>
      <Text color="cyan" hover={{ scope: scopeOf(img), bold: true, underline: true }}>▣ Image {img.n}</Text>
    </Button>
  )
}

/** A chip whose hover shows the picture's preview in the band (the fullscreen layout). */
export function hoverChip($: $, e: Input, img: PeekImage, where: Where, onPress: () => unknown): RenderElement {
  const { Box } = $.ui.resolve(e)
  return (
    <Box key={`${KEYS[where].box}-${img.id}`} hover={{ scope: scopeOf(img) }}>
      {chip($, e, img, where, onPress)}
    </Box>
  )
}

/** The band's preview for a hoverable picture, hidden until its chip is hovered; with no picture, a hint to click. */
export function preview($: $, e: Input, img: PeekImage, picture: RenderElement | undefined): RenderElement {
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
