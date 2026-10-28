// The session's pictures: the image list, the generation, and the files
// work makes for it. Work names each file it makes here; when the work ends,
// whatever no kept picture owns is deleted. A new generation (a session end,
// /clear, /resume, /peek clear) outlives the work begun before it: that work
// stops before it changes the list, and its files go when it ends.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { PeekImage } from '../types'
import { host, join, removeFiles } from './host'
import type { Host } from './host'
import { capped } from './list'

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
export const begin = (): Work => ({ born: generation, files: new Map() })

/** False once a newer generation began: the work should stop. */
export const isLive = (work: Work) => work.born === generation

/** A path in the session's folder for the work to make; deleted when the work ends, unless a kept picture owns it. */
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
 * Changes the list for the work, capped to the newest MAX_KEPT, and deletes
 * the files of the entries it drops. Not kept when a newer generation came
 * first: the change was not made.
 */
export async function keep($: $, work: Work, change: (list: PeekImage[]) => PeekImage[]) {
  if (!isLive(work)) return { isKept: false, dropped: [] }
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
  await removeAll($, dropped)
  return { isKept, dropped }
}

/** Deletes every file of the pictures: each under its id, and its PNG by name. */
async function removeAll($: $, dropped: readonly PeekImage[]) {
  if (dropped.length === 0) return
  await removeFiles($, await host($), dropped.map(img => img.id), dropped.map(img => fileName(img.path)))
}

/** Deletes the files the work made that no kept picture owns. */
export async function end($: $, work: Work) {
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
 * Begins a new generation with an empty list, and gives back what it held.
 * `files: 'delete'` deletes their files; 'leave' when the folder goes whole.
 */
export async function reset($: $, files: 'delete' | 'leave') {
  generation++
  let dropped: PeekImage[] = []
  await update($, images, list => {
    dropped = list
    return []
  })
  if (files === 'delete') await removeAll($, dropped)
  return dropped
}
