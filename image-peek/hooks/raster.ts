import { fromBase64, toBase64 } from './base64'

const UPPER_HALF = 0x2580
const DEFAULT_COLOR = 0x01000000

type Pixels = { width: number; height: number; at: (x: number, y: number) => number }

/** Reads an uncompressed 24- or 32-bit BMP (what sips, ImageMagick and .NET write). */
export function readBmp(bytes: Uint8Array): Pixels | undefined {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dataOffset = view.getUint32(10, true)
  const headerSize = view.getUint32(14, true)
  const width = view.getInt32(18, true)
  const rawHeight = view.getInt32(22, true)
  const bpp = view.getUint16(28, true)
  const compression = view.getUint32(30, true)
  if (width <= 0 || rawHeight === 0 || (bpp !== 24 && bpp !== 32)) return undefined
  if (compression !== 0 && compression !== 3 && compression !== 6) return undefined

  const height = Math.abs(rawHeight)
  const isTopDown = rawHeight < 0
  const stride = Math.floor((bpp * width + 31) / 32) * 4
  const hasMasks = compression !== 0 && headerSize >= 40
  const masks = hasMasks
    ? [view.getUint32(54, true), view.getUint32(58, true), view.getUint32(62, true), headerSize >= 56 ? view.getUint32(66, true) : 0]
    : bpp === 32
      ? [0x00ff0000, 0x0000ff00, 0x000000ff, 0]
      : [0, 0, 0, 0]
  const channel = (value: number, mask: number) => {
    if (mask === 0) return 0
    let shift = 0
    while (((mask >>> shift) & 1) === 0) shift++
    const max = mask >>> shift
    return Math.round((((value & mask) >>> shift) * 255) / max)
  }

  return {
    width,
    height,
    at: (x, y) => {
      const row = isTopDown ? y : height - 1 - y
      const i = dataOffset + row * stride + x * (bpp / 8)
      if (i + bpp / 8 > bytes.length) return DEFAULT_COLOR
      if (bpp === 24) return ((bytes[i + 2]! << 16) | (bytes[i + 1]! << 8) | bytes[i]!) >>> 0
      const value = view.getUint32(i, true)
      if (masks[3] && channel(value, masks[3]) < 128) return DEFAULT_COLOR
      return ((channel(value, masks[0]!) << 16) | (channel(value, masks[1]!) << 8) | channel(value, masks[2]!)) >>> 0
    },
  }
}

/**
 * Packs a BMP scaled to `columns` x `rows * 2` pixels into `Raster` cells: one
 * upper half block per cell, the top pixel as foreground, the bottom as
 * background.
 */
export function bmpToCells(base64: string, columns: number, rows: number): string | undefined {
  const pixels = readBmp(fromBase64(base64))
  if (!pixels) return undefined
  const words = new Uint32Array(columns * rows * 3)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const px = Math.min(pixels.width - 1, x)
      const top = pixels.at(px, Math.min(pixels.height - 1, y * 2))
      const bottom = pixels.at(px, Math.min(pixels.height - 1, y * 2 + 1))
      const at = (y * columns + x) * 3
      words[at] = UPPER_HALF
      words[at + 1] = top
      words[at + 2] = bottom
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}
