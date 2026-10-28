// A least-recently-used cache bounded by a total weight, not a count: the
// entries (a PNG's base64, a picture's cells) differ in size by 100x, so a
// count cap is either too tight for thumbnails or too loose for big images.
// A Map keeps insertion order; a read moves its key to the end, so the first
// key is always the one to evict.

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

  /** Drops every key `match` accepts. */
  deleteWhere(match: (key: string) => boolean) {
    for (const key of [...this.entries.keys()]) if (match(key)) this.delete(key)
  }

  get size() {
    return this.entries.size
  }

  get weight() {
    return this.total
  }
}
