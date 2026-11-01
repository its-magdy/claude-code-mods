// Draft intake: the pictures behind the draft's "[Image #N]". The prompt
// hooks hand over each event and the box it left; which placeholders came,
// went or are missing, and where each picture comes from, is decided here.
// The file the same paste named, else the clipboard when it holds an image
// copied since the last grab, else a screenshot saved just now (a file
// dropped into the prompt reaches the engine unseen). A submit tags the
// draft's pictures with the prompt's text.

import type { EngineInterface, PluginOptions, PromptBox, PromptChangeInput, PromptEditInput, PromptSubmitInput } from 'claude-code'

import type { PeekSource } from '../types'
import { platform } from './host'
import type { Shot } from './host'
import { addDraft, dropDrafts, hasDraft, placeholders, submitDrafts } from './list'
import { offerPane } from './pane'
import { warm } from './picture'
import { claim, finish, folder, keep, later, perGeneration, pictures, run } from './pictures'
import type { Work } from './pictures'
import { probe } from './session'

type $ = EngineInterface

// Module state: rebuilt after a reload, and nothing drawn depends on it alone.
/** The clipboard's change counter at the last grab: unchanged means no new image was copied. */
let lastChange: number | undefined
let isDeniedTold = false

/** A paste names an image path for a placeholder the engine puts in within this long. */
const PATH_WINDOW_MS = 3_000

/** A screenshot saved this long ago or less may be the file a drop named. */
const SHOT_WINDOW_MS = 120_000

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i

const isImageFile = (path: string) => IMAGE_FILE.test(path)

/** What intake remembers for a generation's drafts; a new generation starts with none of it. */
const intake = perGeneration(() => ({
  /** Placeholders being captured, so a second capture of one stops. */
  inFlight: new Set<number>(),
  /** Image paths a paste named with no placeholder, for one the engine puts in a moment later. */
  recentPaths: [] as { path: string; at: number }[],
  /** Screenshots already taken for a draft, so a second placeholder gets the next one. */
  usedShots: new Set<string>(),
}))

let stamps = 0
/** A file-name stamp no other capture or copy shares, even in the same millisecond. */
async function uniqueStamp($: $) {
  return `${await $.clock.now()}-${++stamps}`
}

/**
 * A keystroke or paste, and the box it left: the placeholders it put in are
 * captured, from the files the paste named; image paths it named with no
 * placeholder yet are kept for one the engine puts in a moment later; the
 * drafts of placeholders it took out are dropped.
 */
export async function edited($: $, options: PluginOptions, e: PromptEditInput, box: PromptBox) {
  const before = placeholders(e.text)
  const after = placeholders(box.text)
  const paths = imagePaths(e.inputText)
  const added = after.filter(n => !before.includes(n))
  const isPaste = e.key === undefined && e.inputText.length > 1
  if (isPaste || added.length > 0 || paths.length > 0 || e.inputText.includes('[Image #')) {
    void probe($, 'prompt.edit', { chars: e.inputText.length, isKey: e.key !== undefined, added, paths: paths.length })
  }
  if (added.length > 0) {
    capture($, options, added, 'edit', paths)
  } else if (paths.length > 0) {
    const at = await $.clock.now()
    const memory = intake()
    memory.recentPaths = [...memory.recentPaths.filter(p => at - p.at < PATH_WINDOW_MS), ...paths.map(path => ({ path, at }))]
  }
  const removed = before.filter(n => !after.includes(n))
  if (removed.length > 0) {
    later($, 'prune', work => keep($, work, list => dropDrafts(list, n => removed.includes(n))))
  }
}

/**
 * The box changed with no edit (an engine insert, a plugin's fill): a
 * placeholder the edit never saw is captured, from the paths a paste named
 * in the last 3 s. A clear drops the drafts no placeholder names.
 */
