// What the session's hooks share: work scheduled for later, the layout the
// last drawing saw, and the debug lines.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderViewport } from 'claude-code'

import { begin, end, isLive } from './pictures'
import type { Work } from './pictures'

type $ = EngineInterface

/** The Images pane's id. */
export const PANE = 'image-peek'

// The engine's scan reads an atom only where it is declared: a file that reads
// or writes one declares it.
const isDebug = atom({ plugin: 'image-peek', key: 'isDebug' } as const, false)

// Module state: rebuilt after a reload, and nothing drawn depends on it alone.
let isFullscreenSeen: boolean | undefined

/** Keeps the layout a drawing reports; the mouse and iTerm2's bytes need the fullscreen one. */
export function noteViewport(viewport: RenderViewport | undefined) {
  if (viewport?.isFullscreen !== undefined) isFullscreenSeen = viewport.isFullscreen
}
export const isFullscreen = () => isFullscreenSeen === true

/** Whether probe lines go to the transcript (`/peek debug`) rather than the debug log. */
export function isDebugOn($: $) {
  return read($, isDebug)
}

/** Flips where probe lines go; true when they now go to the transcript. */
export async function toggleDebug($: $) {
  const isOn = !(await read($, isDebug))
  await update($, isDebug, () => isOn)
  return isOn
}

export async function probe($: $, label: string, data: unknown) {
  const isOn = await read($, isDebug)
  $.ui.log(`[image-peek] ${label} ${JSON.stringify(data)}`, { to: isOn ? 'transcript' : 'debug' })
}

/**
 * Runs work after the hook that asked for it has answered: the reference puts
 * work that outlives a dispatch on `$.clock`, never on the dispatch itself.
 * The work is of the generation it was asked in (see `begin`); once it ends,
 * the files it made that no kept picture owns are deleted.
 */
export function later($: $, label: string, job: (work: Work) => Promise<unknown>, ms = 0) {
  const work = begin()
  $.clock.after(ms, () => {
    if (!isLive(work)) return
    // The error's name only: its message may hold a file path.
    const failed = (error: unknown) => probe($, `${label} failed`, error instanceof Error ? error.name : typeof error)
    job(work)
      .catch(failed)
      .then(() => end($, work))
      .catch(failed)
  })
  return work
}
