// Drawing a picture: how this terminal can show one (a PNG file, PNG bytes,
// half-block cells or a label), at what size, and the caches that let a
// drawing answer at once. `warm` makes ahead what `draw` will ask for; `forget`
// lets go of a picture that left the list.

import type { EngineInterface, PluginOptions, RenderElement, RenderInput } from 'claude-code'

import type { PeekImage } from '../types'
import { Lru } from './cache'
import { host, toBmp } from './host'
import { MAX_KEPT } from './list'
import { bmpToCells } from './raster'
import { claim, isLive, later, run } from './pictures'
import type { Work } from './pictures'
import { isFullscreen, probe } from './session'

type $ = EngineInterface
type Mode = 'file' | 'bytes' | 'blocks' | 'off'
type View = 'inline' | 'card' | 'pane' | 'big'
type Size = { columns: number; rows: number }

const MAX_BYTES = 2 * 1024 * 1024
// The fixed boxes thumbnails are drawn in: inline under a message on the main
// screen, and the hover card in the fullscreen layout.
export const INLINE = { columns: 28, rows: 8 }
const CARD = { columns: 100, rows: 24 }
/** The block preview's largest size (Raster takes up to 512 x 256): each cell is a palette entry to paint. */
const RASTER = { columns: 160, rows: 80 }

// Module state: rebuilt after a reload, and nothing drawn depends on it alone.
let mode: Mode | undefined
let isTmux = false
// Bounded by size, least recently used out: a dropped entry is only read or
// made again. 32M base64 chars hold the band's dozen previews even at the
// 2 MiB cap. The cells' budget is three of the largest views for every kept
// image plus one: the sizes on screen at once (inline, card, band, the pane's
// list and its big view) weigh less, so making one never evicts another still
// drawn (a loop of make, redraw, make). Only sizes left by a resize age out.
const CELL_CHARS = (RASTER.columns * RASTER.rows * 12 * 4) / 3
const pngCache = new Lru<string | null>(32 * 1024 * 1024, value => value?.length ?? 0)
const cellCache = new Lru<string | null>((MAX_KEPT * 3 + 1) * CELL_CHARS, value => value?.length ?? 0)
/** Cells being made, by key: the drawing and `warm` share one job, and so one BMP file. `forget` voids a job under way. */
const cellJobs = new Map<string, { done: Promise<void>; isVoid: boolean }>()
/** Keys a drawing waits on until their cells are in, with the work that waits: a newer generation drops it unrun. */
const cellAsked = new Map<string, Work>()

/** How this terminal can show a picture: the setting, else a guess from its env. */
export async function graphics($: $, options: PluginOptions): Promise<Mode> {
  if (mode) return mode
  isTmux = Boolean(await $.env.get('TMUX'))
  const pick = String(options.graphics ?? 'auto')
  if (pick === 'file' || pick === 'bytes' || pick === 'blocks' || pick === 'off') {
    mode = pick
    return mode
  }
  const env = {
    TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
    TERM: await $.env.get('TERM'),
    LC_TERMINAL: await $.env.get('LC_TERMINAL'),
    KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
    GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
    TMUX: isTmux,
  }
  const name = `${env.TERM_PROGRAM ?? ''} ${env.TERM ?? ''}`
  // tmux passes bytes through (with allow-passthrough and focus-events on), never a file name.
  mode = isTmux
    ? 'bytes'
    : env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR || /ghostty|kitty/i.test(name)
      ? 'file'
      : env.TERM_PROGRAM === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2'
        ? 'bytes'
        : 'blocks'
  void probe($, 'graphics', { mode, ...env, KITTY_WINDOW_ID: Boolean(env.KITTY_WINDOW_ID), GHOSTTY_RESOURCES_DIR: Boolean(env.GHOSTTY_RESOURCES_DIR) })
  return mode
}

/**
 * How a picture is drawn in a given view. iTerm2 draws bytes only under the
 * fullscreen layout (tmux in either), so its main-screen thumbnails are blocks.
 */
function drawAs(how: Mode, view: View): Mode {
  if (how === 'bytes' && view === 'inline' && !isFullscreen() && !isTmux) return 'blocks'
  return how
}

/** Cells a picture takes at most `columns` x `rows`, keeping its shape (a cell is about twice as tall as wide). */
function fit(img: PeekImage, columns: number, rows: number): Size {
  const aspect = img.width > 0 && img.height > 0 ? img.height / img.width : 0.6
  let c = Math.max(1, Math.min(255, Math.floor(columns)))
  let r = Math.max(1, Math.round((c * aspect) / 2))
  if (r > rows) {
    r = Math.max(1, Math.min(255, Math.floor(rows)))
    c = Math.max(1, Math.min(255, Math.round((r * 2) / aspect)))
  }
  return { columns: c, rows: r }
}

