// Admitting pictures: the one step by which intake (a draft's capture, a
// stored prompt's bytes) turns what it found into listed pictures. Each
// arrival is written to its source file if it came as bytes, made into a PNG
// and thumbnails, and the made ones are put in the list in one change,
// capped to the newest MAX_KEPT. What got listed is warmed (its cells made
// ahead) and handed back; what didn't goes when the work ends.

import type { EngineInterface, PluginOptions } from 'claude-code'

import type { PeekImage } from '../types'
import { platform } from './host'
import { warm } from './picture'
import { fileFor, finish, keep } from './pictures'
import type { Work } from './pictures'

type $ = EngineInterface

/** A picture intake found: its fields, and the file it is in or the base64 bytes it came as. */
export type Arrival = Pick<PeekImage, 'id' | 'n' | 'source' | 'stage' | 'messageId' | 'promptText'> &
  ({ file: string } | { base64: string; ext: string })

/**
 * Admits the arrivals: writes and makes each, then lists the made ones with
 * `place` (the list change that puts them in), capped, and warms those
 * listed. Nothing is listed when none was made, or when `isWanted`, asked
 * once they are made, says no. Resolves to the pictures that got listed.
 * Stale work stops at its next step.
 */
export async function admit(
  $: $,
  options: PluginOptions,
  work: Work,
  arrivals: readonly Arrival[],
  place: (list: readonly PeekImage[], made: readonly PeekImage[]) => PeekImage[],
  isWanted?: () => Promise<boolean>,
): Promise<PeekImage[]> {
  const made: PeekImage[] = []
  for (const arrival of arrivals) {
    const entry = await make($, work, arrival)
    if (entry) made.push(entry)
  }
  if (made.length === 0 || (isWanted && !(await isWanted()))) return []
  const list = await keep($, work, current => place(current, made))
  // The cap may have left out the oldest of these; only listed pictures get cells.
  const listed = made.filter(img => list.some(entry => entry.id === img.id))
  for (const img of listed) await warm($, options, img)
  return listed
}

/** One arrival made: written to its source file when it came as bytes, then its PNG and thumbnails. */
async function make($: $, work: Work, arrival: Arrival) {
  if ('file' in arrival) return finish($, work, arrival)
  const { base64, ext, ...base } = arrival
  const file = await fileFor($, work, { role: 'source', id: base.id, ext })
  if (!(await (await platform($)).writeBase64(base64, file))) return undefined
  return finish($, work, { ...base, file })
}
