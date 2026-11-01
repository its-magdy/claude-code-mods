// What the session's hooks share: the terminal's layout, and the debug lines.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderSurface, RenderViewport } from 'claude-code'

type $ = EngineInterface

// The engine's scan reads an atom only where it is declared: a file that reads
// or writes one declares it.
const isDebug = atom({ plugin: 'image-peek', key: 'isDebug' } as const, false)

// Module state: rebuilt after a reload, and nothing drawn depends on it alone.
let isFullscreenSeen: boolean | undefined

/**
 * Keeps the terminal's layout from one of its drawings: every terminal
 * drawing reports it, and it holds for the session. A remote surface's
 * drawing reports its own (the mobile app's is never fullscreen), so it is
 * not kept: the mouse, iTerm2's bytes and a pane opened unasked go by the
 * terminal's.
 */
export function noteLayout(e: { surface: RenderSurface; viewport?: RenderViewport }) {
  if (e.surface === 'terminal' && e.viewport?.isFullscreen !== undefined) isFullscreenSeen = e.viewport.isFullscreen
}

/** Whether the terminal shows the fullscreen layout; false until one of its drawings said. */
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

