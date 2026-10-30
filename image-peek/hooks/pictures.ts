// The session's pictures: the image list, the generation, and the files
// work makes for it (`finish` makes a picture's PNG and thumbnails). Work is
// had only through `later` or `run`, which end it: it names each file it
// makes here, in the session folder it finds and makes on first use, and
// when it ends, whatever no kept picture owns is deleted. A
// new generation (a session end, /clear, /resume, /peek clear) outlives the
// work begun before it: that work stops before it changes the list, and its
// files go when it ends.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { PeekImage } from '../types'
import { host, join, makeFolder, removeFiles } from './folder'
import { pngSize, toPng } from './host'
import type { Host } from './host'
import { capped } from './list'
import { forget } from './picture'
import { probe } from './session'

type $ = EngineInterface

// Change the tag when PeekImage's fields change: values an earlier version
// stored outlive a reload, and are read as absent under another tag.
const images = atom({ plugin: 'image-peek', key: 'images' } as const, [], { shape: 'images-2' })

let generation = 0

/** Work of one generation, its session folder once asked for, and the files it made there. */
export type Work = { readonly born: number; folder?: Promise<Host>; readonly files: Set<string> }

/** A path's last part: the name `removeFiles` matches. */
const fileName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/** Work of the current generation. */
const begin = (): Work => ({ born: generation, files: new Set() })

/** False once a newer generation began: the work should stop. */
export const isLive = (work: Work) => work.born === generation

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
 * path from here: a file written past it is never deleted.
 */
export async function claim($: $, work: Work, name: string) {
  const path = join(await folder($, work), name)
  work.files.add(path)
  return path
}

/** The image list. */
export async function pictures($: $) {
  return read($, images)
}

/**
 * Changes the list for the work, capped to the newest MAX_KEPT, and lets go
 * of the entries it drops (see `release`). False when a newer generation came
 * first: the change was not made.
 */
export async function keep($: $, work: Work, change: (list: PeekImage[]) => PeekImage[]) {
  if (!isLive(work)) return false
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
  return isKept
}

/**
 * Lets go of pictures that left the list: what was kept to draw them, and
 * with `files: 'delete'` every file of theirs (each under its id, and its PNG
 * by name).
 */
async function release($: $, dropped: readonly PeekImage[], files: 'delete' | 'leave') {
  for (const img of dropped) forget(img)
  if (files === 'leave' || dropped.length === 0) return
  await removeFiles($, await host($), dropped.map(img => img.id), dropped.map(img => fileName(img.path)))
}

/** Deletes the files the work made that no kept picture owns. */
async function end($: $, work: Work) {
  if (work.files.size === 0 || !work.folder) return
  const owned = new Set((await read($, images)).flatMap(img => [img.path, img.thumb, img.small]))
  const names = [...work.files].filter(path => !owned.has(path)).map(fileName)
  work.files.clear()
  await removeFiles($, await work.folder, [], names)
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

/** Makes the PNG and its two thumbnails, and reads the thumbnail's size; a step file the work made goes when it ends. */
export async function finish(
  $: $,
  work: Work,
  base: Pick<PeekImage, 'id' | 'n' | 'source' | 'messageId' | 'promptText'> & { file: string },
): Promise<PeekImage | undefined> {
  const h = await folder($, work)
  let path = base.file
  if (!/\.png$/i.test(path)) {
    const png = await claim($, work, `${base.id}.png`)
    if (!(await toPng($, h, path, png))) return undefined
    path = png
  }
  const thumb = await claim($, work, `${base.id}.thumb.png`)
  const shown = (await toPng($, h, path, thumb, 800)) ? thumb : path
  const small = await claim($, work, `${base.id}.small.png`)
  const smallShown = (await toPng($, h, shown, small, 400)) ? small : shown
  const { width, height } = await pngSize($, shown)
  const { file: _file, ...rest } = base
  return { ...rest, path, thumb: shown, small: smallShown, width, height, addedAt: await $.clock.now() }
}

/**
 * Runs work after the hook that asked for it has answered: the reference puts
 * work that outlives a dispatch on `$.clock`, never on the dispatch itself.
 * The work is of the generation it was asked in; once it ends, the files it
 * made that no kept picture owns are deleted.
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

/** Runs work of the current generation now, and ends it. */
export async function run<T>($: $, job: (work: Work) => Promise<T>) {
  const work = begin()
  try {
    return await job(work)
  } finally {
    await end($, work)
  }
}
