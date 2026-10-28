import { atom, read, update } from 'claude-code'
import type { ApiContentBlock, EngineInterface, PluginOptions, Register } from 'claude-code'

import type { PeekImage, PeekSource } from '../types'
import { capture, notePaths, offerPaneAgain } from './capture'
import { ensureDir, host, hostFor, imagePaths, openExternally, removeDir, sweepStale, writeBase64 } from './host'
import {
  MAX_KEPT,
  drafts,
  dropDrafts,
  forRow,
  hasDraft,
  latest,
  placeholders,
  sent,
  storePrompt,
  tagDrafts,
  textOf,
  unread,
} from './list'
import { INLINE, draw, forget, graphics, warm } from './picture'
import { begin, claim, finish, isLive, keep, pictures, reset } from './pictures'
import type { Work } from './pictures'
import { PANE, isDebugOn, isFullscreen, later, noteViewport, probe, toggleDebug } from './session'

type $ = EngineInterface

const selected = atom({ plugin: 'image-peek', key: 'selected' } as const, null)
/** Fewest rows a hover preview is drawn in; with fewer the band shows a hint. */
const MIN_CARD_ROWS = 6

/** The hover group that ties a message's chip to its preview in the band. */
const scopeOf = (img: PeekImage) => `peek-${img.id}`.slice(0, 64)

/** Drops the session's pictures (see `reset`) and what was kept to draw them. */
async function resetPictures($: $, files: 'delete' | 'leave') {
  for (const img of await reset($, files)) forget(img)
}

/** Changes the list for the work (see `keep`); false when it was not made. */
async function setImages($: $, work: Work, change: (list: PeekImage[]) => PeekImage[]) {
  const { isKept, dropped } = await keep($, work, change)
  for (const img of dropped) forget(img)
  return isKept
}

/** Keeps the bytes a stored prompt carried: the pictures exactly as the model got them. */
async function keepPrompt(
  $: $,
  options: PluginOptions,
  work: Work,
  content: readonly ApiContentBlock[],
  where: { messageId?: string; idPrefix: string; source: PeekSource },
) {
  const blocks = content.filter(b => b.type === 'image')
  if (blocks.length === 0) return
  const text = textOf(content)
  const named = placeholders(text)
  const h = await host($)
  await ensureDir($, h)

  // What isn't kept (a failed write or conversion, a list a /peek clear or
  // a switch got to first) goes when the work ends; an earlier, listed copy
  // of this row has the same names, so those stay.
  const kept: PeekImage[] = []
  for (const [i, block] of blocks.entries()) {
    if (!isLive(work)) return
    const source = block.source as { type?: string; media_type?: string; data?: string } | undefined
    if (source?.type !== 'base64' || typeof source.data !== 'string') continue
    const n = named[i] ?? i + 1
    const ext = (source.media_type ?? 'image/png').split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
    const id = `${where.idPrefix}-${n}`
    const raw = claim(work, h, `${id}.${ext}`)
    const entry = (await writeBase64($, h, source.data, raw))
      ? await finish($, work, h, { id, n, source: where.source, file: raw, messageId: where.messageId, promptText: text })
      : undefined
    if (entry) kept.push(entry)
  }
  void probe($, where.source, { messageId: where.messageId, named, kept: kept.length, chars: text.length })
  if (kept.length === 0) return
  if (!(await setImages($, work, list => storePrompt(list, kept, { messageId: where.messageId, text })))) return
  // The cap may have left out the oldest of these; only listed pictures get cells.
  const listed = await pictures($)
  for (const img of kept) if (listed.some(entry => entry.id === img.id)) await warm($, options, img)
}

/** A resumed session's pictures, read back from the conversation; each user row by its place, so equal texts stay apart. */
async function loadHistory($: $, options: PluginOptions, work: Work) {
  const messages = await $.session.messages({ as: 'api' })
  if ('deny' in messages) return
  const rows = messages
    .map((m, index) => ({ content: m.content, idPrefix: `hist-${index}`, isPrompt: m.role === 'user' }))
    .filter(row => row.isPrompt && row.content.some(b => b.type === 'image') && !row.content.some(b => b.type === 'tool_result'))
    .slice(-MAX_KEPT)
  for (const row of unread(await pictures($), rows)) {
    await keepPrompt($, options, work, row.content, { idPrefix: row.idPrefix, source: 'history' })
  }
}

