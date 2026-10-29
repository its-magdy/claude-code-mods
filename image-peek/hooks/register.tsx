import type { EngineInterface, Register } from 'claude-code'

import type { PeekImage } from '../types'
import { changed, edited, submitted } from './capture'
import { chip, hoverChip, hoverable, preview } from './chips'
import { ensureDir, host, hostFor, openExternally, removeDir, sweepStale } from './host'
import { drafts, forRow, latest, sent } from './list'
import { INLINE, draw, graphics } from './picture'
import { PANE, drawPane, openPane, resetPane } from './pane'
import { later, pictures, reset } from './pictures'
import { isDebugOn, isFullscreen, noteViewport, probe, toggleDebug } from './session'
import { keepSent, loadHistory } from './stored'

type $ = EngineInterface

/** Fewest rows a hover preview is drawn in; with fewer the band shows a hint. */
const MIN_CARD_ROWS = 6

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'peek',
      description: 'Show pasted images: /peek, /peek N, /peek open N, /peek clear, /peek debug',
      argumentHint: '[N | open N | clear | debug]',
    })
    later($, 'start', async work => {
      await graphics($, options)
      await loadHistory($, options, work)
      await sweepStale($, await host($))
    })
    // Renews the folder's lease while the session lives, so no other
    // session's sweep takes it for abandoned.
    $.clock.every(60 * 60 * 1000, () => {
      void host($).then(h => ensureDir($, h))
    })
    return started
  })

  // No session.start follows a /clear or an in-session /resume: the process
  // goes on under a new id, so the old pictures go and a resumed
  // conversation's are read back here. A real exit shares one short bound
  // with every plugin; what it leaves, the next start sweeps.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    await reset($, 'leave')
    await resetPane($, 'session')
    const old = await hostFor($, e.sessionId)
    if (e.reason === 'clear' || e.reason === 'resume') {
      later($, 'switch', async work => {
        await removeDir($, old)
        if (e.reason === 'resume') await loadHistory($, options, work)
      }, 300)
    } else if (old.os !== 'windows' && next.budget.remainingMs > 300) {
      await removeDir($, old)
    }
    return ended
  })

  // The draft's pictures: what a paste, a drop or an engine insert put in
  // the box, and the tag a submit gives them (see capture.ts).
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await edited($, options, e, box)
    return box
  }).catch(($, e, next) => next(e))

  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    await changed($, options, e)
    return result
  }).catch(($, e, next) => next(e))

  // Tags the draft's pictures before the prompt's row draws, so the row
  // finds them even before the stored bytes arrive.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    await submitted($, e)
    return result
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (stored.deny === undefined && e.agentId === undefined && e.message.type === 'user' && e.door === 'prompt') {
      const content = stored.message.content
      if (content.some(b => b.type === 'image')) {
        const messageId = stored.uuid
        later($, 'sent', work => keepSent($, options, work, content, messageId))
      }
    }
    return stored
  }).catch(($, e, next) => next(e))

  // The band above the prompt: a thumbnail for each image in the draft, so a
  // paste shows at once where you type. A click shows it big in the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    noteViewport(e.viewport)
    if (e.props.hasSurvey) return next(e)
    const list = await pictures($)
    const inPrompt = drafts(list)
    const canHover = e.surface === 'terminal' && isFullscreen()
    // Pictures hidden until a chip is hovered (see chips.tsx).
    const hovered = canHover ? hoverable(list) : []
    if (inPrompt.length === 0 && hovered.length === 0) return next(e)
    const { Box } = $.ui.resolve(e)
    const label = (img: PeekImage) => chip($, e, img, 'band', () => openPane($, img))
    if (e.surface !== 'terminal') {
      return (
        <Box flexDirection="row" gap={2}>
          {inPrompt.map(label)}
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
    // With no pointer (the main screen) the draft's thumbnails show outright.
    const rows = Math.max(2, Math.min(INLINE.rows, e.props.maxRows - 1))
    const pics = canHover ? [] : await Promise.all(inPrompt.map(img => draw($, e, options, img, 'inline', INLINE.columns, rows)))
    return (
      <Box flexDirection="column">
        {room >= 1 && hovered.map((img, i) => preview($, e, img, previews[i]))}
        {inPrompt.length > 0 && (
          <Box flexDirection="row" gap={canHover ? 2 : 3}>
            {inPrompt.map((img, i) =>
              canHover ? (
                hoverChip($, e, img, 'band', () => openPane($, img))
              ) : (
                <Box key={`band-${img.id}`} flexDirection="column">
                  {label(img)}
                  {pics[i]}
                </Box>
              ),
            )}
          </Box>
        )}
      </Box>
    )
  })

  // A sent prompt with pictures: a chip per image under it. Fullscreen, the
  // chip shows the picture on hover and opens it in the pane on click; on the
  // main screen (no pointer) small thumbnails are drawn inline instead.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    noteViewport(e.viewport)
    if (!e.props.text.includes('[Image #')) return next(e)
    const list = await pictures($)
    const mine = forRow(list, e.requestId, e.props.text)
    if (await isDebugOn($)) {
      void probe($, 'UserMessage', { requestId: e.requestId, matched: mine.length, ids: list.map(img => img.messageId) })
    }
    if (mine.length === 0) return next(e)

    const own = await next(e)
    if (e.surface !== 'terminal') {
      const { Box, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {own}
          <Box flexDirection="row" gap={2}>
            {mine.map(img => (
              <Button key={`peek-${img.id}`} plain label={`▣ Image ${img.n}`} onPress={() => openPane($, img)} />
            ))}
          </Box>
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    if (e.viewport?.isFullscreen !== true) {
      const thumbs = await Promise.all(mine.map(img => draw($, e, options, img, 'inline', INLINE.columns, INLINE.rows)))
      return (
        <Box flexDirection="column">
          {own}
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

    // Hovering a chip shows its picture in the band (see chips.tsx).
    return (
      <Box flexDirection="column">
        {own}
        <Box flexDirection="row" gap={2} marginLeft={2}>
          {mine.map(img => hoverChip($, e, img, 'message', () => openPane($, img)))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    noteViewport(e.viewport)
    return drawPane($, e, options)
  })

  on('command.run', { command: 'peek' }, async ($, e) => {
    const [first, second] = e.args.trim().split(/\s+/).filter(Boolean)
    if (first === 'debug') {
      const isOn = await toggleDebug($)
      return { text: `Debug lines ${isOn ? 'shown in the transcript' : 'in the debug log only'}.` }
    }
    if (first === 'clear') {
      await reset($, 'delete')
      await resetPane($, 'list')
      return { text: 'Image list cleared.' }
    }
    const list = await pictures($)
    if (first === undefined) {
      const { isPlaced } = await openPane($)
      return { text: `${list.length} image${list.length === 1 ? '' : 's'}${isPlaced ? '' : ' (no surface draws the pane here)'}.` }
    }
    const isOpen = first === 'open'
    const n = Number(isOpen ? second : first)
    const img = Number.isInteger(n) ? latest(list, n) : undefined
    if (!img) return { text: `No Image #${isOpen ? second ?? '?' : first} yet. Usage: /peek [N | open N | clear | debug]` }
    if (isOpen || (await graphics($, options)) === 'off') {
      const isOpened = await openExternally($, await host($), img.path)
      return { text: isOpened ? `Opened Image #${n} in the system viewer.` : `Could not open ${img.path}.` }
    }
    await openPane($, img)
    return { text: `Showing Image #${n}.` }
  })
}
