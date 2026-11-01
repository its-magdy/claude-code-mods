// The session's folder, where the pictures' files live: where it is, made
// readable by this user alone, and its lease (a file whose age tells another
// session's sweep the folder is in use), renewed every hour while the session
// lives. A start sweeps the folders other sessions left behind; an end takes
// the session's own away, now on an exit, a moment later on a /clear or a
// /resume.

import type { EngineInterface, NextBudget, SessionEndInput } from 'claude-code'

import { platform } from './host'
import type { Paths } from './host'

type $ = EngineInterface

const LEASE = '.lease'
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

/** A session's folder for pictures, and how the OS names the paths in it. */
export type Folder = { dir: string; paths: Paths }

const cached = new Map<string, Folder>()
const made = new Set<string>()

/**
 * This session's folder for pictures. Per session id, since a /clear starts
 * a new one. In the platform's folder only this user reads.
 */
export async function sessionFolder($: $): Promise<Folder> {
  return folderOf($, await $.session.id())
}

/** The same for a session named by id: an ending session's, after the process moved on. */
async function folderOf($: $, sessionId: string): Promise<Folder> {
  const session = sessionId.replace(/[^A-Za-z0-9_-]/g, '') || 'unnamed'
  const known = cached.get(session)
  if (known) return known
  const p = await platform($)
  const f: Folder = { dir: p.paths.join(p.paths.join(await p.privateRoot(), 'claude-image-peek'), session), paths: p.paths }
  cached.set(session, f)
  return f
}

/** The path of the file named `name` in the folder. */
export const join = (f: Folder, name: string) => f.paths.join(f.dir, name)

/** The folder all sessions' folders are in. */
const rootOf = (f: Folder) => f.paths.parentOf(f.dir)

/** Another session's folder, named `name`, beside this one. */
const sibling = (f: Folder, name: string): Folder => ({ dir: f.paths.join(rootOf(f), name), paths: f.paths })

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
 * plugin: the folder goes now if there is time, and never where removing
 * it is slow (Windows' PowerShell); what it leaves, the next start sweeps.
 */
export async function ended($: $, e: SessionEndInput, budget: NextBudget): Promise<(() => Promise<void>) | undefined> {
  const old = await folderOf($, e.sessionId)
  if (e.reason === 'clear' || e.reason === 'resume') return () => removeDir($, old)
  if ((await platform($)).isRemovalQuick && budget.remainingMs > 300) await removeDir($, old)
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
