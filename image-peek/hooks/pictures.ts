// The session's pictures: the image list, the generation, and the files
// work makes for it (`finish` makes a picture's PNG and thumbnails). Work is
// had only through `later` or `run`, which end it: it names each file it
// makes here, in the session folder it finds and makes on first use, and
// when it ends, whatever no kept picture owns is deleted. A
// new generation (a session end, /clear, /resume, /peek clear) outlives the
// work begun before it: the work's own steps (`claim`, `finish`, `keep`)
// stop it before it changes the list, `later` and `run` end it quietly, and
// its files go.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { PeekImage } from '../types'
import { join, makeFolder, removeFiles, sessionFolder } from './folder'
import type { Folder } from './folder'
import { platform, pngSize } from './host'
import { capped } from './list'
import { probe } from './session'

type $ = EngineInterface

// Change the tag when PeekImage's fields change: values an earlier version
// stored outlive a reload, and are read as absent under another tag.
const images = atom({ plugin: 'image-peek', key: 'images' } as const, [], { shape: 'images-2' })

let generation = 0

/** Work of one generation, its session folder once asked for, and the files it made there. */
export type Work = { readonly born: number; folder?: Promise<Folder>; readonly files: Set<string> }

/** Work of the current generation. */
const begin = (): Work => ({ born: generation, files: new Set() })

/** False once a newer generation began: the work's next step stops it. */
export const isLive = (work: Work) => work.born === generation

/**
 * A value per generation: the work's, else the current one's. It is made
 * anew on the first ask once a newer generation began. Stale work never
 * gets a newer generation's value.
 */
export function perGeneration<T>(make: () => T): (work?: Work) => T {
  let held: { born: number; value: T } | undefined
  return (work = begin()) => {
    if (held?.born === work.born) return held.value
    if (!isLive(work)) return make()
    held = { born: work.born, value: make() }
    return held.value
  }
}

/** The current generation: every listed picture was made in it. */
export const generationNow = () => generation

/** What a step of stale work throws; `later` and `run` catch it and end the work. */
class Stale extends Error {}

/** Stops the work once a newer generation began. */
function stopIfStale(work: Work) {
  if (!isLive(work)) throw new Stale('stale work')
}

/**
 * The session folder the work makes its files in: found and made (its lease
 * renewed) on the first ask, and the same for the rest of the work, a
 * session switch or not.
 */
export function folder($: $, work: Work) {
  work.folder ??= makeFolder($)
  return work.folder
}

/**
 * A path in the work's folder for it to make; deleted when the work ends,
 * unless a kept picture owns it. Code that writes into the folder takes its
 * path from here: a file written past it is never deleted. Stale work stops here.
 */
export async function claim($: $, work: Work, name: string) {
  const path = join(await folder($, work), name)
  stopIfStale(work)
  work.files.add(path)
  return path
}

/** The image list. */
export async function pictures($: $) {
  return read($, images)
}

/**
 * Changes the list for the work, capped to the newest MAX_KEPT, and lets go
 * of the entries it drops (see `release`). Stale work stops here, the change
 * not made.
 */
export async function keep($: $, work: Work, change: (list: PeekImage[]) => PeekImage[]) {
  stopIfStale(work)
  let isKept = false
  let dropped: PeekImage[] = []
  await update($, images, list => {
    // Checked on every run: an update can run again after a /peek clear that
    // came in the meantime, and must not bring old pictures back.
    isKept = isLive(work)
    if (!isKept) {
      dropped = []
      return list
    }
    const next = capped(change([...list]))
    dropped = list.filter(img => !next.some(kept => kept.id === img.id))
    return next
  })
  await release($, dropped, 'delete')
  if (!isKept) throw new Stale('stale work')
}

/**
 * Lets go of pictures that left the list: with `files: 'delete'` every file
 * of theirs (each under its id, and its PNG by path).
 */
async function release($: $, dropped: readonly PeekImage[], files: 'delete' | 'leave') {
  if (files === 'leave' || dropped.length === 0) return
  await removeFiles($, await sessionFolder($), dropped.map(img => img.id), dropped.map(img => img.path))
}

/** Deletes the files the work made that no kept picture owns. */
async function end($: $, work: Work) {
  if (work.files.size === 0 || !work.folder) return
  const owned = new Set((await read($, images)).flatMap(img => [img.path, img.thumb, img.small]))
  const paths = [...work.files].filter(path => !owned.has(path))
  work.files.clear()
  await removeFiles($, await work.folder, [], paths)
}

/**
 * Begins a new generation with an empty list, and lets go of what it held.
 * `files: 'delete'` deletes their files; 'leave' when the folder goes whole.
 */
export async function reset($: $, files: 'delete' | 'leave') {
  generation++
  let dropped: PeekImage[] = []
  await update($, images, list => {
    dropped = list
    return []
  })
  await release($, dropped, files)
}

/**
 * Makes the PNG and its two thumbnails, and reads the thumbnail's size; a
 * step file the work made goes when it ends. Stale work stops here.
 */
export async function finish(
  $: $,
  work: Work,
  base: Pick<PeekImage, 'id' | 'n' | 'source' | 'messageId' | 'promptText'> & { file: string },
): Promise<PeekImage | undefined> {
  stopIfStale(work)
  const p = await platform($)
  let path = base.file
  if (!/\.png$/i.test(path)) {
    const png = await claim($, work, `${base.id}.png`)
    if (!(await p.toPng(path, png))) return undefined
    path = png
  }
  const thumb = await claim($, work, `${base.id}.thumb.png`)
  const shown = (await p.toPng(path, thumb, 800)) ? thumb : path
  const small = await claim($, work, `${base.id}.small.png`)
  const smallShown = (await p.toPng(shown, small, 400)) ? small : shown
  const { width, height } = await pngSize(p, shown)
  const { file: _file, ...rest } = base
  return { ...rest, path, thumb: shown, small: smallShown, width, height, addedAt: await $.clock.now() }
}

/**
 * Runs work after the hook that asked for it has answered: the reference puts
 * work that outlives a dispatch on `$.clock`, never on the dispatch itself.
 * The work is of the generation it was asked in: stale, it is not run, or
 * stops quietly at its next step. Once it ends, the files it made that no
 * kept picture owns are deleted.
 */
export function later($: $, label: string, job: (work: Work) => Promise<unknown>, ms = 0) {
  const work = begin()
  $.clock.after(ms, () => {
    if (!isLive(work)) return
    // The error's name only: its message may hold a file path.
    const failed = (error: unknown) =>
      error instanceof Stale ? undefined : probe($, `${label} failed`, error instanceof Error ? error.name : typeof error)
    job(work)
      .catch(failed)
      .then(() => end($, work))
      .catch(failed)
  })
  return work
}

/** Runs work of the current generation now, and ends it; undefined when it stopped stale. */
export async function run<T>($: $, job: (work: Work) => Promise<T>): Promise<T | undefined> {
  const work = begin()
  try {
    return await job(work)
  } catch (error) {
    if (error instanceof Stale) return undefined
    throw error
  } finally {
    await end($, work)
  }
}
