// The session's pictures: the image list, the generation, and the files
// work makes for it (`finish` makes a picture's PNG and thumbnails). Work is
// had only through `later` or `run`, which end it: it names each file it
// makes here, and when it ends, whatever no kept picture owns is deleted. A
// new generation (a session end, /clear, /resume, /peek clear) outlives the
// work begun before it: that work stops before it changes the list, and its
// files go when it ends.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { PeekImage } from '../types'
import { host, join, pngSize, removeFiles, toPng } from './host'
import type { Host } from './host'
import { capped } from './list'
import { forget } from './picture'
import { probe } from './session'

type $ = EngineInterface

// Change the tag when PeekImage's fields change: values an earlier version
// stored outlive a reload, and are read as absent under another tag.
const images = atom({ plugin: 'image-peek', key: 'images' } as const, [], { shape: 'images-2' })

let generation = 0

/** Work of one generation, and the files it made. */
export type Work = { readonly born: number; readonly files: Map<string, Host> }

/** A path's last part: the name `removeFiles` matches. */
const fileName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/** Work of the current generation. */
const begin = (): Work => ({ born: generation, files: new Map() })

/** False once a newer generation began: the work should stop. */
export const isLive = (work: Work) => work.born === generation

/**
 * A path in the session's folder for the work to make; deleted when the work
 * ends, unless a kept picture owns it. Code that writes into the folder takes
 * its path from here: a file written past it is never deleted.
 */
export function claim(work: Work, h: Host, name: string) {
  const path = join(h, name)
  work.files.set(path, h)
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
  if (work.files.size === 0) return
  const owned = new Set((await read($, images)).flatMap(img => [img.path, img.thumb, img.small]))
  const byDir = new Map<string, { h: Host; names: string[] }>()
  for (const [path, h] of work.files) {
    if (owned.has(path)) continue
    const group = byDir.get(h.dir) ?? { h, names: [] }
    group.names.push(fileName(path))
    byDir.set(h.dir, group)
  }
  work.files.clear()
  for (const { h, names } of byDir.values()) await removeFiles($, h, [], names)
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
  h: Host,
  base: Pick<PeekImage, 'id' | 'n' | 'source' | 'messageId' | 'promptText'> & { file: string },
): Promise<PeekImage | undefined> {
  let path = base.file
  if (!/\.png$/i.test(path)) {
    const png = claim(work, h, `${base.id}.png`)
    if (!(await toPng($, h, path, png))) return undefined
    path = png
  }
  const thumb = claim(work, h, `${base.id}.thumb.png`)
  const shown = (await toPng($, h, path, thumb, 800)) ? thumb : path
  const small = claim(work, h, `${base.id}.small.png`)
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
