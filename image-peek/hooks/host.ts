// The platform's commands: one adapter per OS, the OS found once per process.
// macOS and Linux use their own tools; Windows uses PowerShell; WSL uses
// Linux's tools for files and Windows' for the clipboard, converting and
// opening, with each path mapped across.

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

/** One OS's commands, bound to the hook's `$`. */
export type Platform = {
  os: Os
  /** A path a Windows program named, as this side names it (WSL maps it; elsewhere the same). */
  localPath(path: string): Promise<string>
  /** Saves the clipboard's image to `out` (a PNG), or names the file it holds. */
  grabClipboard(out: string): Promise<Grab>
  /**
   * Converts any image to a PNG at `out`, fitting it in `max` pixels when given.
   * False where the platform has no converter (Linux without ImageMagick).
   */
  toPng(from: string, out: string, max?: number): Promise<boolean>
  /** Scales an image to exactly `width` x `height` pixels as a BMP, for blocks. */
  toBmp(from: string, out: string, width: number, height: number): Promise<boolean>
  copyFile(from: string, to: string): Promise<boolean>
  /** Writes base64 bytes to `out`, the bytes going in on the decoder's standard input. */
  writeBase64(base64: string, out: string): Promise<boolean>
  /** Lets only this user into the folder and its parent (POSIX; Windows' per-user folder already is). */
  makePrivate(dir: string): Promise<void>
  removeFiles(paths: readonly string[]): Promise<void>
  removeDir(dir: string): Promise<void>
  /** The file's first 32 bytes, read by a process: `$.fs.read` would copy the whole file (and refuses past 4 MiB). */
  readHead(path: string): Promise<Uint8Array | undefined>
  /** Opens the file in the platform's viewer (Preview on macOS). */
  openExternally(path: string): Promise<boolean>
  /**
   * The newest screenshot saved in the last `withinMs` (macOS only). A file
   * dropped into the prompt reaches the engine without passing `prompt.edit`,
   * so this is how the draft finds it.
   */
  recentScreenshot(withinMs: number, skip: ReadonlySet<string>): Promise<{ path?: string; isDenied: boolean }>
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i

export const isImageFile = (path: string) => IMAGE_FILE.test(path)

let detected: Os | undefined

/** This machine's OS, found once. */
export async function osOf($: $): Promise<Os> {
  if (detected) return detected
  if ((await $.env.get('OS')) === 'Windows_NT') {
    detected = 'windows'
  } else {
    const uname = await run($, ['uname', '-sr'])
    detected = /darwin/i.test(uname.stdout)
      ? 'mac'
      : /microsoft/i.test(uname.stdout) || (await $.env.get('WSL_DISTRO_NAME'))
        ? 'wsl'
        : 'linux'
  }
  return detected
}

/** The adapter for this machine's OS. */
export async function platform($: $): Promise<Platform> {
  switch (await osOf($)) {
    case 'mac':
      return mac($)
    case 'windows':
      return windows($)
    case 'wsl':
      return wsl($)
    case 'linux':
      return linux($)
  }
}

/** Whether the file starts with the PNG signature. */
export async function isPng(p: Platform, path: string) {
  const head = await p.readHead(path)
  return head !== undefined && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
}

/** A PNG's width and height from its header, or zeros. */
export async function pngSize(p: Platform, path: string) {
  const head = await p.readHead(path)
  if (!head || head.length < 24) return { width: 0, height: 0 }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
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

const parse = (text: string): Grab => {
  try {
    return JSON.parse(text.trim() || '{}') as Grab
  } catch {
    return { error: text.slice(0, 200) }
  }
}

const same = async (path: string) => path

const noScreenshot = async () => ({ isDenied: false })

/** File commands with the POSIX tools: macOS, Linux, and WSL's side. */
function posixFiles($: $): Pick<Platform, 'makePrivate' | 'copyFile' | 'writeBase64' | 'removeFiles' | 'removeDir' | 'readHead'> {
  return {
    makePrivate: async dir => {
      await run($, ['chmod', '700', dir.slice(0, dir.lastIndexOf('/')), dir])
    },
    copyFile: async (from, to) => (await run($, ['cp', from, to])).exitCode === 0,
    writeBase64: async (base64, out) => (await run($, ['sh', '-c', 'base64 --decode > "$1"', 'sh', out], base64)).exitCode === 0,
    removeFiles: async paths => {
      await run($, ['rm', '-f', '--', ...paths])
    },
    removeDir: async dir => {
      await run($, ['rm', '-rf', dir])
    },
    readHead: async path => headOf(await run($, ['sh', '-c', 'head -c 32 "$1" | base64', 'sh', path])),
  }
}

const headOf = (r: { exitCode: number; stdout: string }) =>
  r.exitCode === 0 && r.stdout.trim() ? fromBase64(r.stdout.trim()) : undefined

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

function mac($: $): Platform {
  return {
    os: 'mac',
    ...posixFiles($),
    localPath: same,
    grabClipboard: async out => {
      const r = await run($, ['osascript', '-l', 'JavaScript', '-e', MAC_GRAB, out])
      return r.exitCode === 0 ? parse(r.stdout) : { error: r.stderr.trim() }
    },
    toPng: async (from, out, max) => {
      const fit = max ? ['-Z', String(max)] : []
      return (await run($, ['sips', ...fit, '-s', 'format', 'png', from, '--out', out])).exitCode === 0
    },
    toBmp: async (from, out, width, height) =>
      (await run($, ['sips', '-z', String(height), String(width), '-s', 'format', 'bmp', from, '--out', out])).exitCode === 0,
    openExternally: async path => (await run($, ['open', path])).exitCode === 0,
    recentScreenshot: (withinMs, skip) => macScreenshot($, withinMs, skip),
  }
}

/**
 * From the folder screenshots go to (Desktop unless set otherwise) or the
 * temporary folder its floating thumbnail is dragged from.
 */
async function macScreenshot($: $, withinMs: number, skip: ReadonlySet<string>) {
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

function linux($: $): Platform {
  const p: Platform = {
    os: 'linux',
    ...posixFiles($),
    localPath: same,
    grabClipboard: out => linuxGrab($, p, out),
    toPng: async (from, out, max) => {
      const resize = max ? ['-resize', `${max}x${max}>`] : []
      return magick($, [from, ...resize, `png:${out}`])
    },
    toBmp: (from, out, width, height) => magick($, [from, '-resize', `${width}x${height}!`, `BMP3:${out}`]),
    openExternally: async path => (await run($, ['xdg-open', path])).exitCode === 0,
    recentScreenshot: noScreenshot,
  }
  return p
}

/** ImageMagick 7's `magick`, else 6's `convert`. */
async function magick($: $, args: string[]) {
  for (const tool of ['magick', 'convert']) {
    if ((await run($, [tool, ...args])).exitCode === 0) return true
  }
  return false
}

async function linuxGrab($: $, p: Platform, out: string): Promise<Grab> {
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
  return { types, isSaved: r.exitCode === 0 && (await isPng(p, out)) }
}

function windows($: $): Platform {
  return {
    os: 'windows',
    ...windowsImages($, same, same),
    localPath: same,
    makePrivate: async () => {},
    copyFile: async (from, to) =>
      (await powershell($, `Copy-Item -LiteralPath ${quotePs(from)} -Destination ${quotePs(to)}`)).exitCode === 0,
    writeBase64: async (base64, out) =>
      (await powershell($, `[IO.File]::WriteAllBytes(${quotePs(out)}, [Convert]::FromBase64String([Console]::In.ReadToEnd()))`, base64))
        .exitCode === 0,
    removeFiles: async paths => {
      await powershell($, `Remove-Item -LiteralPath ${paths.map(quotePs).join(', ')} -Force -ErrorAction SilentlyContinue`)
    },
    removeDir: async dir => {
      await powershell($, `Remove-Item -LiteralPath ${quotePs(dir)} -Recurse -Force -ErrorAction SilentlyContinue`)
    },
    readHead: async path =>
      headOf(await powershell($, `$b = New-Object byte[] 32; $f = [IO.File]::OpenRead(${quotePs(path)}); $n = $f.Read($b, 0, 32); $f.Close(); [Convert]::ToBase64String($b, 0, $n)`)),
    openExternally: async path =>
      (await run($, ['powershell.exe', '-NoProfile', '-Command', `Start-Process -FilePath ${quotePs(path)}`])).exitCode === 0,
    recentScreenshot: noScreenshot,
  }
}

function wsl($: $): Platform {
  const toWin = (path: string) => winPath($, path)
  const toLinux = (path: string) => linuxPath($, path)
  return {
    os: 'wsl',
    ...posixFiles($),
    ...windowsImages($, toWin, toLinux),
    localPath: toLinux,
    openExternally: async path => {
      await run($, ['explorer.exe', await toWin(path)])
      // explorer.exe exits 1 even when it opened the file.
      return true
    },
    recentScreenshot: noScreenshot,
  }
}

/** A WSL path as Windows programs name it; the folder is converted, since wslpath fails on a file not there yet. */
async function winPath($: $, path: string) {
  const cut = path.lastIndexOf('/')
  const { stdout } = await run($, ['wslpath', '-w', path.slice(0, cut) || '/'])
  const folder = stdout.trim()
  return folder ? `${folder.replace(/\\$/, '')}\\${path.slice(cut + 1)}` : path
}

async function linuxPath($: $, path: string) {
  if (!/^[A-Za-z]:\\/.test(path)) return path
  const { stdout } = await run($, ['wslpath', '-u', path])
  return stdout.trim() || path
}

type PathMap = (path: string) => Promise<string>

const winGrab = (out: string) => `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$files = [Windows.Forms.Clipboard]::GetFileDropList()
if ($files.Count -gt 0) { @{ file = $files[0] } | ConvertTo-Json -Compress; exit }
$img = [Windows.Forms.Clipboard]::GetImage()
if ($img) { $img.Save(${quotePs(out)}, [Drawing.Imaging.ImageFormat]::Png); '{"isSaved":true}' } else { '{}' }`

/** The clipboard and converting through PowerShell: Windows, and WSL with its paths mapped. */
function windowsImages($: $, toWin: PathMap, toLocal: PathMap): Pick<Platform, 'grabClipboard' | 'toPng' | 'toBmp'> {
  return {
    grabClipboard: async out => {
      const r = await powershell($, winGrab(await toWin(out)))
      const grab = r.exitCode === 0 ? parse(r.stdout) : { error: r.stderr.trim() }
      if (grab.file) grab.file = await toLocal(grab.file)
      return grab
    },
    toPng: (from, out, max) => psResize($, toWin, from, out, max, 'Png'),
    toBmp: (from, out, width, height) => psResize($, toWin, from, out, undefined, 'Bmp', width, height),
  }
}

async function psResize($: $, toWin: PathMap, from: string, out: string, max: number | undefined, format: 'Png' | 'Bmp', width?: number, height?: number) {
  const src = quotePs(await toWin(from))
  const dst = quotePs(await toWin(out))
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
