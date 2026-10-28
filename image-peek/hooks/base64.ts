// The module has no Node Buffer, and `Uint8Array.fromBase64` is not in the
// es2023 typings: a small codec of its own.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Uint8Array(128)
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)] ?? 0
    const b = LOOKUP[clean.charCodeAt(i + 1)] ?? 0
    const c = LOOKUP[clean.charCodeAt(i + 2)] ?? 0
    const d = LOOKUP[clean.charCodeAt(i + 3)] ?? 0
    const n = (a << 18) | (b << 12) | (c << 6) | d
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63]! : '='
  }
  return out
}