/** The cells a picture in a box of `columns` x `rows` is drawn with: the one size `draw` and `warm` both key by. */
const cellSize = (img: PeekImage, columns: number, rows: number): Size => {
  const size = fit(img, columns, rows)
  return { columns: Math.min(size.columns, RASTER.columns), rows: Math.min(size.rows, RASTER.rows) }
}

const cellKey = (img: PeekImage, size: Size) => `${img.small}|${size.columns}x${size.rows}`

/** Makes the half-block cells for one size; a process runs, so never while drawing. */
function makeCells($: $, img: PeekImage, size: Size) {
  const key = cellKey(img, size)
  if (cellCache.has(key)) return Promise.resolve()
  let job = cellJobs.get(key)
  if (!job) {
    const made = { done: Promise.resolve(), isVoid: false }
    made.done = convertCells($, img, size, key, made).finally(() => cellJobs.delete(key))
    cellJobs.set(key, made)
    job = made
  }
  return job.done
}

async function convertCells($: $, img: PeekImage, size: Size, key: string, job: { isVoid: boolean }) {
  // The cells are all that's kept; each window size would leave a BMP behind.
  await run($, async work => {
    const h = await host($)
    const bmp = claim(work, h, `${img.id}-${size.columns}x${size.rows}.bmp`)
    const ok = await toBmp($, h, img.small, bmp, size.columns, size.rows * 2)
    const { base64 } = ok ? await $.fs.read(bmp, { as: 'bytes' }).catch(() => ({ base64: '' })) : { base64: '' }
    // Dropped while its cells were made: keep nothing for a picture that's gone.
    if (job.isVoid || !isLive(work)) return
    cellCache.set(key, base64 ? (bmpToCells(base64, size.columns, size.rows) ?? null) : null)
  })
}

/** Cells for a size, or undefined while they are made off the drawing; the drawing comes again once they are. */
function cells($: $, img: PeekImage, size: Size) {
  const key = cellKey(img, size)
  if (cellCache.has(key)) return cellCache.get(key) ?? undefined
  // One waiter per key, even when `warm` already started the job: it
  // redraws once the cells are in.
  const asked = cellAsked.get(key)
  if (!asked || !isLive(asked)) {
    const work = later($, 'cells', async () => {
      try {
        await makeCells($, img, size)
      } finally {
        if (cellAsked.get(key) === work) cellAsked.delete(key)
      }
      $.ui.invalidate('ui.render')
    })
    cellAsked.set(key, work)
  }
  return undefined
}

async function pngBytes($: $, path: string) {
  if (!pngCache.has(path)) {
    const { base64 } = await $.fs.read(path, { as: 'bytes' }).catch(() => ({ base64: '' }))
    pngCache.set(path, base64 && (base64.length * 3) / 4 <= MAX_BYTES ? base64 : null)
  }
  return pngCache.get(path) ?? undefined
}

/** One picture at most `columns` x `rows` cells, drawn the way this terminal can; no process runs here. */
export async function draw(
  $: $,
  e: RenderInput<'UserMessage' | 'Pane' | 'AbovePrompt', 'terminal'>,
  options: PluginOptions,
  img: PeekImage,
  view: View,
  columns: number,
  rows: number,
): Promise<RenderElement> {
  const { Image, Raster, Text } = $.ui.resolve(e)
  const size = fit(img, columns, rows)
  const alt = `Image ${img.n}`
  const file = view === 'inline' ? img.small : img.thumb
  const how = drawAs(await graphics($, options), view)
  if (how === 'file') return <Image key={`img-${img.id}-${view}`} source={{ file, format: 'png' }} {...size} alt={alt} />
  if (how === 'bytes') {
    const png = await pngBytes($, file)
    if (png) return <Image key={`img-${img.id}-${view}`} source={{ png }} {...size} alt={alt} />
  }
  if (how === 'blocks' || how === 'bytes') {
    const box = cellSize(img, columns, rows)
    const packed = cells($, img, box)
    if (packed) return <Raster key={`ras-${img.id}-${view}`} {...box} cells={packed} />
    return <Text dimColor>[{alt}…]</Text>
  }
  return <Text dimColor>[{alt}: /peek open {img.n}]</Text>
}

/** Makes ahead the cells of the fixed views, so a message row draws blocks at once. */
export async function warm($: $, options: PluginOptions, img: PeekImage) {
  const how = await graphics($, options)
  if (how === 'blocks' || how === 'bytes') await makeCells($, img, cellSize(img, INLINE.columns, INLINE.rows))
  if (how === 'blocks') await makeCells($, img, cellSize(img, CARD.columns, CARD.rows))
}

/** Lets go of what was kept to draw a picture that left the list. */
export function forget(img: PeekImage) {
  for (const [key, job] of cellJobs) if (key.startsWith(`${img.small}|`)) job.isVoid = true
  pngCache.delete(img.thumb)
  pngCache.delete(img.small)
  cellCache.deleteWhere(key => key.startsWith(`${img.small}|`))
}
