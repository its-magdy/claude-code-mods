// A least-recently-used cache bounded by a total weight, not a count: the
// entries (a PNG's base64, a picture's cells) differ in size by 100x, so a
// count cap is either too tight for thumbnails or too loose for big images.
// A Map keeps insertion order; a read moves its key to the end, so the first
// key is always the one to evict. Over it, a drawing's cache: values a
// drawing shows, made off the drawing once per key and generation.

import type { EngineInterface } from 'claude-code'

import { later, perGeneration, run } from './pictures'
import type { Work } from './pictures'

type $ = EngineInterface

export class Lru<V> {
  private readonly entries = new Map<string, { value: V; weight: number }>()
  private readonly budget: number
  private readonly weigh: (value: V) => number
  private total = 0

  /** `weigh` measures an entry; one heavier than `budget` alone is not kept. */
  constructor(budget: number, weigh: (value: V) => number) {
    this.budget = budget
    this.weigh = weigh
  }

  has(key: string) {
    return this.entries.has(key)
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: V) {
    this.delete(key)
    // Even an empty entry (a failed read) weighs one, so a pile of them is bounded too.
    const weight = Math.max(1, this.weigh(value))
    if (weight > this.budget) return
    this.entries.set(key, { value, weight })
    this.total += weight
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.budget) break
      this.entries.delete(oldest)
      this.total -= entry.weight
    }
  }

  delete(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.total -= entry.weight
  }

  get size() {
    return this.entries.size
  }

  get weight() {
    return this.total
  }
}

/** What makes a value for a drawing cache, in the work that makes it; nothing when it can't be made. */
export type Make<V> = (work: Work) => Promise<V | undefined>

/** A cache of values made off the drawing: one Lru, one job and one waiter per key, all of one generation. */
export type DrawingCache<V> = {
  readonly label: string
  readonly held: (work?: Work) => { values: Lru<V | null>; jobs: Map<string, Promise<void>>; waiting: Set<string> }
}

/**
 * A cache of what a drawing shows but must not make while drawing (a
 * process's output) or makes once (a file's bytes): a key's value is made
 * once, its value or its absence kept until the Lru drops it. A new
 * generation starts the cache empty, and work begun before it keeps what it
 * makes out of the newer one.
 */
export function drawingCache<V>(label: string, budget: number, weigh: (value: V) => number): DrawingCache<V> {
  return {
    label,
    held: perGeneration(() => ({
      values: new Lru<V | null>(budget, value => (value === null ? 0 : weigh(value))),
      jobs: new Map<string, Promise<void>>(),
      waiting: new Set<string>(),
    })),
  }
}

/**
 * The value for `key` now, or undefined while `make` makes it off the
 * drawing: then the drawing comes again, once, when it is in. A miss asks one
 * redraw per key however often it is drawn meanwhile.
 */
export function now<V>($: $, cache: DrawingCache<V>, key: string, make: Make<V>): V | undefined {
  const { values, waiting } = cache.held()
  if (values.has(key)) return values.get(key) ?? undefined
  if (!waiting.has(key)) {
    waiting.add(key)
    later($, cache.label, async work => {
      try {
        await made($, cache, key, make)
      } finally {
        cache.held(work).waiting.delete(key)
      }
      $.ui.invalidate('ui.render')
    })
  }
  return undefined
}

/** The value for `key`, made now by `make` if it is not in: a drawing's `now` and this share one job per key. */
export async function made<V>($: $, cache: DrawingCache<V>, key: string, make: Make<V>): Promise<V | undefined> {
  const { values, jobs } = cache.held()
  if (!values.has(key)) {
    let job = jobs.get(key)
    if (!job) {
      job = run($, async work => {
        const value = await make(work)
        // Stale work's value goes to its own generation's cache: no drawing asks there again.
        cache.held(work).values.set(key, value ?? null)
      })
        .then(() => undefined)
        .finally(() => jobs.delete(key))
      jobs.set(key, job)
    }
    await job
  }
  return values.get(key) ?? undefined
}
