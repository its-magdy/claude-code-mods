// What the session's hooks share: the layout the last drawing saw, and the
// debug lines.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderViewport } from 'claude-code'

type $ = EngineInterface

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

