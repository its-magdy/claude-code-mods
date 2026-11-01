// The machine beneath the mod, faked at the process seam: the files the
// mod's commands read, write and delete, the clipboard as `osascript` reads
// it, and the environment and session id the engine hands back. What the
// macOS commands do is known here alone; Windows' PowerShell runs succeed and
// are recorded, as do commands this file does not know.

import type { FsStat, On } from 'claude-code'

import { toBase64 } from '../hooks/base64'

export type Clipboard = { change: number; types: string[]; isImage: boolean }

export type Run = { argv: string[]; stdin?: string }

const file = (mtimeMs = 0): FsStat => ({ kind: 'file', size: 1, mtimeMs, isLink: false })

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'))

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
 * A session `sess-1` on macOS (or Windows). On macOS TMPDIR is `/t/` unless
 * `env` names the variables set; on Windows OS and LOCALAPPDATA (`C:\L`) are.
 * `stats` holds what is on disk to begin with, `disk` more files by path, and
 * `desktop` the screenshots on `/Desktop` (HOME unset), saved when the clock
 * started. `sips` succeeds when `isConverting` and its source is there; the
 * header read finds an 800 x 400 PNG in any file that is. `onRun` runs
 * before each process.
 */
export function machine(
  on: On,
  options: {
    os?: 'mac' | 'windows'
    env?: Record<string, string>
    clipboard?: Clipboard
    stats?: Record<string, FsStat>
    disk?: string[]
    desktop?: string[]
    isConverting?: boolean
    onRun?: (argv: readonly string[]) => unknown
  } = {},
) {
  const { os = 'mac', isConverting = true } = options
  const env = options.env ?? (os === 'windows' ? { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\L' } : { TMPDIR: '/t/' })
  const disk = new Map<string, FsStat>(Object.entries(options.stats ?? {}))
  for (const path of options.disk ?? []) disk.set(path, file())
  for (const name of options.desktop ?? []) disk.set(`/Desktop/${name}`, file())
  const runs: Run[] = []
  const writes: { path: string; text: string }[] = []
  const isThere = (path: string) => disk.get(path)?.kind === 'file'

  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: String(e.text) })
    disk.set(e.path, file())
    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: [...disk].filter(([path]) => parentOf(path) === e.path).map(([path, stat]) => ({ name: path.slice(e.path.length + 1), ...stat })),
  }))
  on('fs.stat', (_, e) => {
    const stat = disk.get(e.path)
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
        return ok('Darwin 25.0.0')
      case 'osascript': {
        const { clipboard } = options
        if (clipboard?.isImage) disk.set(argv.at(-1)!, file())
        return ok(JSON.stringify({ change: clipboard?.change, types: clipboard?.types ?? [], isSaved: clipboard?.isImage || undefined }))
      }
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
        return isThere(path) ? ok(pngHead(800, 400)) : ran(1, '', 'no such file')
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
