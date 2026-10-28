import { atom, read, update } from 'claude-code'
import type { ApiContentBlock, EngineInterface, PluginOptions, Register, RenderElement, RenderInput } from 'claude-code'

import type { PeekImage, PeekSource } from '../types'
import {
  copyFile,
  ensureDir,
  grabClipboard,
  host,
  hostFor,
  imagePaths,
  isImageFile,
  join,
  linuxPath,
  openExternally,
  pngSize,
  recentScreenshot,
  removeDir,
  removeFiles,
  sweepStale,
  toBmp,
  toPng,
  writeBase64,
} from './host'
import { Lru } from './cache'
import type { Host } from './host'
import { bmpToCells } from './raster'

type $ = EngineInterface
type Mode = 'file' | 'bytes' | 'blocks' | 'off'
type View = 'inline' | 'card' | 'pane' | 'big'

const PANE = 'image-peek'
const PLACEHOLDER = /\[Image #(\d+)\]/g
const MAX_BYTES = 2 * 1024 * 1024
const MAX_KEPT = 40
// The fixed boxes thumbnails are drawn in: inline under a message on the main
// screen, and the hover card in the fullscreen layout.
const INLINE = { columns: 28, rows: 8 }
/** Fewest rows a hover preview is drawn in; with fewer the band shows a hint. */
const MIN_CARD_ROWS = 6
const CARD = { columns: 100, rows: 24 }

// Change the tag when PeekImage's fields change: values an earlier version
// stored outlive a reload, and are read as absent under another tag.
const images = atom({ plugin: 'image-peek', key: 'images' } as const, [], { shape: 'images-2' })
const selected = atom({ plugin: 'image-peek', key: 'selected' } as const, null)
const isDebug = atom({ plugin: 'image-peek', key: 'isDebug' } as const, false)

// Module state: rebuilt after a reload, and nothing drawn depends on it alone.
let isFullscreen: boolean | undefined
/**
 * Bumped when the session's pictures are dropped (a session end, /clear,
 * /resume, /peek clear): work scheduled before then finds it moved and stops
 * before it writes a file or the list.
 */
let generation = 0
let isTmux = false
let isPaneOffered = false
let mode: Mode | undefined
/** The clipboard's change counter at the last grab: unchanged means no new image was copied. */
let lastChange: number | undefined
const inFlight = new Set<number>()
/** Image paths a paste named, for a placeholder the engine puts in a moment later. */
const recentPaths: { path: string; at: number }[] = []
/** Screenshots already taken for a draft, so a second placeholder gets the next one. */
const usedShots = new Set<string>()
let isDeniedTold = false
/** The block preview's largest size (Raster takes up to 512 x 256): each cell is a palette entry to paint. */
const RASTER = { columns: 160, rows: 80 }
// Bounded by size, least recently used out: a dropped entry is only read or
// made again. 32M base64 chars hold the band's dozen previews even at the
// 2 MiB cap. The cells' budget is three of the largest views for every kept
// image plus one: the sizes on screen at once (inline, card, band, the pane's
// list and its big view) weigh less, so making one never evicts another still
// drawn (a loop of make, redraw, make). Only sizes left by a resize age out.
const CELL_CHARS = (RASTER.columns * RASTER.rows * 12 * 4) / 3
const pngCache = new Lru<string | null>(32 * 1024 * 1024, value => value?.length ?? 0)
const cellCache = new Lru<string | null>((MAX_KEPT * 3 + 1) * CELL_CHARS, value => value?.length ?? 0)
/** Cells being made, by key: the drawing and `warm` share one job, and so one BMP file. */
const cellJobs = new Map<string, Promise<void>>()
/** Keys a drawing waits on, until their cells are in; a new generation drops its waiters unrun, so it clears these. */
const cellAsked = new Set<string>()

function nextGeneration() {
  generation++
  cellAsked.clear()
}

/** The hover group that ties a message's chip to its preview in the band. */
const scopeOf = (img: PeekImage) => `peek-${img.id}`.slice(0, 64)
const placeholders = (text: string) => [...new Set([...text.matchAll(PLACEHOLDER)].map(m => Number(m[1])))]
/** A prompt's words as the person typed them: the engine's hidden reminders out, spaces folded. */
const promptWords = (text: string) =>
  text
    // Engine blocks: `<system-reminder>`, and a slash command's record
    // (`<command-name>`, `<local-command-stdout>`, …) that a resumed
    // conversation merges into the next prompt's row.
    .replace(/<([a-z][a-z0-9_-]*)>[\s\S]*?<\/\1>/g, ' ')
    // The engine notes a dropped file's path beside its placeholder in the stored row.
    .replace(/\[Image: source: [^\]\n]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const sameText = (a: string, b: string) => promptWords(a) === promptWords(b)
/**
 * Whether a transcript row is the stored row: the row's id is the stored
 * uuid with its last group zeroed (`…-8c48-000000000000`), or the uuid itself.
 */
const sameRow = (requestId: string, messageId: string | undefined) =>
  messageId !== undefined &&
  (requestId === messageId || (/-0{12}$/.test(requestId) && requestId.slice(0, 24) === messageId.slice(0, 24)))
const isDraft = (img: PeekImage) => img.messageId === undefined && img.promptText === undefined
const latest = (list: readonly PeekImage[], n: number) =>
  list.filter(img => img.n === n).sort((a, b) => b.addedAt - a.addedAt)[0]
const capped = (list: PeekImage[]) => list.sort((a, b) => a.addedAt - b.addedAt).slice(-MAX_KEPT)

async function probe($: $, label: string, data: unknown) {
  const isOn = await read($, isDebug)
  $.ui.log(`[image-peek] ${label} ${JSON.stringify(data)}`, { to: isOn ? 'transcript' : 'debug' })
}

/**
 * Runs work after the hook that asked for it has answered: the reference puts
 * work that outlives a dispatch on `$.clock`, never on the dispatch itself.
 */
function later($: $, label: string, work: (born: number) => Promise<unknown>, ms = 0) {
  const born = generation
  $.clock.after(ms, () => {
    if (born !== generation) return
    // The error's name only: its message may hold a file path.
    work(born).catch(error => probe($, `${label} failed`, error instanceof Error ? error.name : typeof error))
  })
}

let stamps = 0
/** A file-name stamp no other capture or copy shares, even in the same millisecond. */
const uniqueStamp = async ($: $) => `${await $.clock.now()}-${++stamps}`

/** A path's last part: the name `removeFiles` matches. */
const fileName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/**
 * Changes the list for work of generation `born`, capped to the newest
 * MAX_KEPT; deletes the files and cached drawings of the entries it drops.
 * False when a newer generation came first: the change was not made.
 */
async function setImages($: $, born: number, change: (list: PeekImage[]) => PeekImage[]) {
  if (born !== generation) return false
  let isMade = false
  let dropped: PeekImage[] = []
  await update($, images, list => {
    // Checked on every run: an update can run again after a /peek clear that
    // came in the meantime, and must not bring old pictures back.
    isMade = born === generation
    if (!isMade) {
      dropped = []
      return list
    }
    const next = capped(change([...list]))
    dropped = list.filter(img => !next.some(kept => kept.id === img.id))
    return next
  })
  if (dropped.length === 0) return isMade
  for (const img of dropped) {
    pngCache.delete(img.thumb)
    pngCache.delete(img.small)
    cellCache.deleteWhere(key => key.startsWith(`${img.small}|`))
  }
  const h = await host($)
  await removeFiles($, h, dropped.map(img => img.id), dropped.map(img => fileName(img.path)))
  return isMade
}

/** How this terminal can show a picture: the setting, else a guess from its env. */
async function graphics($: $, options: PluginOptions): Promise<Mode> {
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
  if (how === 'bytes' && view === 'inline' && isFullscreen !== true && !isTmux) return 'blocks'
  return how
}

/** Cells a picture takes at most `columns` x `rows`, keeping its shape (a cell is about twice as tall as wide). */
function fit(img: PeekImage, columns: number, rows: number) {
  const aspect = img.width > 0 && img.height > 0 ? img.height / img.width : 0.6
  let c = Math.max(1, Math.min(255, Math.floor(columns)))
  let r = Math.max(1, Math.round((c * aspect) / 2))
  if (r > rows) {
    r = Math.max(1, Math.min(255, Math.floor(rows)))
    c = Math.max(1, Math.min(255, Math.round((r * 2) / aspect)))
  }
  return { columns: c, rows: r }
}

const rasterSize = (size: { columns: number; rows: number }) => ({
  columns: Math.min(size.columns, RASTER.columns),
  rows: Math.min(size.rows, RASTER.rows),
})

const cellKey = (img: PeekImage, size: { columns: number; rows: number }) => `${img.small}|${size.columns}x${size.rows}`

/** Makes the half-block cells for one size; a process runs, so never while drawing. */
function makeCells($: $, img: PeekImage, size: { columns: number; rows: number }) {
  const key = cellKey(img, size)
  if (cellCache.has(key)) return Promise.resolve()
  let job = cellJobs.get(key)
  if (!job) {
    job = convertCells($, img, size, key).finally(() => cellJobs.delete(key))
    cellJobs.set(key, job)
  }
  return job
}

async function convertCells($: $, img: PeekImage, size: { columns: number; rows: number }, key: string) {
  const h = await host($)
  const bmp = join(h, `${img.id}-${size.columns}x${size.rows}.bmp`)
  const ok = await toBmp($, h, img.small, bmp, size.columns, size.rows * 2)
  const { base64 } = ok ? await $.fs.read(bmp, { as: 'bytes' }).catch(() => ({ base64: '' })) : { base64: '' }
  // The cells are all that's kept; each window size would leave a BMP behind.
  await removeFiles($, h, [], [`${img.id}-${size.columns}x${size.rows}.bmp`])
  // Dropped while its cells were made: keep nothing for a picture that's gone.
  if (!(await read($, images)).some(kept => kept.small === img.small)) return
  cellCache.set(key, base64 ? (bmpToCells(base64, size.columns, size.rows) ?? null) : null)
}

/** Cells for a size, or undefined while they are made off the drawing; the drawing comes again once they are. */
function cells($: $, img: PeekImage, size: { columns: number; rows: number }) {
  const key = cellKey(img, size)
  if (cellCache.has(key)) return cellCache.get(key) ?? undefined
  // One waiter per key, even when `warm` already started the job: it
  // redraws once the cells are in.
  if (!cellAsked.has(key)) {
    cellAsked.add(key)
    later($, 'cells', async () => {
      try {
        await makeCells($, img, size)
      } finally {
        cellAsked.delete(key)
      }
      $.ui.invalidate('ui.render')
    })
  }
  return undefined
}

/** Makes ahead the cells of the fixed views, so a message row draws blocks at once. */
async function warm($: $, options: PluginOptions, img: PeekImage) {
  const how = await graphics($, options)
  if (how === 'blocks' || how === 'bytes') await makeCells($, img, rasterSize(fit(img, INLINE.columns, INLINE.rows)))
  if (how === 'blocks') await makeCells($, img, rasterSize(fit(img, CARD.columns, CARD.rows)))
}

/** Makes the PNG and its two thumbnails, and reads the thumbnail's size. */
async function finish(
  $: $,
  h: Host,
  base: Pick<PeekImage, 'id' | 'n' | 'source' | 'messageId' | 'promptText'> & { file: string },
): Promise<PeekImage | undefined> {
  let path = base.file
  if (!/\.png$/i.test(path)) {
    const png = join(h, `${base.id}.png`)
    if (!(await toPng($, h, path, png))) return undefined
    // The original was only a step to the PNG; one outside our folder is the person's own.
    if (path.startsWith(h.dir)) await removeFiles($, h, [], [fileName(path)])
    path = png
  }
  const thumb = join(h, `${base.id}.thumb.png`)
  const shown = (await toPng($, h, path, thumb, 800)) ? thumb : path
  const small = join(h, `${base.id}.small.png`)
  const smallShown = (await toPng($, h, shown, small, 400)) ? small : shown
  const { width, height } = await pngSize($, shown)
  const { file: _file, ...rest } = base
  return { ...rest, path, thumb: shown, small: smallShown, width, height, addedAt: await $.clock.now() }
}

/** Copies files a drop or paste named, at once: macOS deletes a screenshot thumbnail's temporary file soon after. */
async function copyDropped($: $, paths: string[]) {
  const h = await host($)
  await ensureDir($, h)
  const home = (await $.env.get('HOME')) ?? ''
  const copies: string[] = []
  for (const [i, path] of paths.entries()) {
    const from = await linuxPath($, h, path.startsWith('~/') ? home + path.slice(1) : path)
    const ext = from.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '.png'
    const copy = join(h, `drop-${await uniqueStamp($)}-${i}${ext}`)
    if (await copyFile($, h, from, copy)) copies.push(copy)
  }
  return copies
}

/**
 * Saves the picture behind each new "[Image #N]" of the draft: from the file
 * the same paste named, else the clipboard, when it holds an image copied
 * since the last grab.
 */
async function captureDraft($: $, options: PluginOptions, born: number, ns: number[], via: string, files: string[] = []) {
  const h = await host($)
  // The copies a drop made that no placeholder here takes.
  const unused = (from: number) => removeFiles($, h, [], files.slice(from).map(fileName))
  if (born !== generation) return unused(0)
  await ensureDir($, h)
  await unused(ns.length)
  for (const [i, n] of ns.entries()) {
    // Claimed before any wait, so a second capture of this number stops here.
    if (inFlight.has(n)) {
      if (files[i]) await removeFiles($, h, [], [fileName(files[i])])
      continue
    }
    inFlight.add(n)
    // Copies this capture made: a capture that ends without a kept picture
    // (cancelled, cleared, failed, already shown) deletes them and everything under its id.
    const copies: string[] = files[i] ? [files[i]] : []
    let isKept = false
    let id = ''
    try {
      id = `draft-${n}-${await uniqueStamp($)}`
      if ((await read($, images)).some(img => isDraft(img) && img.n === n)) continue
      let file = files[i]
      let source: PeekSource = 'file'
      if (!file) {
        source = 'clipboard'
        const out = join(h, `${id}.png`)
        const grab = await grabClipboard($, h, out)
        const isStale = grab.change !== undefined && grab.change === lastChange
        void probe($, 'clipboard', { n, via, isStale, ...grab, file: grab.file !== undefined })
        if (grab.change !== undefined) lastChange = grab.change
        if (!isStale && grab.file && isImageFile(grab.file)) {
          const [copy] = await copyDropped($, [grab.file])
          if (copy) copies.push(copy)
          file = copy
          source = 'file'
        } else if (!isStale && grab.isSaved) {
          file = out
        } else {
          // No new image on the clipboard: either a file was dropped (the
          // engine turned its path into the placeholder unseen), likely a
          // screenshot saved in the last two minutes, or the same clipboard
          // image was pasted again. A guess either way: the sent bytes replace it.
          const { path: shot, isDenied } = await recentScreenshot($, h, 120_000, usedShots)
          void probe($, 'screenshot', { n, isFound: shot !== undefined, isDenied })
          if (shot) {
            await removeFiles($, h, [id])
            usedShots.add(shot)
            const [copy] = await copyDropped($, [shot])
            if (copy) copies.push(copy)
            file = copy
            source = 'file'
          } else if (grab.isSaved) {
            file = out
          } else if (grab.file && isImageFile(grab.file)) {
            const [copy] = await copyDropped($, [grab.file])
            if (copy) copies.push(copy)
            file = copy
            source = 'file'
          } else if (isDenied && !isDeniedTold) {
            isDeniedTold = true
            $.ui.toast('image-peek: macOS hides dropped screenshots until sent. Paste with Ctrl+V, or give your terminal Full Disk Access.')
          }
        }
      }
      if (!file) {
        $.ui.toast(`Image #${n}: it will show once sent.`)
        continue
      }
      const entry = born === generation ? await finish($, h, { id, n, source, file }) : undefined
      if (!entry) continue
      // The draft may have been sent or edited while the picture was made.
      if (born !== generation || !(await $.prompt.read()).text.includes(`[Image #${n}]`)) continue
      isKept = await setImages($, born, list => [...list.filter(img => !(isDraft(img) && img.n === n)), entry])
      if (!isKept) continue
      await warm($, options, entry)
      if (options.autoOpenPane === true && isFullscreen === true && !isPaneOffered) {
        isPaneOffered = true
        await $.ui.open({ id: PANE, title: 'Images' })
      }
    } finally {
      inFlight.delete(n)
      if (!isKept) await removeFiles($, h, id ? [id] : [], copies.map(fileName))
    }
  }
}

/** Keeps the bytes a stored prompt carried: the pictures exactly as the model got them. */
async function keepPrompt(
  $: $,
  options: PluginOptions,
  born: number,
  content: readonly ApiContentBlock[],
  where: { messageId?: string; idPrefix: string; source: PeekSource; occurrence?: number },
) {
  const blocks = content.filter(b => b.type === 'image')
  if (blocks.length === 0) return
  const text = promptWords(
    content
      .filter(b => b.type === 'text')
      .map(b => String(b.text ?? ''))
      .join('\n'),
  )
  const named = placeholders(text)
  const before = await read($, images)
  if (where.source === 'history') {
    // Already read back on an earlier load, or kept when it was sent: the
    // n-th row of a text is known once n rows of that text were sent here.
    const sentRows = new Set(
      before.filter(img => img.source === 'sent' && img.promptText !== undefined && sameText(img.promptText, text)).map(img => img.messageId),
    )
    if (before.some(img => img.id.startsWith(`${where.idPrefix}-`)) || sentRows.size > (where.occurrence ?? 0)) return
  }
  const h = await host($)
  await ensureDir($, h)

  const kept: PeekImage[] = []
  // Pictures made for a list a /peek clear or a switch got to first.
  const drop = () => removeFiles($, h, kept.map(img => img.id), kept.map(img => fileName(img.path)))
  for (const [i, block] of blocks.entries()) {
    if (born !== generation) return drop()
    const source = block.source as { type?: string; media_type?: string; data?: string } | undefined
    if (source?.type !== 'base64' || typeof source.data !== 'string') continue
    const n = named[i] ?? i + 1
    const ext = (source.media_type ?? 'image/png').split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
    const id = `${where.idPrefix}-${n}`
    const raw = join(h, `${id}.${ext}`)
    const entry = (await writeBase64($, h, source.data, raw))
      ? await finish($, h, { id, n, source: where.source, file: raw, messageId: where.messageId, promptText: text })
      : undefined
    if (entry) kept.push(entry)
    // A failed write or conversion leaves its part-made files; an earlier,
    // listed copy of this row has the same names, so those stay.
    else if (!(await read($, images)).some(img => img.id === id)) await removeFiles($, h, [id])
  }
  void probe($, where.source, { messageId: where.messageId, named, kept: kept.length, chars: text.length })
  if (kept.length === 0) return
  // Replaces what the draft held for this prompt (tagged with its text at
  // submit) and any earlier copy of this row; a draft of the next prompt stays.
  const isMade = await setImages($, born, list => [
    ...list.filter(img => {
      if (where.messageId !== undefined && img.messageId === where.messageId) return false
      return !(img.messageId === undefined && img.source !== 'history' && img.promptText !== undefined && sameText(img.promptText, text))
    }),
    ...kept,
  ])
  if (!isMade) return drop()
  for (const img of kept) await warm($, options, img)
}

/** A resumed session's pictures, read back from the conversation; each user row by its place, so equal texts stay apart. */
async function loadHistory($: $, options: PluginOptions, born: number) {
  const messages = await $.session.messages({ as: 'api' })
  if ('deny' in messages) return
  const withImages = messages
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.role === 'user' && m.content.some(b => b.type === 'image') && !m.content.some(b => b.type === 'tool_result'))
    .slice(-MAX_KEPT)
  const seen = new Map<string, number>()
  for (const { m, index } of withImages) {
    const text = m.content
      .filter(b => b.type === 'text')
      .map(b => String(b.text ?? '').replace(/\s+/g, ' ').trim())
      .join(' ')
    const occurrence = seen.get(text) ?? 0
    seen.set(text, occurrence + 1)
    await keepPrompt($, options, born, m.content, { idPrefix: `hist-${index}`, source: 'history', occurrence })
  }
}

async function pngBytes($: $, path: string) {
  if (!pngCache.has(path)) {
    const { base64 } = await $.fs.read(path, { as: 'bytes' }).catch(() => ({ base64: '' }))
    pngCache.set(path, base64 && (base64.length * 3) / 4 <= MAX_BYTES ? base64 : null)
  }
  return pngCache.get(path) ?? undefined
}

/** One picture at most `columns` x `rows` cells, drawn the way this terminal can; no process runs here. */
async function picture(
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
    const box = rasterSize(size)
    const packed = cells($, img, box)
    if (packed) return <Raster key={`ras-${img.id}-${view}`} {...box} cells={packed} />
    return <Text dimColor>[{alt}…]</Text>
  }
  return <Text dimColor>[{alt}: /peek open {img.n}]</Text>
}

