// The session's pictures: the image list, the generation, and each
// picture's files. Every file of a picture's is named here, by its role (the
// bytes it came as, a copy of a dropped file, its PNG and thumbnails, a BMP
// its cells are read from), in the session folder the work finds and makes
// on first use. A listed picture owns its PNG and thumbnails; they go when it
// leaves the list. Work is had only through `later` or `run`, which end it:
// whatever it made that no kept picture owns is deleted then. A
// new generation (a session end, /clear, /resume, /peek clear) outlives the
// work begun before it: the work's own steps (`fileFor`, `finish`, `keep`)
// stop it before it changes the list, `later` and `run` end it quietly, and
// its files go.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { PeekImage } from '../types'
import { join, makeFolder } from './folder'
import type { Folder } from './folder'
import { platform } from './host'
import type { Platform } from './host'
import { capped } from './list'
import { probe } from './session'

type $ = EngineInterface

// Change the tag when PeekImage's fields change: values an earlier version
// stored outlive a reload, and are read as absent under another tag.
/** The shape tag the image list is stored under. */
export const IMAGES_SHAPE = 'images-3'
const images = atom({ plugin: 'image-peek', key: 'images' } as const, [], { shape: IMAGES_SHAPE })

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

/** A file of a picture's, by what it is for: its role names it. */
export type PictureFile =
  /** The bytes as they came: the clipboard's image, a stored row's base64. */
  | { role: 'source'; id: string; ext: string }
  /** A dropped or pasted file, copied in before it has a picture. */
  | { role: 'copy'; ext: string }
  /** The BMP a picture's cells for one size are read from. */
  | { role: 'cells'; id: string; columns: number; rows: number }

/** The files `finish` makes: the PNG and its two thumbnails. */
type MadeFile = { role: 'png' | 'thumb' | 'small'; id: string }

let copies = 0

/** Each file's name in the folder; a copy's is unique even in the same millisecond. */
async function nameOf($: $, file: PictureFile | MadeFile) {
  switch (file.role) {
    case 'source':
      return `${file.id}.${file.ext.replace(/^\./, '')}`
    case 'copy':
      return `drop-${await $.clock.now()}-${++copies}.${file.ext.replace(/^\./, '')}`
    case 'cells':
      return `${file.id}-${file.columns}x${file.rows}.bmp`
    case 'png':
      return `${file.id}.png`
    case 'thumb':
      return `${file.id}.thumb.png`
    case 'small':
      return `${file.id}.small.png`
  }
}

/**
 * Whether a path is one this module named, in a session's folder: deleting
 * goes by what a picture recorded, and never past these.
 */
const isNamedHere = (path: string) =>
  /claude-image-peek[\\/][A-Za-z0-9_-]+[\\/](drop-\d+-\d+|[A-Za-z0-9_-]+(\.thumb|\.small|-\d+x\d+)?)\.[A-Za-z0-9]+$/.test(path)

/** The path for the work to make the file at; deleted when the work ends, unless a kept picture owns it. Stale work stops here. */
async function claim($: $, work: Work, file: PictureFile | MadeFile) {
  const path = join(await folder($, work), await nameOf($, file))
  stopIfStale(work)
  work.files.add(path)
  return path
}

/**
 * Where the work makes a picture's file in the role `file` names. Code that
 * writes into the folder takes its path from here: a file written past it is
 * never deleted. Stale work stops here.
 */
export function fileFor($: $, work: Work, file: PictureFile) {
  return claim($, work, file)
}

/** The files a listed picture owns: its PNG and thumbnails (one path when no thumbnail was made). */
const filesOf = (img: PeekImage) => [img.path, img.thumb, img.small]

/** Deletes files this module named, each once. */
async function remove($: $, paths: readonly string[]) {
  const doomed = [...new Set(paths)].filter(isNamedHere)
  if (doomed.length > 0) await (await platform($)).removeFiles(doomed)
}

/** The image list. */
export async function pictures($: $) {
  return read($, images)
}

/**
 * Changes the list for the work, capped to the newest MAX_KEPT, and lets go
 * of the entries it drops (see `release`); resolves to the list as kept.
 * Stale work stops here, the change not made.
 */
export async function keep($: $, work: Work, change: (list: PeekImage[]) => PeekImage[]) {
  stopIfStale(work)
  let isKept = false
  let dropped: PeekImage[] = []
  let kept: PeekImage[] = []
  await update($, images, list => {
    // Checked on every run: an update can run again after a /peek clear that
    // came in the meantime, and must not bring old pictures back.
    isKept = isLive(work)
    if (!isKept) {
      dropped = []
      return list
    }
    kept = capped(change([...list]))
    dropped = list.filter(img => !kept.some(entry => entry.id === img.id))
    return kept
  })
  await release($, dropped, 'delete')
  if (!isKept) throw new Stale('stale work')
  return kept
}

/**
 * Lets go of pictures that left the list: with `files: 'delete'` the files
 * each recorded as its own, wherever the session's folder is now.
 */
async function release($: $, dropped: readonly PeekImage[], files: 'delete' | 'leave') {
  if (files === 'delete') await remove($, dropped.flatMap(filesOf))
}

/** Deletes the files the work made that no kept picture owns. */
async function end($: $, work: Work) {
  if (work.files.size === 0) return
  const owned = new Set((await read($, images)).flatMap(filesOf))
  const paths = [...work.files].filter(path => !owned.has(path))
  work.files.clear()
  await remove($, paths)
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
  base: Pick<PeekImage, 'id' | 'n' | 'source' | 'stage' | 'messageId' | 'promptText'> & { file: string },
): Promise<PeekImage | undefined> {
  stopIfStale(work)
  const p = await platform($)
  let path = base.file
  if (!/\.png$/i.test(path)) {
    const png = await claim($, work, { role: 'png', id: base.id })
    if (!(await p.toPng(path, png))) return undefined
    path = png
  }
  const thumb = await claim($, work, { role: 'thumb', id: base.id })
  const shown = (await p.toPng(path, thumb, 800)) ? thumb : path
  const small = await claim($, work, { role: 'small', id: base.id })
  const smallShown = (await p.toPng(shown, small, 400)) ? small : shown
  const { width, height } = await pngSize(p, shown)
  const { file: _file, ...rest } = base
  return { ...rest, path, thumb: shown, small: smallShown, width, height, addedAt: await $.clock.now() }
}

/** A PNG's width and height from its header, or zeros. */
async function pngSize(p: Platform, path: string) {
  const head = await p.readHead(path)
  if (!head || head.length < 24) return { width: 0, height: 0 }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
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
