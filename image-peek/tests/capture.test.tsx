import type { On, PromptChangeInput, PromptEditInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { PeekImage } from '../types'
import { machine } from './machine'
import type { Clipboard } from './machine'

// A macOS session with no terminal of its own: TMPDIR and HOME unset put the
// session's folder here.
const DIR = '/Library/Caches/claude-image-peek/sess-1'
const name = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * Raises `prompt.change` as the engine does when it puts a placeholder in the
 * box itself. The kit dispatches it through every hook, though the type of
 * its `$` lists only the calls a plugin can make.
 */
const promptChange = ($: Parameters<TestBody>[0], e: PromptChangeInput) =>
  ($.prompt as unknown as { change: (e: PromptChangeInput) => Promise<unknown> }).change(e)

/** Raises `prompt.edit` as the person's paste or keystroke does. */
const promptEdit = ($: Parameters<TestBody>[0], e: PromptEditInput) =>
  ($.prompt as unknown as { edit: (e: PromptEditInput) => Promise<unknown> }).edit(e)

/**
 * The world beneath the mod for a capture: stored values in memory, the
 * prompt box, and the machine with the clipboard, the screenshots on the
 * Desktop and the other files a paste may name. macOS with no terminal of
 * its own unless `os` names another, its `env` set, its session folder `dir`.
 */
function world(
  on: On,
  options: {
    clipboard: Clipboard
    prompt: string
    os?: 'linux' | 'wsl'
    env?: Record<string, string>
    dir?: string
    magick?: 'magick' | 'convert'
    desktop?: string[]
    disk?: string[]
    onRun?: (argv: readonly string[]) => unknown
  },
) {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  const toasts: string[] = []
  let prompt = options.prompt
  let version = 0
  on('state.get', (_, e) => ({ value: { value: stored.get(e.key), version } }))
  on('state.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: { isSet: true, version: ++version } }
  })
  on('prompt.read', () => ({ value: { text: prompt, cursor: prompt.length } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('prompt.edit', (_, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  const { clipboard, desktop, disk, onRun, os, magick, dir = DIR } = options
  const { left, runs } = machine(on, { os, env: options.env ?? (os ? undefined : {}), clipboard, desktop, disk, onRun, magick })
  const list = () => ((stored.get('images') as { value?: PeekImage[] } | undefined)?.value ?? []) as PeekImage[]
  return {
    clock,
    runs,
    files: () => left(dir),
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
  expect([img?.n, img?.source, img?.stage, img?.width, img?.height]).toEqual([1, 'clipboard', 'draft', 800, 400])
  expect(w.files()).toEqual(['.lease', `${img!.id}.png`, `${img!.id}.small.png`, `${img!.id}.thumb.png`])

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
  expect(w.files()).toEqual(['.lease'])
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
  expect(w.files()).toEqual(['.lease'])
})

// The clear comes while the thumbnails are made (`sips`), or after, while the
// thumbnail's size is read (`sh`): the last step before the list changes.
for (const [step, when] of [
  ['sips', 'while the thumbnails are made'],
  ['sh', 'once the thumbnails are made'],
] as const) {
  test(`a /peek clear ${when} keeps no picture, and its files go`, { options: { graphics: 'off' } }, async ($, on) => {
    let isCleared = false
    const w = world(on, {
      clipboard: PNG_CLIPBOARD,
      prompt: '[Image #1]',
      // The person clears the list while the picture is made; the placeholder stays.
      onRun: async argv => {
        if (argv[0] !== step || isCleared) return
        isCleared = true
        await $.command.run({ command: 'peek', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
      },
    })
    await promptChange($, { text: '[Image #1]', cursor: 10, origin: { kind: 'engine' } })
    await w.clock.settle()

    expect(isCleared).toBe(true)
    expect(w.list()).toEqual([])
    expect(w.files()).toEqual(['.lease'])
  })
}

/** Pastes "[Image #n]" after what the box holds, as the engine puts a placeholder in. */
async function paste($: Parameters<TestBody>[0], w: ReturnType<typeof world>, text: string) {
  w.setPrompt(text)
  await promptChange($, { text, cursor: text.length, origin: { kind: 'engine' } })
  await w.clock.settle()
}

test('a /peek clear deletes a dropped picture\'s copy with its thumbnails', { options: { graphics: 'off' } }, async ($, on) => {
  const shot = 'Screenshot 2026-10-28 at 9.00.00\u202fPM.png'
  // The clipboard holds nothing new: the screenshot saved just now is copied in.
  const w = world(on, { clipboard: { change: 3, types: [], isImage: false }, prompt: '', desktop: [shot] })
  await paste($, w, '[Image #1]')
  const [dropped] = w.list()
  expect(dropped?.source).toBe('file')
  expect(name(dropped!.path)).toMatch(/^drop-/)
  expect(w.files()).toContain(name(dropped!.path))

  await $.command.run({ command: 'peek', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(w.list()).toEqual([])
  expect(w.files()).toEqual(['.lease'])
})

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
  expect(w.files().filter(file => !file.startsWith(first.id)).sort()).toEqual([
    '.lease',
    name(second!.path),
    `${second!.id}.small.png`,
    `${second!.id}.thumb.png`,
  ].sort())
})

test('a screenshot taken for a draft before a /peek clear is taken again for the next one', { options: { graphics: 'off' } }, async ($, on) => {
  const shot = 'Screenshot 2026-10-28 at 9.00.00 PM.png'
  const w = world(on, { clipboard: PNG_CLIPBOARD, prompt: '', desktop: [shot] })
  await paste($, w, '[Image #1]')
  await paste($, w, '[Image #1] [Image #2]')
  expect(w.list().find(img => img.n === 2)?.source).toBe('file')

  await $.command.run({ command: 'peek', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  await paste($, w, '[Image #1]')

  const [img] = w.list()
  expect([img?.n, img?.source]).toEqual([1, 'file'])
  expect(img?.path).toMatch(/\/drop-[0-9-]+\.png$/)
})

test('the same clipboard image pasted again, with no recent screenshot, is taken from the clipboard', { options: { graphics: 'off' } }, async ($, on) => {
  const w = world(on, { clipboard: PNG_CLIPBOARD, prompt: '' })
  await paste($, w, '[Image #1]')
  await paste($, w, '[Image #1] [Image #2]')

  const second = w.list().find(img => img.n === 2)
  expect([second?.source, second ? name(second.path) : undefined]).toEqual(['clipboard', `${second?.id}.png`])
})

test('an image path pasted with no placeholder is where the one the engine puts in next comes from', { options: { graphics: 'off' } }, async ($, on) => {
  const cat = '/Pictures/cat.png'
  const w = world(on, { clipboard: { change: 9, types: ['public.utf8-plain-text'], isImage: false }, prompt: '', disk: [cat] })
  await promptEdit($, { origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: cat })
  await paste($, w, '[Image #1]')

  const [img] = w.list()
  expect([img?.n, img?.source]).toEqual([1, 'file'])
  expect(img?.path).toMatch(/\/drop-[0-9-]+\.png$/)
})

test('a placeholder deleted from the draft takes its picture and files with it', { options: { graphics: 'off' } }, async ($, on) => {
  const w = world(on, { clipboard: PNG_CLIPBOARD, prompt: '' })
  await paste($, w, '[Image #1]')
  expect(w.list()).toHaveLength(1)

  w.setPrompt('')
  await promptEdit($, { origin: { kind: 'composer' }, text: '[Image #1]', cursor: 10, start: 0, end: 10, inputText: '' })
  await w.clock.settle()
  expect(w.list()).toEqual([])
  expect(w.files()).toEqual(['.lease'])
})

const LINUX_DIR = '/run/user/1000/claude-image-peek/sess-1'
const LINUX_PNG: Clipboard = { types: ['image/png', 'text/plain'], isImage: true }
const WAYLAND = { XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-0' }

/** The tools the mod ran, in order, of those named. */
const tools = (w: ReturnType<typeof world>, names: string[]) => w.runs.map(r => r.argv[0]!).filter(tool => names.includes(tool))

test('on Linux under Wayland the clipboard image is read with wl-paste', { options: { graphics: 'off' } }, async ($, on) => {
  const w = world(on, { os: 'linux', env: WAYLAND, dir: LINUX_DIR, clipboard: LINUX_PNG, prompt: '' })
  await paste($, w, '[Image #1]')

  const [img] = w.list()
  expect([img?.n, img?.source, img?.width, img?.height]).toEqual([1, 'clipboard', 800, 400])
  expect(w.files()).toEqual(['.lease', `${img!.id}.png`, `${img!.id}.small.png`, `${img!.id}.thumb.png`])
  expect(tools(w, ['wl-paste', 'xclip'])).toEqual(['wl-paste'])
})

test('on Linux under X the clipboard image is read with xclip, into ~/.cache with no runtime dir', { options: { graphics: 'off' } }, async ($, on) => {
  const w = world(on, { os: 'linux', env: { HOME: '/home/me' }, dir: '/home/me/.cache/claude-image-peek/sess-1', clipboard: LINUX_PNG, prompt: '' })
  await paste($, w, '[Image #1]')

  const [img] = w.list()
  expect([img?.n, img?.source]).toEqual([1, 'clipboard'])
  expect(w.files()).toEqual(['.lease', `${img!.id}.png`, `${img!.id}.small.png`, `${img!.id}.thumb.png`])
  expect(tools(w, ['wl-paste', 'xclip'])).toEqual(['xclip'])
})

test('on Linux a clipboard tool that writes old text for the image is not taken at its word', async ($, on) => {
  const w = world(on, { os: 'linux', env: WAYLAND, dir: LINUX_DIR, clipboard: { ...LINUX_PNG, isGarbled: true }, prompt: '' })
  await paste($, w, '[Image #1]')

  expect(w.list()).toEqual([])
  expect(w.toasts).toContain('Image #1: it will show once sent.')
  expect(w.files()).toEqual(['.lease'])
})

test("on Linux with only ImageMagick 6 the thumbnails are made by convert", { options: { graphics: 'off' } }, async ($, on) => {
  const w = world(on, { os: 'linux', env: WAYLAND, dir: LINUX_DIR, clipboard: LINUX_PNG, prompt: '', magick: 'convert' })
  await paste($, w, '[Image #1]')

  const [img] = w.list()
  expect(w.files()).toEqual(['.lease', `${img!.id}.png`, `${img!.id}.small.png`, `${img!.id}.thumb.png`])
  // Each conversion tries 7's magick first.
  expect(tools(w, ['magick', 'convert'])).toEqual(['magick', 'convert', 'magick', 'convert'])
})

test('on Linux a file copied in the file manager is taken from the path its URI names', { options: { graphics: 'off' } }, async ($, on) => {
  const cat = '/home/me/My Pictures/cat.png'
  const w = world(on, { os: 'linux', env: WAYLAND, dir: LINUX_DIR, clipboard: { types: ['text/uri-list'], isImage: false, file: cat }, disk: [cat], prompt: '' })
  await paste($, w, '[Image #1]')

  const [img] = w.list()
  expect([img?.n, img?.source]).toEqual([1, 'file'])
  expect(w.runs.find(r => r.argv[0] === 'cp')?.argv[1]).toBe(cat)
})

const WSL_DIR = '/home/me/.cache/claude-image-peek/sess-1'

test("on WSL PowerShell saves the clipboard image at the session folder's Windows path", { options: { graphics: 'off' } }, async ($, on) => {
  const w = world(on, { os: 'wsl', dir: WSL_DIR, clipboard: { types: [], isImage: true }, prompt: '' })
  await paste($, w, '[Image #1]')

  const [img] = w.list()
  expect([img?.n, img?.source, img?.width, img?.height]).toEqual([1, 'clipboard', 800, 400])
  expect(img?.path).toBe(`${WSL_DIR}/${img!.id}.png`)
  expect(w.files()).toEqual(['.lease', `${img!.id}.png`, `${img!.id}.small.png`, `${img!.id}.thumb.png`])
  const grab = w.runs.find(r => r.argv.at(-1)!.includes('GetFileDropList'))!.argv.at(-1)!
  expect(grab).toContain(`'\\\\wsl.localhost\\Ubuntu\\home\\me\\.cache\\claude-image-peek\\sess-1\\${img!.id}.png'`)
})

test('on WSL a file Explorer copied is read from its Linux path', { options: { graphics: 'off' } }, async ($, on) => {
  const w = world(on, {
    os: 'wsl',
    dir: WSL_DIR,
    clipboard: { types: [], isImage: false, file: 'C:\\Users\\me\\cat.png' },
    disk: ['/mnt/c/Users/me/cat.png'],
    prompt: '',
  })
  await paste($, w, '[Image #1]')

  const [img] = w.list()
  expect([img?.n, img?.source]).toEqual([1, 'file'])
  expect(w.runs.find(r => r.argv[0] === 'cp')?.argv[1]).toBe('/mnt/c/Users/me/cat.png')
})
