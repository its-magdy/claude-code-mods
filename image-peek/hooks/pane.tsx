// The Images pane: the list of the session's pictures, or one of them big.
// It opens when the person asks (a chip, /peek), taking the keys, or once a
// session for the first pasted picture (the autoOpenPane setting); what it
// shows, the list or a picture, is kept here.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, RenderElement, RenderInput } from 'claude-code'

import type { PeekImage } from '../types'
import { host } from './folder'
import { openExternally } from './host'
import { drafts, sent } from './list'
import { draw } from './picture'
import { pictures } from './pictures'
import { isFullscreen } from './session'

type $ = EngineInterface

/** The pane's id, which its render hook matches. */
export const PANE = 'image-peek'

const selected = atom({ plugin: 'image-peek', key: 'selected' } as const, null)

// Module state: rebuilt after a reload, and nothing drawn depends on it alone.
let isOffered = false

/** Opens the pane the person asked for, on `img` big or on the list: it takes the keys, and Escape closes it. */
export async function openPane($: $, img?: PeekImage) {
  await update($, selected, () => img?.id ?? null)
  return $.ui.open({ id: PANE, title: 'Images', focus: true, closeOnEscape: true })
}

/** Opens the pane once a session for a picture just pasted, where the setting asks and a pointer can reach it; the keys stay in the prompt. */
export async function offerPane($: $, options: PluginOptions) {
  if (options.autoOpenPane !== true || !isFullscreen() || isOffered) return
  isOffered = true
  await $.ui.open({ id: PANE, title: 'Images' })
}

/**
 * Back to the list: the pictures were cleared (`'list'`), or the session
 * ended (`'session'`), and the next pasted picture may open the pane again.
 */
export async function resetPane($: $, what: 'list' | 'session') {
  if (what === 'session') isOffered = false
  await update($, selected, () => null)
}

/** The pane: the picture chosen, big, or the draft's and the sent ones listed. */
export async function drawPane($: $, e: RenderInput<'Pane'>, options: PluginOptions): Promise<RenderElement> {
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
          <Button key={`sel-${img.id}`} plain onPress={() => openPane($, img)}>
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
}
