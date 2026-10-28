// Draft capture: where the picture behind a new "[Image #N]" in the draft
// comes from. The file the same paste named, else the clipboard when it holds
// an image copied since the last grab, else a screenshot saved just now (a
// file dropped into the prompt reaches the engine unseen). The prompt hooks
// hand over the placeholders; what to read, and when, is decided here.

import type { EngineInterface, PluginOptions } from 'claude-code'

import type { PeekImage, PeekSource } from '../types'
import { copyFile, ensureDir, grabClipboard, host, isImageFile, linuxPath, recentScreenshot } from './host'
import { addDraft, hasDraft } from './list'
import { forget, warm } from './picture'
import { claim, finish, isLive, keep, later, pictures } from './pictures'
import type { Work } from './pictures'
import { PANE, isFullscreen, probe } from './session'

type $ = EngineInterface

// Module state: rebuilt after a reload, and nothing drawn depends on it alone.
/** The clipboard's change counter at the last grab: unchanged means no new image was copied. */
let lastChange: number | undefined
const inFlight = new Set<number>()
/** Image paths a paste named, for a placeholder the engine puts in a moment later. */
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
 * Captures the pictures behind the draft's new placeholders `ns`, after the
 * hook that asked has answered. `paths` are the image files the same paste
 * named; left out, those a paste named in the last 3 s (see `notePaths`).
 */
export async function capture($: $, options: PluginOptions, ns: number[], via: string, paths?: string[]) {
  let named = paths
  if (!named) {
    const at = await $.clock.now()
    named = recentPaths.splice(0).filter(p => at - p.at < 3_000).map(p => p.path)
  }
  const files = named
  // Copied first thing after the edit, before macOS can delete a
  // screenshot's temporary file; on the clock, not on this dispatch.
  later($, 'capture', async work => captureDraft($, options, work, ns, via, files.length > 0 ? await copyDropped($, work, files) : []))
}

/** Keeps the image paths a paste named with no placeholder yet, for one the engine puts in a moment later. */
export async function notePaths($: $, paths: string[]) {
  const at = await $.clock.now()
  recentPaths.push(...paths.map(path => ({ path, at })))
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

/** Adds a draft's picture to the list for the work, and lets go of what it drops; false when it was not made. */
async function addToList($: $, work: Work, entry: PeekImage) {
  const { isKept, dropped } = await keep($, work, list => addDraft(list, entry))
  for (const img of dropped) forget(img)
  return isKept
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
      if (!(await addToList($, work, entry))) continue
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