/** Opens the pane the person asked for: it takes the keys, and Escape closes it. */
const openPane = ($: $) => $.ui.open({ id: PANE, title: 'Images', focus: true, closeOnEscape: true })

async function select($: $, img: PeekImage) {
  await update($, selected, () => img.id)
  await openPane($)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'peek',
      description: 'Show pasted images: /peek, /peek N, /peek open N, /peek debug',
      argumentHint: '[N | open N | clear | debug]',
    })
    later($, 'start', async born => {
      await graphics($, options)
      await loadHistory($, options, born)
      await sweepStale($, await host($))
    })
    // Renews the folder's lease while the session lives, so no other
    // session's sweep takes it for abandoned.
    $.clock.every(60 * 60 * 1000, () => {
      void host($).then(h => ensureDir($, h))
    })
    return started
  })

  // No session.start follows a /clear or an in-session /resume: the process
  // goes on under a new id, so the old pictures go and a resumed
  // conversation's are read back here. A real exit shares one short bound
  // with every plugin; what it leaves, the next start sweeps.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    nextGeneration()
    await update($, images, () => [])
    await update($, selected, () => null)
    const old = await hostFor($, e.sessionId)
    if (e.reason === 'clear' || e.reason === 'resume') {
      isPaneOffered = false
      later($, 'switch', async born => {
        await removeDir($, old)
        if (e.reason === 'resume') await loadHistory($, options, born)
      }, 300)
    } else if (old.os !== 'windows' && next.budget.remainingMs > 300) {
      await removeDir($, old)
    }
    return ended
  })

  // A paste or a drop: an "[Image #N]" it leaves in the box is captured from
  // the file the paste named, else from the clipboard.
  on('prompt.edit', async ($, e, next) => {
    const before = placeholders(e.text)
    const paths = imagePaths(e.inputText)
    const box = await next(e)
    const after = placeholders(box.text)
    const added = after.filter(n => !before.includes(n))
    const isPaste = e.key === undefined && e.inputText.length > 1
    if (isPaste || added.length > 0 || paths.length > 0 || e.inputText.includes('[Image #')) {
      void probe($, 'prompt.edit', { chars: e.inputText.length, isKey: e.key !== undefined, added, paths: paths.length })
    }
    if (added.length > 0) {
      // Copied first thing after the edit, before macOS can delete a
      // screenshot's temporary file; on the clock, not on this dispatch.
      later($, 'capture', async born => captureDraft($, options, born, added, 'edit', paths.length > 0 ? await copyDropped($, paths) : []))
    } else if (paths.length > 0) {
      const at = await $.clock.now()
      recentPaths.push(...paths.map(path => ({ path, at })))
    }
    const removed = before.filter(n => !after.includes(n))
    if (removed.length > 0) {
      later($, 'prune', born => setImages($, born, list => list.filter(img => !(isDraft(img) && removed.includes(img.n)))))
    }
    return box
  }).catch(($, e, next) => next(e))

  // The box changed with no edit (an engine insert, a plugin's fill): catch
  // a placeholder the edit hook never saw. A clear drops untagged drafts.
  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    const present = placeholders(e.text)
    if (e.origin.kind === 'clear') {
      later($, 'prune', born => setImages($, born, list => list.filter(img => !(isDraft(img) && !present.includes(img.n)))))
    } else if (present.length > 0 && e.origin.kind !== 'history') {
      void probe($, 'prompt.change', { origin: e.origin.kind, present })
      const list = await read($, images)
      const missing = present.filter(n => !list.some(img => isDraft(img) && img.n === n))
      if (missing.length > 0) {
        const at = await $.clock.now()
        const paths = recentPaths.splice(0).filter(p => at - p.at < 3_000).map(p => p.path)
        const via = `change:${e.origin.kind}`
        later($, 'capture', async born => captureDraft($, options, born, missing, via, paths.length > 0 ? await copyDropped($, paths) : []))
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  // Tags the draft's pictures with the prompt's text before its row draws, so
  // the row finds them even before the stored bytes arrive.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const attached = e.attachments?.filter(a => a.type === 'image') ?? []
    if (attached.length > 0 || e.text.includes('[Image #')) {
      void probe($, 'prompt.submit', {
        chars: e.text.length,
        attachments: attached.map(a => a.mediaType),
      })
      const named = placeholders(e.text)
      await setImages($, generation, list =>
        list.map(img => (isDraft(img) && (named.length === 0 || named.includes(img.n)) ? { ...img, promptText: e.text } : img)),
      )
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (stored.deny === undefined && e.agentId === undefined && e.message.type === 'user' && e.door === 'prompt') {
      const content = stored.message.content
      if (content.some(b => b.type === 'image')) {
        const messageId = stored.uuid
        later($, 'sent', born => keepPrompt($, options, born, content, { messageId, idPrefix: messageId, source: 'sent' }))
      }
    }
    return stored
  }).catch(($, e, next) => next(e))

  // The band above the prompt: a thumbnail for each image in the draft, so a
  // paste shows at once where you type. A click shows it big in the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
    if (e.props.hasSurvey) return next(e)
    const list = await read($, images)
    const drafts = list.filter(isDraft).sort((a, b) => a.n - b.n)
    const canHover = e.surface === 'terminal' && isFullscreen === true
    // Pictures hidden until a chip is hovered: the draft's chips here, and
    // the sent ones' chips in the transcript.
    const hovered = canHover
      ? [...drafts, ...list.filter(img => !isDraft(img)).sort((a, b) => b.addedAt - a.addedAt).slice(0, 12)]
      : []
    if (drafts.length === 0 && hovered.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const label = (img: PeekImage) => (
      <Button key={`draft-${img.id}`} plain onPress={() => select($, img)}>
        <Text color="cyan" hover={{ scope: scopeOf(img), bold: true, underline: true }}>▣ Image {img.n}</Text>
      </Button>
    )
    if (e.surface !== 'terminal') {
      return (
        <Box flexDirection="row" gap={2}>
          {drafts.map(label)}
        </Box>
      )
    }
    // A preview, its title and the chip row fit the band whole: taller, it
    // scrolls, and the chips go out from under the pointer, the hover stuck.
    // With too little room (a small window, a tall prompt, a turn running)
    // a one-line hint stands in for a picture too small to see.
    const room = e.props.maxRows - (drafts.length > 0 ? 1 : 0)
    const bigRows = room - 1
    const hasRoom = bigRows >= MIN_CARD_ROWS
    const previews = hasRoom
      ? await Promise.all(hovered.map(img => picture($, e, options, img, 'card', e.props.bodyColumns - 2, bigRows)))
      : []
    // With no pointer (the main screen) the draft's thumbnails show outright.
    const rows = Math.max(2, Math.min(INLINE.rows, e.props.maxRows - 1))
    const pics = canHover ? [] : await Promise.all(drafts.map(img => picture($, e, options, img, 'inline', INLINE.columns, rows)))
    return (
      <Box flexDirection="column">
        {room >= 1 &&
          hovered.map((img, i) => (
            <Box key={`preview-${img.id}`} flexDirection="column" display="none" hover={{ scope: scopeOf(img), display: 'flex' }}>
              <Text color="cyan" wrap="truncate">
                Image {img.n}
                {hasRoom ? '' : ' · click to open'}
              </Text>
              {hasRoom && previews[i]}
            </Box>
          ))}
        {drafts.length > 0 && (
          <Box flexDirection="row" gap={canHover ? 2 : 3}>
            {drafts.map((img, i) =>
              canHover ? (
                <Box key={`band-${img.id}`} hover={{ scope: scopeOf(img) }}>
                  {label(img)}
                </Box>
              ) : (
                <Box key={`band-${img.id}`} flexDirection="column">
                  {label(img)}
                  {pics[i]}
                </Box>
              ),
            )}
          </Box>
        )}
      </Box>
    )
  })

  // A sent prompt with pictures: a chip per image under it. Fullscreen, the
  // chip shows the picture on hover and opens it in the pane on click; on the
  // main screen (no pointer) small thumbnails are drawn inline instead.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
    if (!e.props.text.includes('[Image #')) return next(e)
    const list = await read($, images)
    const byId = list.filter(img => sameRow(e.requestId, img.messageId))
    const byText = list.filter(img => img.promptText !== undefined && sameText(img.promptText, e.props.text))
    // One picture per number: equal prompt texts share their newest pictures.
    const mine = [...new Map((byId.length > 0 ? byId : byText).sort((a, b) => a.addedAt - b.addedAt).map(img => [img.n, img])).values()]
      .sort((a, b) => a.n - b.n)
    if (await read($, isDebug)) {
      void probe($, 'UserMessage', { requestId: e.requestId, byId: byId.length, matched: mine.length, ids: list.map(img => img.messageId) })
    }
    if (mine.length === 0) return next(e)

    const own = await next(e)
    if (e.surface !== 'terminal') {
      const { Box, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {own}
          <Box flexDirection="row" gap={2}>
            {mine.map(img => (
              <Button key={`peek-${img.id}`} plain label={`▣ Image ${img.n}`} onPress={() => select($, img)} />
            ))}
          </Box>
        </Box>
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    if (e.viewport?.isFullscreen !== true) {
      const thumbs = await Promise.all(mine.map(img => picture($, e, options, img, 'inline', INLINE.columns, INLINE.rows)))
      return (
        <Box flexDirection="column">
          {own}
          <Box flexDirection="row" flexWrap="wrap" gap={2} marginLeft={2}>
            {mine.map((img, i) => (
              <Box key={`thumb-${img.id}`} flexDirection="column">
                <Text dimColor>Image {img.n}</Text>
                {thumbs[i]}
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    // The chip lights its hover scope; the band above the prompt holds the
    // picture for that scope and shows it while the chip is hovered. A card
    // drawn over the transcript would be painted over by the rows after it.
    return (
      <Box flexDirection="column">
        {own}
        <Box flexDirection="row" gap={2} marginLeft={2}>
          {mine.map(img => (
            <Box key={`chip-${img.id}`} hover={{ scope: scopeOf(img) }}>
              <Button key={`peek-${img.id}`} plain onPress={() => select($, img)}>
                <Text color="cyan" hover={{ scope: scopeOf(img), bold: true, underline: true }}>▣ Image {img.n}</Text>
              </Button>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.viewport?.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, images)
    const selectedId = await read($, selected)
    const chosen = list.find(img => img.id === selectedId)
    const columns = Math.max(10, e.props.bodyColumns - 1)
    const rows = Math.max(6, e.props.scroll.bodyRows - 3)
    const closeButton = <Button key="close" label="Close" hotkey="c" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
    // The pane gets the keys on open only over an empty prompt; with a draft
    // they stay there, and Esc and the hotkeys reach the pane once it is focused.
    const keysHint = e.props.isFocused ? 'Esc closes' : 'click here to use keys'

    if (chosen) {
      const big = e.surface === 'terminal' ? await picture($, e, options, chosen, 'big', columns, rows) : undefined
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={2}>
            <Text bold>Image {chosen.n}</Text>
            <Text dimColor>{chosen.source}</Text>
            <Button key="back" label="Back" hotkey="b" onPress={() => update($, selected, () => null)} />
            <Button key="open" label="Open" hotkey="o" onPress={async () => void openExternally($, await host($), chosen.path)} />
            {closeButton}
            <Text dimColor>{keysHint}</Text>
          </Box>
          {big ?? <Text dimColor>{chosen.path}</Text>}
        </Box>
      )
    }

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No images yet.</Text>
          <Text dimColor>Paste one into the prompt (Ctrl+V; Alt+V on Windows) or drop a file.</Text>
        </Box>
      )
    }

    const inPrompt = list.filter(img => img.messageId === undefined && img.source !== 'history')
    const sent = list
      .filter(img => !inPrompt.includes(img))
      .sort((a, b) => b.addedAt - a.addedAt)
      .slice(0, 12)
    const section = async (title: string, items: PeekImage[]) => {
      if (items.length === 0) return []
      const pics = e.surface === 'terminal' ? await Promise.all(items.map(img => picture($, e, options, img, 'pane', columns, 10))) : []
      return [
        <Text key={`title-${title}`} bold>
          {title}
        </Text>,
        ...items.map((img, i) => (
          <Box key={`row-${img.id}`} flexDirection="column" marginBottom={1}>
            <Button key={`sel-${img.id}`} plain onPress={() => select($, img)}>
              <Text color="cyan">▣ Image {img.n}</Text> <Text dimColor>{img.source}</Text>
            </Button>
            {pics[i]}
          </Box>
        )),
      ]
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          {closeButton}
          <Text dimColor>{keysHint}</Text>
        </Box>
        {await section('In your prompt', inPrompt)}
        {await section('Sent', sent)}
      </Box>
    )
  })

  on('command.run', { command: 'peek' }, async ($, e) => {
    const [first, second] = e.args.trim().split(/\s+/).filter(Boolean)
    if (first === 'debug') {
      const isOn = !(await read($, isDebug))
      await update($, isDebug, () => isOn)
      return { text: `Debug lines ${isOn ? 'shown in the transcript' : 'in the debug log only'}.` }
    }
    if (first === 'clear') {
      nextGeneration()
      await setImages($, generation, () => [])
      await update($, selected, () => null)
      return { text: 'Image list cleared.' }
    }
    const list = await read($, images)
    if (first === undefined) {
      await update($, selected, () => null)
      const { isPlaced } = await openPane($)
      return { text: `${list.length} image${list.length === 1 ? '' : 's'}${isPlaced ? '' : ' (no surface draws the pane here)'}.` }
    }
    const isOpen = first === 'open'
    const n = Number(isOpen ? second : first)
    const img = Number.isInteger(n) ? latest(list, n) : undefined
    if (!img) return { text: `No Image #${isOpen ? second ?? '?' : first} yet. Usage: /peek [N | open N | clear | debug]` }
    if (isOpen || (await graphics($, options)) === 'off') {
      const isOpened = await openExternally($, await host($), img.path)
      return { text: isOpened ? `Opened Image #${n} in the system viewer.` : `Could not open ${img.path}.` }
    }
    await select($, img)
    return { text: `Showing Image #${n}.` }
  })
}
