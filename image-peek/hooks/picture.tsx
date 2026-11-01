// Drawing a picture: how this terminal can show one (a PNG file, PNG bytes,
// half-block cells or a label), at what size, and the caches that let a
// drawing answer at once. `warm` makes ahead what `draw` will ask for.

import type { EngineInterface, PluginOptions, RenderElement, RenderInput } from 'claude-code'

import type { PeekImage } from '../types'
import { drawingCache, made, now } from './cache'
import { platform } from './host'
import { MAX_KEPT } from './list'
import { bmpToCells } from './raster'
import { fileFor, folder } from './pictures'
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
// The drawing's caches (see cache.ts), bounded by size, least recently used
// out: a dropped entry is only read or made again. A new generation starts
// them empty, and keys name the picture as made (its id and when it was
// added), so a picture that left the list is never asked for again, and one
// restored at the same path (its files made anew) is drawn afresh. 32M
// base64 chars hold the band's dozen previews even at the 2 MiB cap. The
// cells' budget is three of the largest views for every kept image plus one:
// the sizes on screen at once (inline, card, band, the pane's list and its
// big view) weigh less, so making one never evicts another still drawn (a
// loop of make, redraw, make). Only sizes left by a resize age out.
const CELL_CHARS = (RASTER.columns * RASTER.rows * 12 * 4) / 3

/** A listed picture, as made: a picture made again is a new one. */
const pictureKey = (img: PeekImage) => `${img.id}|${img.addedAt}`

/** PNGs' bytes, read while drawing (no process runs), once per file. */
const pngs = drawingCache('png', 32 * 1024 * 1024, (base64: string) => base64.length)

/** Pictures' half-block cells for one size, made off the drawing: a process runs. */
const cells = drawingCache('cells', (MAX_KEPT * 3 + 1) * CELL_CHARS, (packed: string) => packed.length)

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

/** A PNG's bytes for the drawing, at most MAX_BYTES of them. */
function pngBytes($: $, img: PeekImage, path: string) {
  return made($, pngs, `${pictureKey(img)}|${path}`, async () => {
    const { base64 } = await $.fs.read(path, { as: 'bytes' }).catch(() => ({ base64: '' }))
    return base64 && (base64.length * 3) / 4 <= MAX_BYTES ? base64 : undefined
  })
}

const cellKey = (img: PeekImage, size: Size) => `${pictureKey(img)}|${img.small}|${size.columns}x${size.rows}`

/** Makes a picture's cells for one size: the BMP `sips` writes, read back. */
async function makeCells($: $, work: Work, img: PeekImage, size: Size) {
  // A folder that can't be made can't hold the BMP: no cells, not a retry each drawing.
  if (!(await folder($, work).catch(() => undefined))) return undefined
  // The cells are all that's kept; each window size would leave a BMP behind.
  const bmp = await fileFor($, work, { role: 'cells', id: img.id, ...size })
  const ok = await (await platform($)).toBmp(img.small, bmp, size.columns, size.rows * 2)
  const { base64 } = ok ? await $.fs.read(bmp, { as: 'bytes' }).catch(() => ({ base64: '' })) : { base64: '' }
  return base64 ? bmpToCells(base64, size.columns, size.rows) : undefined
}

/** Cells for a size now, or undefined while they are made off the drawing; the drawing comes again once they are. */
function cellsNow($: $, img: PeekImage, size: Size) {
  return now($, cells, cellKey(img, size), work => makeCells($, work, img, size))
}

/** Cells for a size made ahead; the drawing shares the job. */
function cellsMade($: $, img: PeekImage, size: Size) {
  return made($, cells, cellKey(img, size), work => makeCells($, work, img, size))
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
    const png = await pngBytes($, img, file)
    if (png) return <Image key={`img-${img.id}-${view}`} source={{ png }} {...size} alt={alt} />
  }
  if (how === 'blocks' || how === 'bytes') {
    const box = cellSize(img, columns, rows)
    const packed = cellsNow($, img, box)
    if (packed) return <Raster key={`ras-${img.id}-${view}`} {...box} cells={packed} />
    return <Text dimColor>[{alt}…]</Text>
  }
  return <Text dimColor>[{alt}: /peek open {img.n}]</Text>
}

/** Makes ahead the cells of the fixed views, so a message row draws blocks at once. */
export async function warm($: $, options: PluginOptions, img: PeekImage) {
  const how = await graphics($, options)
  if (how === 'blocks' || how === 'bytes') await cellsMade($, img, cellSize(img, INLINE.columns, INLINE.rows))
  if (how === 'blocks') await cellsMade($, img, cellSize(img, CARD.columns, CARD.rows))
}

