// Draft intake: the pictures behind the draft's "[Image #N]". The prompt
// hooks hand over each event and the box it left; which placeholders came,
// went or are missing, and where each picture comes from, is decided here.
// The file the same paste named, else the clipboard when it holds an image
// copied since the last grab, else a screenshot saved just now (a file
// dropped into the prompt reaches the engine unseen). A submit tags the
// draft's pictures with the prompt's text.

import type { EngineInterface, PluginOptions, PromptBox, PromptChangeInput, PromptEditInput, PromptSubmitInput } from 'claude-code'

import type { PeekSource } from '../types'
import { copyFile, ensureDir, grabClipboard, host, imagePaths, isImageFile, linuxPath, recentScreenshot } from './host'
import { addDraft, dropDrafts, hasDraft, placeholders, tagDrafts } from './list'
import { warm } from './picture'
import { claim, finish, isLive, keep, later, pictures, run } from './pictures'
import type { Work } from './pictures'
import { PANE, isFullscreen, probe } from './session'

type $ = EngineInterface

// Module state: rebuilt after a reload, and nothing drawn depends on it alone.
/** The clipboard's change counter at the last grab: unchanged means no new image was copied. */
let lastChange: number | undefined
const inFlight = new Set<number>()
/** Image paths a paste named with no placeholder, for one the engine puts in a moment later. */
const recentPaths: { path: string; at: number }[] = []
/** Screenshots already taken for a draft, so a second placeholder gets the next one. */
const usedShots = new Set<string>()
let isDeniedTold = false
let isPaneOffered = false

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
    recentPaths.push(...paths.map(path => ({ path, at })))
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
  const paths = recentPaths.splice(0).filter(p => at - p.at < 3_000).map(p => p.path)
  capture($, options, missing, `change:${e.origin.kind}`, paths)
}

/** A prompt sent with pictures: the draft's are tagged with its text, so its row finds them before the stored bytes arrive. */
export async function submitted($: $, e: PromptSubmitInput) {
  const attached = e.attachments?.filter(a => a.type === 'image') ?? []
  if (attached.length === 0 && !e.text.includes('[Image #')) return
  void probe($, 'prompt.submit', { chars: e.text.length, attachments: attached.map(a => a.mediaType) })
  await run($, work => keep($, work, list => tagDrafts(list, e.text)))
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

/** Lets the next pasted picture open the pane again (a new session, after /clear or /resume). */
export function offerPaneAgain() {
  isPaneOffered = false
}

/** Copies files a drop or paste named, at once: macOS deletes a screenshot thumbnail's temporary file soon after. */
async function copyDropped($: $, work: Work, paths: string[]) {
  const h = await host($)
  await ensureDir($, h)
  const home = (await $.env.get('HOME')) ?? ''
  const copies: string[] = []
  for (const [i, path] of paths.entries()) {
    const from = await linuxPath($, h, path.startsWith('~/') ? home + path.slice(1) : path)
    const ext = from.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '.png'
    const copy = claim(work, h, `drop-${await uniqueStamp($)}-${i}${ext}`)
    if (await copyFile($, h, from, copy)) copies.push(copy)
  }
  return copies
}

/**
 * Saves the picture behind each placeholder of `ns`: from the copy in
 * `files` at its place, else the clipboard or a recent screenshot. `files`
 * are copies the work made; what no kept picture takes goes when the work ends.
 */
async function captureDraft($: $, options: PluginOptions, work: Work, ns: number[], via: string, files: string[]) {
  if (!isLive(work)) return
  const h = await host($)
  await ensureDir($, h)
  for (const [i, n] of ns.entries()) {
    // Claimed before any wait, so a second capture of this number stops here.
    if (inFlight.has(n)) continue
    inFlight.add(n)
    try {
      const id = `draft-${n}-${await uniqueStamp($)}`
      if (hasDraft(await pictures($), n)) continue
      let file = files[i]
      let source: PeekSource = 'file'
      if (!file) {
        source = 'clipboard'
        const out = claim(work, h, `${id}.png`)
        const grab = await grabClipboard($, h, out)
        const isStale = grab.change !== undefined && grab.change === lastChange
        void probe($, 'clipboard', { n, via, isStale, ...grab, file: grab.file !== undefined })
        if (grab.change !== undefined) lastChange = grab.change
        if (!isStale && grab.file && isImageFile(grab.file)) {
          const [copy] = await copyDropped($, work, [grab.file])
          file = copy
          source = 'file'
        } else if (!isStale && grab.isSaved) {
          file = out
        } else {
          // No new image on the clipboard: either a file was dropped (the
          // engine turned its path into the placeholder unseen), likely a
          // screenshot saved in the last two minutes, or the same clipboard
          // image was pasted again. A guess either way: the sent bytes replace it.
          const { path: shot, isDenied } = await recentScreenshot($, h, 120_000, usedShots)
          void probe($, 'screenshot', { n, isFound: shot !== undefined, isDenied })
          if (shot) {
            usedShots.add(shot)
            const [copy] = await copyDropped($, work, [shot])
            file = copy
            source = 'file'
          } else if (grab.isSaved) {
            file = out
          } else if (grab.file && isImageFile(grab.file)) {
            const [copy] = await copyDropped($, work, [grab.file])
            file = copy
            source = 'file'
          } else if (isDenied && !isDeniedTold) {
            isDeniedTold = true
            $.ui.toast('image-peek: macOS hides dropped screenshots until sent. Paste with Ctrl+V, or give your terminal Full Disk Access.')
          }
        }
      }
      if (!file) {
        $.ui.toast(`Image #${n}: it will show once sent.`)
        continue
      }
      const entry = isLive(work) ? await finish($, work, h, { id, n, source, file }) : undefined
      if (!entry) continue
      // The draft may have been sent or edited while the picture was made.
      if (!isLive(work) || !(await $.prompt.read()).text.includes(`[Image #${n}]`)) continue
      if (!(await keep($, work, list => addDraft(list, entry)))) continue
      await warm($, options, entry)
      if (options.autoOpenPane === true && isFullscreen() && !isPaneOffered) {
        isPaneOffered = true
        await $.ui.open({ id: PANE, title: 'Images' })
      }
    } finally {
      inFlight.delete(n)
    }
  }
}
