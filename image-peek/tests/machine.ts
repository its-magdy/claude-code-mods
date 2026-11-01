// The machine beneath the mod, faked at the process seam: the files the
// mod's commands read, write and delete, the clipboard as each OS's tool
// reads it, and the environment and session id the engine hands back. What
// the commands do is known here alone: macOS's tools, Linux's (wl-paste,
// xclip, ImageMagick), Windows' PowerShell, and WSL's wslpath between the
// two. A command this file does not know succeeds and is recorded.

import type { FsStat, On } from 'claude-code'

import { toBase64 } from '../hooks/base64'

export type Clipboard = {
  /** macOS's change counter. */
  change?: number
  types: string[]
  isImage: boolean
  /** A file copied in the file manager, as the OS names it. */
  file?: string
  /** The tool writes old text where the image should be (xclip under Wayland). */
  isGarbled?: boolean
}

type Os = 'mac' | 'windows' | 'linux' | 'wsl'

const UNAME: Record<Os, string> = {
  mac: 'Darwin 25.0.0',
  linux: 'Linux 6.8.0-45-generic',
  wsl: 'Linux 5.15.153.1-microsoft-standard-WSL2',
  windows: '',
}

const ENV: Record<Os, Record<string, string>> = {
  mac: { TMPDIR: '/t/' },
  linux: { XDG_RUNTIME_DIR: '/run/user/1000' },
  wsl: { WSL_DISTRO_NAME: 'Ubuntu', HOME: '/home/me' },
  windows: { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\L' },
}

// WSL's paths as Windows programs name them, as wslpath maps them: a drive
// under /mnt, the distribution's own files under \\wsl.localhost.
const WSL_SHARE = '\\\\wsl.localhost\\Ubuntu'
const toWin = (path: string) => {
  const drive = path.match(/^\/mnt\/([a-z])(\/.*)?$/)
  return drive ? `${drive[1]!.toUpperCase()}:${(drive[2] ?? '\\').replace(/\//g, '\\')}` : `${WSL_SHARE}${path.replace(/\//g, '\\')}`
}
const toLinux = (path: string) => {
  const drive = path.match(/^([A-Za-z]):\\(.*)$/)
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`
  return path.startsWith(`${WSL_SHARE}\\`) ? path.slice(WSL_SHARE.length).replace(/\\/g, '/') : path
}

export type Run = { argv: string[]; stdin?: string }

const file = (mtimeMs = 0): FsStat => ({ kind: 'file', size: 1, mtimeMs, isLink: false })

const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))

// The test runs on POSIX, which reads a Windows path as relative and puts the cwd before it.
const local = (path: string) => (/[A-Za-z]:\\/.test(path) ? path.slice(path.search(/[A-Za-z]:\\/)) : path)

// The paths a PowerShell script names, in order: its single-quoted strings.
const quoted = (script: string) => [...script.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1]!.replace(/''/g, "'"))

const ran = (exitCode: number, stdout = '', stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

// A PNG's first 24 bytes: the signature and the IHDR chunk's width and height.
const pngHead = (width: number, height: number) => {
  const head = new Uint8Array(24)
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(head.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return toBase64(head)
}

/**
 * A session `sess-1` on macOS (or Linux, Windows, WSL). Unless `env` names
 * the variables set, on macOS TMPDIR is `/t/`; on Linux XDG_RUNTIME_DIR is
 * `/run/user/1000` (X, not Wayland); on WSL HOME is `/home/me` in the
 * distribution `Ubuntu`; on Windows OS and LOCALAPPDATA (`C:\L`) are set.
 * `stats` holds what is on disk to begin with, `disk` more files by path, and
 * `desktop` the screenshots on `/Desktop` (HOME unset), saved when the clock
 * started. A conversion (`sips`, ImageMagick's `magick` or, with `magick:
 * 'convert'`, only 6's `convert`, or PowerShell's `$b.Save`) succeeds when
 * `isConverting` and its source is there; the header read finds an 800 x 400
 * PNG in any file that is, save a garbled clipboard's. `onRun` runs before
 * each process.
 */
export function machine(
  on: On,
  options: {
    os?: Os
    env?: Record<string, string>
    magick?: 'magick' | 'convert'
    clipboard?: Clipboard
    stats?: Record<string, FsStat>
    disk?: string[]
    desktop?: string[]
    isConverting?: boolean
    onRun?: (argv: readonly string[]) => unknown
  } = {},
) {
  const { os = 'mac', isConverting = true, magick = 'magick', clipboard } = options
  const env = options.env ?? ENV[os]
  const disk = new Map<string, FsStat>(Object.entries(options.stats ?? {}))
  for (const path of options.disk ?? []) disk.set(path, file())
  for (const name of options.desktop ?? []) disk.set(`/Desktop/${name}`, file())
  const runs: Run[] = []
  const writes: { path: string; text: string }[] = []
  const isThere = (path: string) => disk.get(path)?.kind === 'file'
  /** Files whose bytes are text, not a PNG. */
  const garbled = new Set<string>()
  // PowerShell under WSL names this side's files by their Windows paths.
  const fromPs = os === 'wsl' ? toLinux : (path: string) => path
  const uriList = clipboard?.file ? `file://${encodeURI(clipboard.file)}\n` : ''

  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: String(e.text) })
    disk.set(local(e.path), file())
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const dir = local(e.path)
    return { value: [...disk].filter(([path]) => parentOf(path) === dir).map(([path, stat]) => ({ name: path.slice(dir.length + 1), ...stat })) }
  })
  on('fs.stat', (_, e) => {
    const stat = disk.get(local(e.path))
    if (!stat) throw new Error('ENOENT')
    return { value: stat }
  })
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    runs.push({ argv, stdin: e.init?.stdin })
    await options.onRun?.(argv)
    const ok = (stdout = '') => ran(0, stdout)
    // Each command that reads a file fails, as the real one does, when it is not there.
    switch (argv[0]) {
      case 'uname':
        return ok(UNAME[os])
      case 'osascript': {
        if (clipboard?.file) return ok(JSON.stringify({ change: clipboard.change, types: clipboard.types, file: clipboard.file }))
        if (clipboard?.isImage) disk.set(argv.at(-1)!, file())
        return ok(JSON.stringify({ change: clipboard?.change, types: clipboard?.types ?? [], isSaved: clipboard?.isImage || undefined }))
      }
      case 'wl-paste':
      case 'xclip': {
        const type = argv[0] === 'wl-paste' ? argv.at(-1) : argv[argv.indexOf('-t') + 1]
        if (type === '--list-types' || type === 'TARGETS') return ok((clipboard?.types ?? []).join('\n'))
        return type === 'text/uri-list' ? ok(uriList) : ran(1, '', `no ${type}`)
      }
      case 'magick':
      case 'convert': {
        if (argv[0] !== magick) return ran(127, '', 'command not found')
        if (!isConverting || !isThere(argv[1]!)) return ran(1, '', 'no such file')
        disk.set(argv.at(-1)!.replace(/^[A-Za-z0-9]+:/, ''), file())
        return ok()
      }
      case 'wslpath':
        return ok(`${argv[1] === '-w' ? toWin(argv[2]!) : toLinux(argv[2]!)}\n`)
      case 'sips': {
        if (!isConverting || !isThere(argv[argv.indexOf('--out') - 1]!)) return ran(1, '', 'no such file')
        disk.set(argv.at(-1)!, file())
        return ok()
      }
      case 'sh': {
        const path = argv.at(-1)!
        if (argv[2]?.startsWith('base64 --decode')) {
          disk.set(path, file())
          return ok()
        }
        // The clipboard's PNG, written by wl-paste or xclip.
        if (argv[2]?.includes('image/png')) {
          if (!clipboard?.isImage) return ran(1, '', 'no image/png')
          disk.set(path, file())
          if (clipboard.isGarbled) garbled.add(path)
          return ok()
        }
        if (!isThere(path)) return ran(1, '', 'no such file')
        return ok(garbled.has(path) ? toBase64(new TextEncoder().encode('old clipboard text')) : pngHead(800, 400))
      }
      case 'cp': {
        if (!isThere(argv[1]!)) return ran(1, '', 'no such file')
        disk.set(argv[2]!, file())
        return ok()
      }
      case 'rm': {
        const isDir = argv[1] === '-rf'
        for (const gone of argv.slice(argv.indexOf('--') + 1 || 2)) {
          for (const path of disk.keys()) if (path === gone || (isDir && path.startsWith(`${gone}/`))) disk.delete(path)
        }
        return ok()
      }
      case 'defaults':
        return ran(1, '', 'not set')
      case 'powershell.exe': {
        const script = argv.at(-1)!
        const paths = quoted(script).map(fromPs)
        if (script.includes('GetFileDropList')) {
          if (clipboard?.file) return ok(JSON.stringify({ file: clipboard.file }))
          if (!clipboard?.isImage) return ok('{}')
          disk.set(paths[0]!, file())
          return ok('{"isSaved":true}')
        } else if (script.startsWith('Remove-Item')) {
          const isDir = script.includes(' -Recurse ')
          for (const gone of paths) {
            for (const path of disk.keys()) if (path === gone || (isDir && path.startsWith(`${gone}\\`))) disk.delete(path)
          }
        } else if (script.startsWith('[IO.File]::WriteAllBytes')) {
          disk.set(paths[0]!, file())
        } else if (script.includes('[IO.File]::OpenRead')) {
          return isThere(paths[0]!) ? ok(pngHead(800, 400)) : ran(1, '', 'no such file')
        } else if (script.includes('$b.Save(')) {
          if (!isConverting || !isThere(paths[0]!)) return ran(1, '', 'no such file')
          disk.set(paths.at(-1)!, file())
        }
        return ok()
      }
      default:
        return ok()
    }
  })

  return {
    /** Every process the mod ran, in order. */
    runs,
    /** Every file the mod wrote with `fs.write`, in order. */
    writes,
    /** The names of the files left in `dir`, sorted. */
    left: (dir: string) => [...disk].filter(([path, stat]) => stat.kind === 'file' && parentOf(path) === dir).map(([path]) => path.slice(dir.length + 1)).sort(),
    /** What the mod deleted, by `rm` or PowerShell's `Remove-Item`. */
    removed: () => runs.filter(({ argv }) => argv[0] === 'rm' || argv.at(-1)?.startsWith('Remove-Item')).map(({ argv }) => argv.at(-1)!),
  }
}
