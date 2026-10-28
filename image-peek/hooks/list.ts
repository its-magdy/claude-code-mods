// The image list: which pictures the session holds and where each belongs.
// A picture starts as a draft (in the prompt), is tagged with the prompt's
// text when it is submitted, and is replaced by the stored bytes once the
// prompt's row is written; a resumed session's are read back as history.
// Every hook asks here, so draft, sent and "this row's" mean one thing.

import type { ApiContentBlock } from 'claude-code'

import type { PeekImage } from '../types'

export const MAX_KEPT = 40
/** Sent pictures the band and the pane hold at most. */
const SHOWN_SENT = 12
const PLACEHOLDER = /\[Image #(\d+)\]/g

/** The numbers of the "[Image #N]" in a text, each once. */
export const placeholders = (text: string) => [...new Set([...text.matchAll(PLACEHOLDER)].map(m => Number(m[1])))]

/** A prompt's words as the person typed them: the engine's hidden reminders out, spaces folded. */
const promptWords = (text: string) =>
  text
    // Engine blocks: `<system-reminder>`, and a slash command's record
    // (`<command-name>`, `<local-command-stdout>`, …) that a resumed
    // conversation merges into the next prompt's row.
    .replace(/<([a-z][a-z0-9_-]*)>[\s\S]*?<\/\1>/g, ' ')
    // The engine notes a dropped file's path beside its placeholder in the stored row.
    .replace(/\[Image: source: [^\]\n]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const sameText = (a: string, b: string) => promptWords(a) === promptWords(b)

/** A stored prompt's words, from its content blocks. */
export const textOf = (content: readonly ApiContentBlock[]) =>
  promptWords(
    content
      .filter(b => b.type === 'text')
      .map(b => String(b.text ?? ''))
      .join('\n'),
  )

/**
 * Whether a transcript row is the stored row: the row's id is the stored
 * uuid with its last group zeroed (`…-8c48-000000000000`), or the uuid itself.
 */
const sameRow = (requestId: string, messageId: string | undefined) =>
  messageId !== undefined &&
  (requestId === messageId || (/-0{12}$/.test(requestId) && requestId.slice(0, 24) === messageId.slice(0, 24)))

const isDraft = (img: PeekImage) => img.messageId === undefined && img.promptText === undefined
/** Tagged at submit, its stored bytes not in yet. */
const isSubmitted = (img: PeekImage) => img.messageId === undefined && img.source !== 'history' && img.promptText !== undefined

/** The draft's pictures, by number. */
export const drafts = (list: readonly PeekImage[]) => list.filter(isDraft).sort((a, b) => a.n - b.n)

/** The newest pictures that left the prompt: submitted, sent or read back. */
export const sent = (list: readonly PeekImage[]) =>
  list
    .filter(img => !isDraft(img))
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, SHOWN_SENT)

export const hasDraft = (list: readonly PeekImage[], n: number) => list.some(img => isDraft(img) && img.n === n)

/** The newest picture numbered `n`, wherever it is. */
export const latest = (list: readonly PeekImage[], n: number) =>
  list.filter(img => img.n === n).sort((a, b) => b.addedAt - a.addedAt)[0]

/** A transcript row's pictures, one per number: by the row's id, else by its text (equal texts share their newest). */
export function forRow(list: readonly PeekImage[], requestId: string, text: string) {
  const byId = list.filter(img => sameRow(requestId, img.messageId))
  const byText = list.filter(img => img.promptText !== undefined && sameText(img.promptText, text))
  const mine = (byId.length > 0 ? byId : byText).sort((a, b) => a.addedAt - b.addedAt)
  return [...new Map(mine.map(img => [img.n, img])).values()].sort((a, b) => a.n - b.n)
}

/** The newest MAX_KEPT, oldest first. */
export const capped = (list: PeekImage[]) => list.sort((a, b) => a.addedAt - b.addedAt).slice(-MAX_KEPT)

/** A draft's picture, in place of an earlier one of its number. */
export const addDraft = (list: readonly PeekImage[], entry: PeekImage) => [
  ...list.filter(img => !(isDraft(img) && img.n === entry.n)),
  entry,
]

/** Drops the drafts whose number `isGone` accepts. */
export const dropDrafts = (list: readonly PeekImage[], isGone: (n: number) => boolean) =>
  list.filter(img => !(isDraft(img) && isGone(img.n)))

/** Tags the drafts a submitted prompt names (all of them when it names none) with its text. */
export function tagDrafts(list: readonly PeekImage[], text: string) {
  const named = placeholders(text)
  return list.map(img => (isDraft(img) && (named.length === 0 || named.includes(img.n)) ? { ...img, promptText: text } : img))
}

/**
 * Puts a stored prompt's pictures in place of what the draft held for it
 * (tagged with its text at submit) and any earlier copy of its row; a draft
 * of the next prompt stays.
 */
export function storePrompt(list: readonly PeekImage[], kept: readonly PeekImage[], row: { messageId?: string; text: string }) {
  return [
    ...list.filter(img => {
      if (row.messageId !== undefined && img.messageId === row.messageId) return false
      return !(isSubmitted(img) && sameText(img.promptText!, row.text))
    }),
    ...kept,
  ]
}

/**
 * The rows of a resumed conversation still to read back: not read on an
 * earlier load, nor kept when sent here. The n-th row of a text is known
 * once n rows of that text were sent here.
 */
export function unread<R extends { idPrefix: string; content: readonly ApiContentBlock[] }>(list: readonly PeekImage[], rows: readonly R[]) {
  const seen = new Map<string, number>()
  return rows.filter(row => {
    const text = textOf(row.content)
    const occurrence = seen.get(text) ?? 0
    seen.set(text, occurrence + 1)
    if (list.some(img => img.id.startsWith(`${row.idPrefix}-`))) return false
    const sentRows = new Set(
      list.filter(img => img.source === 'sent' && img.promptText !== undefined && sameText(img.promptText, text)).map(img => img.messageId),
    )
    return sentRows.size <= occurrence
  })
}
