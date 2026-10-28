import type { On, PromptChangeInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { PeekImage } from '../types'
import { toBase64 } from '../hooks/base64'

// A macOS session with no terminal of its own: TMPDIR and HOME unset put the
// session's folder here.
const DIR = '/Library/Caches/claude-image-peek/test-session'
const name = (path: string) => path.slice(path.lastIndexOf('/') + 1)

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
 * Raises `prompt.change` as the engine does when it puts a placeholder in the
 * box itself. The kit dispatches it through every hook, though the type of
 * its `$` lists only the calls a plugin can make.
 */
const promptChange = ($: Parameters<TestBody>[0], e: PromptChangeInput) =>
  ($.prompt as unknown as { change: (e: PromptChangeInput) => Promise<unknown> }).change(e)

const ran = (exitCode: number, stdout = '', stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

type Clipboard = { change: number; types: string[]; isImage: boolean }

/**
 * The world beneath the mod for a capture: stored values in memory, a
 * session folder the processes write to and `rm` empties, the clipboard as
 * `osascript` reads it, the prompt box, and the screenshots on the Desktop
 * (HOME unset: `/Desktop`), saved when the clock started.
 */
function world(
  on: On,
  options: { clipboard: Clipboard; prompt: string; desktop?: string[]; onRun?: (argv: readonly string[]) => void },
) {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  const files = new Set<string>()
  const toasts: string[] = []
  let prompt = options.prompt
  let version = 0
  on('state.get', (_, e) => ({ value: { value: stored.get(e.key), version } }))
  on('state.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: { isSet: true, version: ++version } }
  })
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('prompt.read', () => ({ value: { text: prompt, cursor: prompt.length } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('fs.write', (_, e) => {
    if (e.path.startsWith(`${DIR}/`)) files.add(name(e.path))
    return { value: undefined }
  })
  const entry = (file: string) => ({ name: file, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })
  on('fs.list', (_, e) => ({
    value: e.path === DIR ? [...files].map(entry) : e.path === '/Desktop' ? (options.desktop ?? []).map(entry) : [],
  }))
  on('process.run', (_, e) => {
    const argv = e.argv
    options.onRun?.(argv)
    const ok = (stdout = '') => ran(0, stdout)
    switch (argv[0]) {
      case 'uname':
        return ok('Darwin 25.0.0')
      case 'osascript': {
        const { clipboard } = options
        if (clipboard.isImage) files.add(name(argv.at(-1)!))
        return ok(JSON.stringify({ change: clipboard.change, types: clipboard.types, isSaved: clipboard.isImage || undefined }))
      }
      // Each reads a file of the folder, and fails as the real one does when it is not there.
      case 'sips': {
        const from = argv[argv.indexOf('--out') - 1]!
        if (!from.startsWith(`${DIR}/`) || !files.has(name(from))) return ran(1, '', 'no such file')
        files.add(name(argv.at(-1)!))
        return ok()
      }
      case 'sh': {
        const path = argv.at(-1)!
        return path.startsWith(`${DIR}/`) && files.has(name(path)) ? ok(pngHead(800, 400)) : ran(1, '', 'no such file')
      }
      case 'cp': {
        const [from, to] = [argv[1]!, argv[2]!]
        const isThere = from.startsWith(`${DIR}/`) ? files.has(name(from)) : (options.desktop ?? []).some(file => from === `/Desktop/${file}`)
        if (!isThere || !to.startsWith(`${DIR}/`)) return ran(1, '', 'no such file')
        files.add(name(to))
        return ok()
      }
      case 'rm':
        for (const path of argv.slice(argv.indexOf('--') + 1)) files.delete(name(path))
        return ok()
      case 'defaults':
        return ran(1, '', 'not set')
      default:
        return ok()
    }
  })
  const list = () => ((stored.get('images') as { value?: PeekImage[] } | undefined)?.value ?? []) as PeekImage[]
  return {
    clock,
    files,
    toasts,
    list,
    setPrompt: (text: string) => {
      prompt = text
    },
  }
}

const PNG_CLIPBOARD: Clipboard = { change: 7, types: ['public.png'], isImage: true }

test('a placeholder the engine put in is captured from the clipboard and shows in the band', { options: { graphics: 'off' } }, async ($, on) => {
  const w = world(on, { clipboard: PNG_CLIPBOARD, prompt: '[Image #1]' })
  await promptChange($, { text: '[Image #1]', cursor: 10, origin: { kind: 'engine' } })
  await w.clock.settle()

  const [img] = w.list()
  expect(w.list()).toHaveLength(1)
  expect([img?.n, img?.source, img?.width, img?.height]).toEqual([1, 'clipboard', 800, 400])
  expect([...w.files].sort()).toEqual(['.lease', `${img!.id}.png`, `${img!.id}.small.png`, `${img!.id}.thumb.png`])

  const band = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'desktop',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ key: `draft-${img!.id}` })).toBeDefined()
  await band.unmount()
})

test('with no image on the clipboard and no recent screenshot, the placeholder waits for the send', async ($, on) => {
  const w = world(on, { clipboard: { change: 8, types: ['public.utf8-plain-text'], isImage: false }, prompt: '[Image #1]' })
  await promptChange($, { text: '[Image #1]', cursor: 10, origin: { kind: 'engine' } })
  await w.clock.settle()

  expect(w.list()).toEqual([])
  expect(w.toasts).toContain('Image #1: it will show once sent.')
  expect([...w.files]).toEqual(['.lease'])
})

test('a picture whose placeholder left the draft while it was made is not kept, and its files go', async ($, on) => {
  const w = world(on, {
    clipboard: PNG_CLIPBOARD,
    prompt: '[Image #1]',
    // The person deletes the placeholder while the thumbnails are made.
    onRun: argv => argv[0] === 'sips' && w.setPrompt(''),
  })
  await promptChange($, { text: '[Image #1]', cursor: 10, origin: { kind: 'engine' } })
  await w.clock.settle()

  expect(w.list()).toEqual([])
  expect([...w.files]).toEqual(['.lease'])
})

/** Pastes "[Image #n]" after what the box holds, as the engine puts a placeholder in. */
async function paste($: Parameters<TestBody>[0], w: ReturnType<typeof world>, text: string) {
  w.setPrompt(text)
  await promptChange($, { text, cursor: text.length, origin: { kind: 'engine' } })
  await w.clock.settle()
}

test('the clipboard unchanged since the last paste: a screenshot saved just now is taken instead', { options: { graphics: 'off' } }, async ($, on) => {
  const shot = 'Screenshot 2026-10-28 at 9.00.00\u202fPM.png'
  const w = world(on, { clipboard: PNG_CLIPBOARD, prompt: '', desktop: [shot] })
  await paste($, w, '[Image #1]')
  await paste($, w, '[Image #1] [Image #2]')

  const second = w.list().find(img => img.n === 2)
  expect(second?.source).toBe('file')
  expect(second?.path).toMatch(/\/drop-[0-9-]+\.png$/)
  // The clipboard's stale copy for #2 went; #1's files and #2's copy stay.
  const first = w.list().find(img => img.n === 1)!
  expect([...w.files].filter(file => !file.startsWith(first.id)).sort()).toEqual([
    '.lease',
    name(second!.path),
    `${second!.id}.small.png`,
    `${second!.id}.thumb.png`,
  ].sort())
})

test('the same clipboard image pasted again, with no recent screenshot, is taken from the clipboard', { options: { graphics: 'off' } }, async ($, on) => {
  const w = world(on, { clipboard: PNG_CLIPBOARD, prompt: '' })
  await paste($, w, '[Image #1]')
  await paste($, w, '[Image #1] [Image #2]')

  const second = w.list().find(img => img.n === 2)
  expect([second?.source, second ? name(second.path) : undefined]).toEqual(['clipboard', `${second?.id}.png`])
})
