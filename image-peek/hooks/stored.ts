// Stored-prompt intake: the pictures a prompt's stored row carried, exactly
// as the model got them. A prompt just sent replaces what its draft held
// (the guess capture made); a resumed conversation's rows are read back,
// each by its place. The session hooks hand over rows; how they become
// listed pictures is decided here.

import type { ApiContentBlock, EngineInterface, PluginOptions } from 'claude-code'

import { admit } from './admit'
import type { Arrival } from './admit'
import { MAX_KEPT, placeholders, storePrompt, textOf, unread } from './list'
import { pictures } from './pictures'
import type { Work } from './pictures'
import { probe } from './session'

type $ = EngineInterface

/** Keeps the bytes a stored prompt carried: the pictures exactly as the model got them. */
async function keepPrompt(
  $: $,
  options: PluginOptions,
  work: Work,
  content: readonly ApiContentBlock[],
  where: { messageId?: string; idPrefix: string; stage: 'stored' | 'history' },
) {
  const blocks = content.filter(b => b.type === 'image')
  if (blocks.length === 0) return
  const text = textOf(content)
  const named = placeholders(text)

  // What isn't listed (a failed write or conversion, the cap, a list a /peek
  // clear or a switch got to first) goes when the work ends; an earlier,
  // listed copy of this row has the same names, so those stay.
  const arrivals: Arrival[] = []
  for (const [i, block] of blocks.entries()) {
    const source = block.source as { type?: string; media_type?: string; data?: string } | undefined
    if (source?.type !== 'base64' || typeof source.data !== 'string') continue
    const n = named[i] ?? i + 1
    const ext = (source.media_type ?? 'image/png').split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
    const id = `${where.idPrefix}-${n}`
    arrivals.push({ id, n, source: 'transcript', stage: where.stage, base64: source.data, ext, messageId: where.messageId, promptText: text })
  }
  const listed = await admit($, options, work, arrivals, (list, made) => storePrompt(list, made, { messageId: where.messageId, text, stage: where.stage }))
  void probe($, where.stage, { messageId: where.messageId, named, kept: listed.length, chars: text.length })
}

/** A resumed session's pictures, read back from the conversation; each user row by its place, so equal texts stay apart. */
export async function loadHistory($: $, options: PluginOptions, work: Work) {
  const messages = await $.session.messages({ as: 'api' })
  if ('deny' in messages) return
  const rows = messages
    .map((m, index) => ({ content: m.content, idPrefix: `hist-${index}`, isPrompt: m.role === 'user' }))
    .filter(row => row.isPrompt && row.content.some(b => b.type === 'image') && !row.content.some(b => b.type === 'tool_result'))
    .slice(-MAX_KEPT)
  for (const row of unread(await pictures($), rows)) {
    await keepPrompt($, options, work, row.content, { idPrefix: row.idPrefix, stage: 'history' })
  }
}

/** Keeps the pictures of a prompt just sent, from its stored row. */
export function keepSent($: $, options: PluginOptions, work: Work, content: readonly ApiContentBlock[], messageId: string) {
  return keepPrompt($, options, work, content, { messageId, idPrefix: messageId, stage: 'stored' })
}
