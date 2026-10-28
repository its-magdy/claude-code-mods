import type { EngineInterface } from 'claude-code'

import { fromBase64 } from './base64'

type $ = EngineInterface

export type Os = 'mac' | 'linux' | 'windows' | 'wsl'

export type Host = { os: Os; dir: string }

/** What the clipboard held when we looked. */
export type Grab = {
  /** A file the clipboard names (Finder's or Explorer's copy). */
  file?: string
  /** True when an image was written to the requested path. */
  isSaved?: boolean
  /** The clipboard's change counter, where the platform has one. */
  change?: number
  types?: string[]
  error?: string
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i

export const isImageFile = (path: string) => IMAGE_FILE.test(path)

let os: Os | undefined
const cached = new Map<string, Host>()

/**
 * The platform and this session's folder for pictures. Per session id, since
 * a /clear starts a new one. A folder only this user reads: macOS's TMPDIR is
 * per user; on Linux the runtime dir or ~/.cache, never the shared /tmp.
 */
export async function host($: $): Promise<Host> {
  return hostFor($, await $.session.id())
}

/** The same for a session named by id: an ending session's, after the process moved on. */
export async function hostFor($: $, sessionId: string): Promise<Host> {
  const session = sessionId.replace(/[^A-Za-z0-9_-]/g, '') || 'unnamed'
  const known = cached.get(session)
  if (known) return known
  if (!os) {
    if ((await $.env.get('OS')) === 'Windows_NT') {
      os = 'windows'
    } else {
      const uname = await run($, ['uname', '-sr'])
      os = /darwin/i.test(uname.stdout)
        ? 'mac'
        : /microsoft/i.test(uname.stdout) || (await $.env.get('WSL_DISTRO_NAME'))
          ? 'wsl'
          : 'linux'
    }
  }
  let root: string
  if (os === 'windows') {
    root = `${(await $.env.get('LOCALAPPDATA')) ?? (await $.env.get('TEMP')) ?? 'C:\\Windows\\Temp'}\\claude-image-peek`
  } else if (os === 'mac') {
    root = `${((await $.env.get('TMPDIR')) ?? `${(await $.env.get('HOME')) ?? ''}/Library/Caches`).replace(/\/+$/, '')}/claude-image-peek`
  } else {
    const runtime = await $.env.get('XDG_RUNTIME_DIR')
    root = runtime ? `${runtime}/claude-image-peek` : `${(await $.env.get('HOME')) ?? '/tmp'}/.cache/claude-image-peek`
  }
  const h: Host = { os, dir: `${root}${os === 'windows' ? '\\' : '/'}${session}` }
  cached.set(session, h)
  return h
}

export const join = (h: Host, name: string) =>
  `${h.dir}${h.os === 'windows' ? '\\' : '/'}${name}`

const LEASE = '.lease'
const made = new Set<string>()

/**
 * Makes the session's folder (`$.fs.write` creates the directories),
 * readable by this user alone, and renews its lease: the file whose age tells
 * another session's sweep this folder is still in use.
 */
export async function ensureDir($: $, h: Host) {
  await $.fs.write(join(h, LEASE), String(await $.clock.now()))
  if (made.has(h.dir)) return
  if (h.os !== 'windows') {
    await run($, ['chmod', '700', h.dir.slice(0, h.dir.lastIndexOf('/')), h.dir])
  }
  made.add(h.dir)
}

/** Deletes files of the session's folder whose names start with one of the ids, or are named in `exact`. */
export async function removeFiles($: $, h: Host, ids: readonly string[], exact: readonly string[] = []) {
  if (ids.length === 0 && exact.length === 0) return
  const names = (await $.fs.list(h.dir).catch(() => [])).map(entry => entry.name)
  const doomed = names.filter(
    name => exact.includes(name) || ids.some(id => name.startsWith(`${id}.`) || name.startsWith(`${id}-`)),
  )
  if (doomed.length === 0) return
  const paths = doomed.map(name => join(h, name))
  if (h.os === 'windows') {
    await powershell($, `Remove-Item -LiteralPath ${paths.map(quotePs).join(', ')} -Force -ErrorAction SilentlyContinue`)
  } else {
    await run($, ['rm', '-f', '--', ...paths])
  }
}

async function run($: $, argv: string[], stdin?: string) {
  try {
    return await $.process.run(argv, { stdin, timeoutMs: 15_000 })
  } catch (error) {
    return { exitCode: 127, stdout: '', stderr: String(error) }
  }
}

const quotePs = (s: string) => `'${s.replace(/'/g, "''")}'`

const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-Command']

async function powershell($: $, script: string, stdin?: string) {
  return run($, [...POWERSHELL, script], stdin)
}

/** A WSL path as Windows programs name it; the folder is converted, since wslpath fails on a file not there yet. */
async function winPath($: $, h: Host, path: string) {
  if (h.os !== 'wsl') return path
  const cut = path.lastIndexOf('/')
  const { stdout } = await run($, ['wslpath', '-w', path.slice(0, cut) || '/'])
  const folder = stdout.trim()
  return folder ? `${folder.replace(/\\$/, '')}\\${path.slice(cut + 1)}` : path
}

export async function linuxPath($: $, h: Host, path: string) {
  if (h.os !== 'wsl' || !/^[A-Za-z]:\\/.test(path)) return path
  const { stdout } = await run($, ['wslpath', '-u', path])
  return stdout.trim() || path
}

// JXA: reads the general pasteboard; a file URL first (a Finder copy carries
// the file's icon as TIFF too, which is not the picture), then PNG, then TIFF.
const MAC_GRAB = `ObjC.import('AppKit')
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard
  const res = { change: Number(pb.changeCount), types: ObjC.deepUnwrap(pb.types) || [] }
  const url = pb.stringForType('public.file-url')
  if (!url.isNil()) { res.file = ObjC.unwrap($.NSURL.URLWithString(url).path); return JSON.stringify(res) }
  let data = pb.dataForType('public.png')
  if (data.isNil()) {
    const tiff = pb.dataForType('public.tiff')
    if (!tiff.isNil()) data = $.NSBitmapImageRep.imageRepWithData(tiff)
      .representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary)
  }
  if (!data.isNil()) res.isSaved = data.writeToFileAtomically(argv[0], true)
  return JSON.stringify(res)
}`

const winGrab = (out: string) => `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$files = [Windows.Forms.Clipboard]::GetFileDropList()
if ($files.Count -gt 0) { @{ file = $files[0] } | ConvertTo-Json -Compress; exit }
$img = [Windows.Forms.Clipboard]::GetImage()
if ($img) { $img.Save(${quotePs(out)}, [Drawing.Imaging.ImageFormat]::Png); '{"isSaved":true}' } else { '{}' }`

const parse = (text: string): Grab => {
  try {
    return JSON.parse(text.trim() || '{}') as Grab
  } catch {
    return { error: text.slice(0, 200) }
  }
}

/** Saves the clipboard's image to `out` (a PNG), or names the file it holds. */
export async function grabClipboard($: $, h: Host, out: string): Promise<Grab> {
  if (h.os === 'mac') {
    const r = await run($, ['osascript', '-l', 'JavaScript', '-e', MAC_GRAB, out])
    return r.exitCode === 0 ? parse(r.stdout) : { error: r.stderr.trim() }
  }
  if (h.os === 'windows' || h.os === 'wsl') {
    const r = await powershell($, winGrab(await winPath($, h, out)))
    const grab = r.exitCode === 0 ? parse(r.stdout) : { error: r.stderr.trim() }
    if (grab.file) grab.file = await linuxPath($, h, grab.file)
    return grab
  }
  return grabLinux($, out)
}

async function grabLinux($: $, out: string): Promise<Grab> {
  const isWayland = Boolean(await $.env.get('WAYLAND_DISPLAY'))
  const list = isWayland
    ? await run($, ['wl-paste', '--list-types'])
    : await run($, ['xclip', '-selection', 'clipboard', '-t', 'TARGETS', '-o'])
  if (list.exitCode !== 0) {
    return { error: `${isWayland ? 'wl-paste' : 'xclip'} is not installed or failed: ${list.stderr.trim()}` }
  }
  const types = list.stdout.split('\n').map(t => t.trim()).filter(Boolean)
  const read = (type: string) =>
    isWayland ? ['wl-paste', '--no-newline', '--type', type] : ['xclip', '-selection', 'clipboard', '-t', type, '-o']
  if (types.includes('text/uri-list')) {
    const uris = await run($, read('text/uri-list'))
    const first = uris.stdout.split('\n').find(line => line.startsWith('file://'))
    if (first) return { types, file: decodeURIComponent(first.trim().slice('file://'.length)) }
  }
  if (!types.includes('image/png')) return { types }
  // Binary output cannot cross as text: the shell writes it to the file.
  const argv = read('image/png').map(a => `'${a}'`).join(' ')
  const r = await run($, ['sh', '-c', `${argv} > "$1"`, 'sh', out])
  // xclip under Wayland can hand back old text and still exit 0: check the bytes.
  return { types, isSaved: r.exitCode === 0 && (await isPng($, out)) }
}

/** Whether the file starts with the PNG signature. */
export async function isPng($: $, path: string) {
  const head = await readHead($, path)
  return head !== undefined && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
}

/** The file's first 32 bytes, read by a process: `$.fs.read` would copy the whole file (and refuses past 4 MiB). */
async function readHead($: $, path: string) {
  const h = await host($)
  const r =
    h.os === 'windows'
      ? await powershell($, `$b = New-Object byte[] 32; $f = [IO.File]::OpenRead(${quotePs(path)}); $n = $f.Read($b, 0, 32); $f.Close(); [Convert]::ToBase64String($b, 0, $n)`)
      : await run($, ['sh', '-c', 'head -c 32 "$1" | base64', 'sh', path])
  return r.exitCode === 0 && r.stdout.trim() ? fromBase64(r.stdout.trim()) : undefined
}

/** A PNG's width and height from its header, or zeros. */
export async function pngSize($: $, path: string) {
  const head = await readHead($, path)
  if (!head || head.length < 24) return { width: 0, height: 0 }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** The command that writes base64 bytes to `out`, the bytes going in on its standard input. */
export function writeBase64Command(h: Host, base64: string, out: string): { argv: string[]; stdin: string } {
  return h.os === 'windows'
    ? { argv: [...POWERSHELL, `[IO.File]::WriteAllBytes(${quotePs(out)}, [Convert]::FromBase64String([Console]::In.ReadToEnd()))`], stdin: base64 }
    : { argv: ['sh', '-c', 'base64 --decode > "$1"', 'sh', out], stdin: base64 }
}

/** Writes base64 bytes to `out`. */
export async function writeBase64($: $, h: Host, base64: string, out: string) {
  const { argv, stdin } = writeBase64Command(h, base64, out)
  return (await run($, argv, stdin)).exitCode === 0
}

export async function copyFile($: $, h: Host, from: string, to: string) {
  const r =
    h.os === 'windows'
      ? await powershell($, `Copy-Item -LiteralPath ${quotePs(from)} -Destination ${quotePs(to)}`)
      : await run($, ['cp', from, to])
  return r.exitCode === 0
}

/**
 * Converts any image to a PNG at `out`, fitting it in `max` pixels when given.
 * False where the platform has no converter (Linux without ImageMagick).
 */
export async function toPng($: $, h: Host, from: string, out: string, max?: number) {
  if (h.os === 'mac') {
    const fit = max ? ['-Z', String(max)] : []
    return (await run($, ['sips', ...fit, '-s', 'format', 'png', from, '--out', out])).exitCode === 0
  }
  if (h.os === 'windows' || h.os === 'wsl') {
    return psResize($, h, from, out, max, 'Png')
  }
  const resize = max ? ['-resize', `${max}x${max}>`] : []
  for (const magick of ['magick', 'convert']) {
    if ((await run($, [magick, from, ...resize, `png:${out}`])).exitCode === 0) return true
  }
  return false
}

/** Scales an image to exactly `width` x `height` pixels as a BMP, for blocks. */
export async function toBmp($: $, h: Host, from: string, out: string, width: number, height: number) {
  if (h.os === 'mac') {
    const r = await run($, ['sips', '-z', String(height), String(width), '-s', 'format', 'bmp', from, '--out', out])
    return r.exitCode === 0
  }
  if (h.os === 'windows' || h.os === 'wsl') {
    return psResize($, h, from, out, undefined, 'Bmp', width, height)
  }
  for (const magick of ['magick', 'convert']) {
    if ((await run($, [magick, from, '-resize', `${width}x${height}!`, `BMP3:${out}`])).exitCode === 0) return true
  }
  return false
}

async function psResize($: $, h: Host, from: string, out: string, max: number | undefined, format: 'Png' | 'Bmp', width?: number, height?: number) {
  const src = quotePs(await winPath($, h, from))
  const dst = quotePs(await winPath($, h, out))
  const size =
    width && height
      ? `$w = ${width}; $ht = ${height}`
      : `$s = [Math]::Min(1.0, ${max ?? 1e9} / [Math]::Max($i.Width, $i.Height)); $w = [int]($i.Width * $s); $ht = [int]($i.Height * $s)`
  const script = `Add-Type -AssemblyName System.Drawing
$i = [Drawing.Image]::FromFile(${src})
${size}
$b = New-Object Drawing.Bitmap $i, (New-Object Drawing.Size $w, $ht)
$b.Save(${dst}, [Drawing.Imaging.ImageFormat]::${format}); $b.Dispose(); $i.Dispose()`
  return (await powershell($, script)).exitCode === 0
}

/**
 * The newest screenshot macOS saved in the last `withinMs`: from the folder
 * screenshots go to (Desktop unless set otherwise) or the temporary folder its
 * floating thumbnail is dragged from. A file dropped into the prompt reaches
 * the engine without passing `prompt.edit`, so this is how the draft finds it.
 */
export async function recentScreenshot(
  $: $,
  h: Host,
  withinMs: number,
  skip: ReadonlySet<string>,
): Promise<{ path?: string; isDenied: boolean }> {
  if (h.os !== 'mac') return { isDenied: false }
  let isDenied = false
  // macOS refuses to list Desktop and the temporary folder to a terminal
  // without Full Disk Access (or Files and Folders access).
  const list = (path: string) =>
    $.fs.list(path).catch((error: unknown) => {
      if (/EPERM|EACCES/.test(String(error))) isDenied = true
      return []
    })
  const home = (await $.env.get('HOME')) ?? ''
  const set = await run($, ['defaults', 'read', 'com.apple.screencapture', 'location'])
  const folders = [set.exitCode === 0 && set.stdout.trim() ? set.stdout.trim().replace(/^~/, home) : `${home}/Desktop`]
  const temp = (await $.env.get('TMPDIR'))?.replace(/\/+$/, '')
  if (temp) {
    const items = `${temp}/TemporaryItems`
    for (const entry of await list(items)) {
      if (entry.kind === 'dir' && entry.name.startsWith('NSIRD_screencaptureui')) folders.push(`${items}/${entry.name}`)
    }
  }
  const now = await $.clock.now()
  let best: { path: string; mtimeMs: number } | undefined
  for (const folder of folders) {
    for (const entry of await list(folder)) {
      const path = `${folder}/${entry.name}`
      if (entry.kind !== 'file' || !isImageFile(entry.name) || skip.has(path) || now - entry.mtimeMs > withinMs) continue
      if (!best || entry.mtimeMs > best.mtimeMs) best = { path, mtimeMs: entry.mtimeMs }
    }
  }
  return { path: best?.path, isDenied }
}

/** Opens the file in the platform's viewer (Preview on macOS). */
export async function openExternally($: $, h: Host, path: string) {
  const argv =
    h.os === 'mac'
      ? ['open', path]
      : h.os === 'windows'
        ? ['powershell.exe', '-NoProfile', '-Command', `Start-Process -FilePath ${quotePs(path)}`]
        : h.os === 'wsl'
          ? ['explorer.exe', await winPath($, h, path)]
          : ['xdg-open', path]
  const r = await run($, argv)
  // explorer.exe exits 1 even when it opened the file.
  return r.exitCode === 0 || h.os === 'wsl'
}

/**
 * Deletes other sessions' folders left behind (an exit too quick to clean up,
 * a crash): those whose lease no live session has renewed for a day. A
 * running session renews its lease every hour, idle or not.
 */
export async function sweepStale($: $, h: Host) {
  const sep = h.os === 'windows' ? '\\' : '/'
  const root = h.dir.slice(0, h.dir.lastIndexOf(sep))
  const now = await $.clock.now()
  const entries = await $.fs.list(root).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'dir' || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue
    const dir = `${root}${sep}${entry.name}`
    if (dir === h.dir) continue
    const lease = await $.fs.stat(`${dir}${sep}${LEASE}`).catch(() => undefined)
    const stat = lease ?? (await $.fs.stat(dir).catch(() => undefined))
    if (stat && now - stat.mtimeMs > 24 * 60 * 60 * 1000) await removeDir($, { os: h.os, dir })
  }
}

/** Deletes the session's folder of pictures. */
export async function removeDir($: $, h: Host) {
  // Only ever a session's own folder under ours: never the parent, never empty.
  if (!/claude-image-peek[\\/][A-Za-z0-9_-]+$/.test(h.dir)) return
  made.delete(h.dir)
  if (h.os === 'windows') {
    await powershell($, `Remove-Item -LiteralPath ${quotePs(h.dir)} -Recurse -Force -ErrorAction SilentlyContinue`)
  } else {
    await run($, ['rm', '-rf', h.dir])
  }
}

/**
 * The image files a paste names: paths as a terminal types them for a drop
 * (`/a/b\ c.png`, `'/a/b c.png'`, `file:///a/b%20c.png`), one or several.
 */
export function imagePaths(text: string): string[] {
  // Split on ASCII whitespace only: macOS names a screenshot "… at 8.31.06\u202fPM.png",
  // and that narrow no-break space is whitespace to `\s`.
  const tokens = text.trim().match(/'[^']+'|"[^"]+"|(?:\\.|[^ \t\r\n\\])+/g) ?? []
  return tokens
    .map(token => {
      // A Windows path keeps its backslashes; elsewhere they escape a space.
      const bare = /^['"]/.test(token)
        ? token.slice(1, -1)
        : /^[A-Za-z]:\\/.test(token)
          ? token
          : token.replace(/\\(.)/g, '$1')
      return bare.startsWith('file://') ? decodeURIComponent(bare.slice('file://'.length)) : bare
    })
    .filter(path => /^(\/|~\/|[A-Za-z]:\\)/.test(path) && isImageFile(path))
}
