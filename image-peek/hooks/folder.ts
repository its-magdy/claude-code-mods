// The session's folder, where the pictures' files live: where it is, made
// readable by this user alone, and its lease (a file whose age tells another
// session's sweep the folder is in use), renewed every hour while the session
// lives. A start sweeps the folders other sessions left behind; an end takes
// the session's own away, now on an exit, a moment later on a /clear or a
// /resume.

import type { EngineInterface, NextBudget, SessionEndInput } from 'claude-code'

import { osOf, platform } from './host'
import type { Os } from './host'

type $ = EngineInterface

const LEASE = '.lease'
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

/** A session's folder for pictures, and the OS that names the paths in it. */
export type Folder = { os: Os; dir: string }

const cached = new Map<string, Folder>()
const made = new Set<string>()

/**
 * This session's folder for pictures. Per session id, since a /clear starts
 * a new one. A folder only this user reads: macOS's TMPDIR is per user; on
 * Linux the runtime dir or ~/.cache, never the shared /tmp.
 */
export async function sessionFolder($: $): Promise<Folder> {
  return folderOf($, await $.session.id())
}

/** The same for a session named by id: an ending session's, after the process moved on. */
async function folderOf($: $, sessionId: string): Promise<Folder> {
  const session = sessionId.replace(/[^A-Za-z0-9_-]/g, '') || 'unnamed'
  const known = cached.get(session)
  if (known) return known
  const os = await osOf($)
  let root: string
  if (os === 'windows') {
    root = `${(await $.env.get('LOCALAPPDATA')) ?? (await $.env.get('TEMP')) ?? 'C:\\Windows\\Temp'}\\claude-image-peek`
  } else if (os === 'mac') {
    root = `${((await $.env.get('TMPDIR')) ?? `${(await $.env.get('HOME')) ?? ''}/Library/Caches`).replace(/\/+$/, '')}/claude-image-peek`
  } else {
    const runtime = await $.env.get('XDG_RUNTIME_DIR')
    root = runtime ? `${runtime}/claude-image-peek` : `${(await $.env.get('HOME')) ?? '/tmp'}/.cache/claude-image-peek`
  }
  const f: Folder = { os, dir: `${root}${sep(os)}${session}` }
  cached.set(session, f)
  return f
}

const sep = (os: Os) => (os === 'windows' ? '\\' : '/')

/** The path of the file named `name` in the folder. */
export const join = (f: Folder, name: string) => `${f.dir}${sep(f.os)}${name}`

/** The folder all sessions' folders are in. */
const rootOf = (f: Folder) => f.dir.slice(0, f.dir.lastIndexOf(sep(f.os)))

/** Another session's folder, named `name`, beside this one. */
const sibling = (f: Folder, name: string): Folder => ({ os: f.os, dir: `${rootOf(f)}${sep(f.os)}${name}` })

/**
 * This session's folder, made (`$.fs.write` creates the directories),
 * readable by this user alone, and its lease renewed.
 */
export async function makeFolder($: $): Promise<Folder> {
  const h = await sessionFolder($)
  await $.fs.write(join(h, LEASE), String(await $.clock.now()))
  if (made.has(h.dir)) return h
  await (await platform($)).makePrivate(h.dir)
  made.add(h.dir)
  return h
}

/**
 * Deletes the folder's files whose names start with one of the ids, and
 * those of `paths` that are in it.
 */
export async function removeFiles($: $, h: Folder, ids: readonly string[], paths: readonly string[] = []) {
  if (ids.length === 0 && paths.length === 0) return
  const names = (await $.fs.list(h.dir).catch(() => [])).map(entry => entry.name)
  const doomed = names
    .filter(name => ids.some(id => name.startsWith(`${id}.`) || name.startsWith(`${id}-`)) || paths.includes(join(h, name)))
    .map(name => join(h, name))
  if (doomed.length === 0) return
  await (await platform($)).removeFiles(doomed)
}

/**
 * The session started: its folder's lease is renewed every hour, idle or
 * not, while it lives, so no other session's sweep takes it for abandoned.
 */
export function started($: $) {
  $.clock.every(HOUR, () => {
    void makeFolder($)
  })
}

/**
 * Deletes other sessions' folders left behind (an exit too quick to clean up,
 * a crash): those whose lease no live session has renewed for a day.
 */
export async function sweep($: $) {
  const h = await sessionFolder($)
  const now = await $.clock.now()
  const entries = await $.fs.list(rootOf(h)).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'dir' || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue
    const other = sibling(h, entry.name)
    if (other.dir === h.dir) continue
    const lease = await $.fs.stat(join(other, LEASE)).catch(() => undefined)
    const stat = lease ?? (await $.fs.stat(other.dir).catch(() => undefined))
    if (stat && now - stat.mtimeMs > DAY) await removeDir($, other)
  }
}

/**
 * The session ended. A /clear or a /resume goes on in this process under a
 * new id: the old folder is left for the work this answers to delete, once
 * the switch has settled. A real exit shares one short bound with every
 * plugin: the folder goes now if there is time, and never on Windows; what
 * it leaves, the next start sweeps.
 */
export async function ended($: $, e: SessionEndInput, budget: NextBudget): Promise<(() => Promise<void>) | undefined> {
  const old = await folderOf($, e.sessionId)
  if (e.reason === 'clear' || e.reason === 'resume') return () => removeDir($, old)
  if (old.os !== 'windows' && budget.remainingMs > 300) await removeDir($, old)
  return undefined
}

/** Deletes a session's folder of pictures. */
async function removeDir($: $, h: Folder) {
  // Only ever a session's own folder under ours: never the parent, never empty.
  const root = rootOf(h)
  if (!root.endsWith('claude-image-peek') || !/^[A-Za-z0-9_-]+$/.test(h.dir.slice(root.length + 1))) return
  made.delete(h.dir)
  await (await platform($)).removeDir(h.dir)
}
