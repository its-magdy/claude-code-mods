// What the session's hooks share: the generation that work scheduled for
// later checks, the layout the last drawing saw, and the debug lines.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderViewport } from 'claude-code'

type $ = EngineInterface

// The engine's scan reads an atom only where it is declared: a file that reads
// or writes one declares it.
const isDebug = atom({ plugin: 'image-peek', key: 'isDebug' } as const, false)

// Module state: rebuilt after a reload, and nothing drawn depends on it alone.
/**
 * Bumped when the session's pictures are dropped (a session end, /clear,
 * /resume, /peek clear): work scheduled before then finds it moved and stops
 * before it writes a file or the list.
 */
let current = 0
let isFullscreenSeen: boolean | undefined

export const generation = () => current
export function nextGeneration() {
  current++
}

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
 */
export function later($: $, label: string, work: (born: number) => Promise<unknown>, ms = 0) {
  const born = current
  $.clock.after(ms, () => {
    if (born !== current) return
    // The error's name only: its message may hold a file path.
    work(born).catch(error => probe($, `${label} failed`, error instanceof Error ? error.name : typeof error))
  })
}