export async function changed($: $, options: PluginOptions, e: PromptChangeInput) {
  const present = placeholders(e.text)
  if (e.origin.kind === 'clear') {
    later($, 'prune', work => keep($, work, list => dropDrafts(list, n => !present.includes(n))))
    return
  }
  if (present.length === 0 || e.origin.kind === 'history') return
  void probe($, 'prompt.change', { origin: e.origin.kind, present })
  const list = await pictures($)
  const missing = present.filter(n => !hasDraft(list, n))
  if (missing.length === 0) return
  const at = await $.clock.now()
  const paths = intake().recentPaths.splice(0).filter(p => at - p.at < PATH_WINDOW_MS).map(p => p.path)
  capture($, options, missing, `change:${e.origin.kind}`, paths)
}

/** A prompt sent with pictures: the draft's are submitted, tagged with its text, so its row finds them before the stored bytes arrive. */
export async function submitted($: $, e: PromptSubmitInput) {
  const attached = e.attachments?.filter(a => a.type === 'image') ?? []
  if (attached.length === 0 && !e.text.includes('[Image #')) return
  void probe($, 'prompt.submit', { chars: e.text.length, attachments: attached.map(a => a.mediaType) })
  await run($, work => keep($, work, list => submitDrafts(list, e.text)))
}

/**
 * Captures the pictures behind the draft's new placeholders `ns`, from the
 * image files `paths` at their places, after the hook that asked has answered.
 */
function capture($: $, options: PluginOptions, ns: number[], via: string, paths: string[]) {
  // Copied first thing after the edit, before macOS can delete a
  // screenshot's temporary file; on the clock, not on this dispatch.
  later($, 'capture', async work => captureDraft($, options, work, ns, via, paths.length > 0 ? await copyDropped($, work, paths) : []))
}

/** Copies files a drop or paste named, at once: macOS deletes a screenshot thumbnail's temporary file soon after. */
async function copyDropped($: $, work: Work, paths: string[]) {
  const p = await platform($)
  const home = (await $.env.get('HOME')) ?? ''
  const copies: string[] = []
  for (const [i, path] of paths.entries()) {
    const from = await p.localPath(path.startsWith('~/') ? home + path.slice(1) : path)
    const ext = from.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '.png'
    const copy = await claim($, work, `drop-${await uniqueStamp($)}-${i}${ext}`)
    if (await p.copyFile(from, copy)) copies.push(copy)
  }
  return copies
}

/**
 * Saves the picture behind each placeholder of `ns`: from the copy in
 * `files` at its place, else wherever `pickSource` finds one. `files` are
 * copies the work made; what no kept picture takes goes when the work ends.
 */
async function captureDraft($: $, options: PluginOptions, work: Work, ns: number[], via: string, files: string[]) {
  // The session folder is made even when every placeholder is skipped.
  await folder($, work)
  const { inFlight } = intake(work)
  for (const [i, n] of ns.entries()) {
    // Claimed before any wait, so a second capture of this number stops here.
    if (inFlight.has(n)) continue
    inFlight.add(n)
    try {
      const id = `draft-${n}-${await uniqueStamp($)}`
      if (hasDraft(await pictures($), n)) continue
      const picked = await pickSource($, work, n, id, via, files[i])
      if (!picked) {
        $.ui.toast(`Image #${n}: it will show once sent.`)
        continue
      }
      const entry = await finish($, work, { id, n, stage: 'draft', ...picked })
      if (!entry) continue
      // The draft may have been sent or edited while the picture was made.
      if (!(await $.prompt.read()).text.includes(`[Image #${n}]`)) continue
      await keep($, work, list => addDraft(list, entry))
      await warm($, options, entry)
      await offerPane($, options)
    } finally {
      inFlight.delete(n)
    }
  }
}

/**
 * Where the picture behind placeholder `n` (draft `id`) comes from, in this
 * order: `file`, the copy the paste named; the clipboard's image file or
 * image, when copied since the last grab; a screenshot saved in the last two
 * minutes that no other placeholder took; the clipboard's image or image
 * file even if not new. Nothing when none has one.
 */