/** Opens the pane the person asked for: it takes the keys, and Escape closes it. */
const openPane = ($: $) => $.ui.open({ id: PANE, title: 'Images', focus: true, closeOnEscape: true })

async function select($: $, img: PeekImage) {
  await update($, selected, () => img.id)
  await openPane($)
}

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
    await resetPictures($, 'leave')
    await update($, selected, () => null)
    const old = await hostFor($, e.sessionId)
    if (e.reason === 'clear' || e.reason === 'resume') {
      offerPaneAgain()
      later($, 'switch', async work => {
        await removeDir($, old)
        if (e.reason === 'resume') await loadHistory($, options, work)
      }, 300)
    } else if (old.os !== 'windows' && next.budget.remainingMs > 300) {
      await removeDir($, old)
    }
    return ended
  })

  // A paste or a drop: an "[Image #N]" it leaves in the box is captured from
  // the file the paste named, else from the clipboard.
  on('prompt.edit', async ($, e, next) => {
    const before = placeholders(e.text)
    const paths = imagePaths(e.inputText)
    const box = await next(e)
    const after = placeholders(box.text)
    const added = after.filter(n => !before.includes(n))
    const isPaste = e.key === undefined && e.inputText.length > 1
    if (isPaste || added.length > 0 || paths.length > 0 || e.inputText.includes('[Image #')) {
      void probe($, 'prompt.edit', { chars: e.inputText.length, isKey: e.key !== undefined, added, paths: paths.length })
    }
    if (added.length > 0) await capture($, options, added, 'edit', paths)
    else if (paths.length > 0) await notePaths($, paths)
    const removed = before.filter(n => !after.includes(n))
    if (removed.length > 0) {
      later($, 'prune', work => setImages($, work, list => dropDrafts(list, n => removed.includes(n))))
    }
    return box
  }).catch(($, e, next) => next(e))

  // The box changed with no edit (an engine insert, a plugin's fill): catch
  // a placeholder the edit hook never saw. A clear drops untagged drafts.
  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    const present = placeholders(e.text)
    if (e.origin.kind === 'clear') {
      later($, 'prune', work => setImages($, work, list => dropDrafts(list, n => !present.includes(n))))
    } else if (present.length > 0 && e.origin.kind !== 'history') {
      void probe($, 'prompt.change', { origin: e.origin.kind, present })
      const list = await pictures($)
      const missing = present.filter(n => !hasDraft(list, n))
      if (missing.length > 0) await capture($, options, missing, `change:${e.origin.kind}`)
    }
    return result
  }).catch(($, e, next) => next(e))

  // Tags the draft's pictures with the prompt's text before its row draws, so
  // the row finds them even before the stored bytes arrive.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const attached = e.attachments?.filter(a => a.type === 'image') ?? []
    if (attached.length > 0 || e.text.includes('[Image #')) {
      void probe($, 'prompt.submit', {
        chars: e.text.length,
        attachments: attached.map(a => a.mediaType),
      })
      await setImages($, begin(), list => tagDrafts(list, e.text))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (stored.deny === undefined && e.agentId === undefined && e.message.type === 'user' && e.door === 'prompt') {
      const content = stored.message.content
      if (content.some(b => b.type === 'image')) {
        const messageId = stored.uuid
        later($, 'sent', work => keepPrompt($, options, work, content, { messageId, idPrefix: messageId, source: 'sent' }))
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
    // Pictures hidden until a chip is hovered: the draft's chips here, and
    // the sent ones' chips in the transcript.
    const hovered = canHover ? [...inPrompt, ...sent(list)] : []
    if (inPrompt.length === 0 && hovered.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const label = (img: PeekImage) => (
      <Button key={`draft-${img.id}`} plain onPress={() => select($, img)}>
        <Text color="cyan" hover={{ scope: scopeOf(img), bold: true, underline: true }}>▣ Image {img.n}</Text>
      </Button>
    )
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
        {room >= 1 &&
          hovered.map((img, i) => (
            <Box key={`preview-${img.id}`} flexDirection="column" display="none" hover={{ scope: scopeOf(img), display: 'flex' }}>
              <Text color="cyan" wrap="truncate">
                Image {img.n}
                {hasRoom ? '' : ' · click to open'}
              </Text>
              {hasRoom && previews[i]}
            </Box>
          ))}
        {inPrompt.length > 0 && (
          <Box flexDirection="row" gap={canHover ? 2 : 3}>
            {inPrompt.map((img, i) =>
              canHover ? (
                <Box key={`band-${img.id}`} hover={{ scope: scopeOf(img) }}>
                  {label(img)}
                </Box>
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
              <Button key={`peek-${img.id}`} plain label={`▣ Image ${img.n}`} onPress={() => select($, img)} />
            ))}
          </Box>
        </Box>
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)
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

    // The chip lights its hover scope; the band above the prompt holds the
    // picture for that scope and shows it while the chip is hovered. A card
    // drawn over the transcript would be painted over by the rows after it.
    return (
      <Box flexDirection="column">
        {own}
        <Box flexDirection="row" gap={2} marginLeft={2}>
          {mine.map(img => (
            <Box key={`chip-${img.id}`} hover={{ scope: scopeOf(img) }}>
              <Button key={`peek-${img.id}`} plain onPress={() => select($, img)}>
                <Text color="cyan" hover={{ scope: scopeOf(img), bold: true, underline: true }}>▣ Image {img.n}</Text>
              </Button>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    noteViewport(e.viewport)
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await pictures($)
    const selectedId = await read($, selected)
    const chosen = list.find(img => img.id === selectedId)
    const columns = Math.max(10, e.props.bodyColumns - 1)
    const rows = Math.max(6, e.props.scroll.bodyRows - 3)
    const closeButton = <Button key="close" label="Close" hotkey="c" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
    // The pane gets the keys on open only over an empty prompt; with a draft
    // they stay there, and Esc and the hotkeys reach the pane once it is focused.
    const keysHint = e.props.isFocused ? 'Esc closes' : 'click here to use keys'

    if (chosen) {
      const big = e.surface === 'terminal' ? await draw($, e, options, chosen, 'big', columns, rows) : undefined
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={2}>
            <Text bold>Image {chosen.n}</Text>
            <Text dimColor>{chosen.source}</Text>
            <Button key="back" label="Back" hotkey="b" onPress={() => update($, selected, () => null)} />
            <Button key="open" label="Open" hotkey="o" onPress={async () => void openExternally($, await host($), chosen.path)} />
            {closeButton}
            <Text dimColor>{keysHint}</Text>
          </Box>
          {big ?? <Text dimColor>{chosen.path}</Text>}
        </Box>
      )
    }

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No images yet.</Text>
          <Text dimColor>Paste one into the prompt (Ctrl+V; Alt+V on Windows) or drop a file.</Text>
        </Box>
      )
    }

    const section = async (title: string, items: PeekImage[]) => {
      if (items.length === 0) return []
      const pics = e.surface === 'terminal' ? await Promise.all(items.map(img => draw($, e, options, img, 'pane', columns, 10))) : []
      return [
        <Text key={`title-${title}`} bold>
          {title}
        </Text>,
        ...items.map((img, i) => (
          <Box key={`row-${img.id}`} flexDirection="column" marginBottom={1}>
            <Button key={`sel-${img.id}`} plain onPress={() => select($, img)}>
              <Text color="cyan">▣ Image {img.n}</Text> <Text dimColor>{img.source}</Text>
            </Button>
            {pics[i]}
          </Box>
        )),
      ]
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          {closeButton}
          <Text dimColor>{keysHint}</Text>
        </Box>
        {await section('In your prompt', drafts(list))}
        {await section('Sent', sent(list))}
      </Box>
    )
  })

  on('command.run', { command: 'peek' }, async ($, e) => {
    const [first, second] = e.args.trim().split(/\s+/).filter(Boolean)
    if (first === 'debug') {
      const isOn = await toggleDebug($)
      return { text: `Debug lines ${isOn ? 'shown in the transcript' : 'in the debug log only'}.` }
    }
    if (first === 'clear') {
      await resetPictures($, 'delete')
      await update($, selected, () => null)
      return { text: 'Image list cleared.' }
    }
    const list = await pictures($)
    if (first === undefined) {
      await update($, selected, () => null)
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
    await select($, img)
    return { text: `Showing Image #${n}.` }
  })
}