async function pickSource(
  $: $,
  work: Work,
  n: number,
  id: string,
  via: string,
  file: string | undefined,
): Promise<{ file: string; source: PeekSource } | undefined> {
  if (file) return { file, source: 'file' }
  const p = await platform($)
  const out = await claim($, work, `${id}.png`)
  const { usedShots } = intake(work)
  const grab = await p.grabClipboard(out)
  const isStale = grab.change !== undefined && grab.change === lastChange
  void probe($, 'clipboard', { n, via, isStale, ...grab, file: grab.file !== undefined })
  if (grab.change !== undefined) lastChange = grab.change
  const imageFile = grab.file && isImageFile(grab.file) ? grab.file : undefined
  if (!isStale && imageFile) return copied($, work, imageFile)
  if (!isStale && grab.isSaved) return { file: out, source: 'clipboard' }
  // No new image on the clipboard: either a file was dropped (the engine
  // turned its path into the placeholder unseen), likely a screenshot saved
  // in the last two minutes, or the same clipboard image was pasted again.
  // A guess either way: the sent bytes replace it.
  const { files: shots, isDenied } = await p.screenshots()
  const shot = newestShot(shots, await $.clock.now(), usedShots)
  void probe($, 'screenshot', { n, isFound: shot !== undefined, isDenied })
  if (shot) {
    usedShots.add(shot)
    return copied($, work, shot)
  }
  if (grab.isSaved) return { file: out, source: 'clipboard' }
  if (imageFile) return copied($, work, imageFile)
  if (isDenied && !isDeniedTold) {
    isDeniedTold = true
    $.ui.toast('image-peek: macOS hides dropped screenshots until sent. Paste with Ctrl+V, or give your terminal Full Disk Access.')
  }
  return undefined
}

/** `path` copied into the work's folder as a file-sourced picture, or nothing if the copy failed. */
async function copied($: $, work: Work, path: string) {
  const [copy] = await copyDropped($, work, [path])
  return copy === undefined ? undefined : { file: copy, source: 'file' as const }
}

/**
 * The newest image among the screenshot folders' `files` saved in the last
 * two minutes that no other placeholder took (`skip`). A file dropped into
 * the prompt reaches the engine without passing `prompt.edit`, so this is
 * how the draft finds it.
 */
function newestShot(files: readonly Shot[], now: number, skip: ReadonlySet<string>) {
  let best: Shot | undefined
  for (const f of files) {
    if (!isImageFile(f.path) || skip.has(f.path) || now - f.mtimeMs > SHOT_WINDOW_MS) continue
    if (!best || f.mtimeMs > best.mtimeMs) best = f
  }
  return best?.path
}

/**
 * The image files a paste names: paths as a terminal types them for a drop
 * (`/a/b\ c.png`, `'/a/b c.png'`, `file:///a/b%20c.png`), one or several.
 */
export function imagePaths(text: string): string[] {
  // Split on ASCII whitespace only: macOS names a screenshot "… at 8.31.06\u202fPM.png",
  // and that narrow no-break space is whitespace to `\s`.
  const tokens = text.trim().match(/'[^']+'|"[^"]+"|(?:\\.|[^ \t\r\n\\])+/g) ?? []
  return tokens
    .map(token => {
      // A Windows path keeps its backslashes; elsewhere they escape a space.
      const bare = /^['"]/.test(token)
        ? token.slice(1, -1)
        : /^[A-Za-z]:\\/.test(token)
          ? token
          : token.replace(/\\(.)/g, '$1')
      return bare.startsWith('file://') ? decodeURIComponent(bare.slice('file://'.length)) : bare
    })
    .filter(path => /^(\/|~\/|[A-Za-z]:\\)/.test(path) && isImageFile(path))
}
