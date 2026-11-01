// What the hooks register does as the person sees it: the /peek command, the
// pane opened for a first pasted picture, and a session switch.

import type { On, PromptChangeInput, RenderViewport } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { PeekImage } from '../types'
import { IMAGES_SHAPE } from '../hooks/pictures'
import { machine } from './machine'

type $ = Parameters<TestBody>[0]

const SHOT: PeekImage = {
  id: 'msg-1-1',
  n: 1,
  path: '/t/claude-image-peek/sess-1/msg-1-1.png',
  thumb: '/t/claude-image-peek/sess-1/msg-1-1.thumb.png',
  small: '/t/claude-image-peek/sess-1/msg-1-1.small.png',
  width: 800,
  height: 400,
  source: 'transcript',
  stage: 'stored',
  messageId: 'msg-1',
  promptText: 'fix the margin in [Image #1]',
  addedAt: 1,
}

const DIR = '/t/claude-image-peek/sess-1'
const FULLSCREEN: RenderViewport = { columns: 100, rows: 40, isFullscreen: true }
const MAIN_SCREEN: RenderViewport = { columns: 100, rows: 40, isFullscreen: false }

/**
 * The world beneath the mod: stored values in memory (`images` seeded with
 * `list`), the panes opened, the probe lines logged, the prompt box, and a
 * macOS machine whose clipboard holds a PNG.
 */
function world(on: On, list: PeekImage[] = []) {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>([['images', { shape: IMAGES_SHAPE, value: list }]])
  let version = 0
  on('state.get', (_, e) => ({ value: { value: stored.get(e.key), version } }))
  on('state.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: { isSet: true, version: ++version } }
  })
  const opened: { focus?: boolean }[] = []
  let isPlaced = true
  on('ui.open', (_, e) => {
    opened.push({ focus: e.focus })
    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'no surface' } }
  })
  const logs: { text: string; to?: string }[] = []
  on('ui.log', (_, e) => {
    logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  let prompt = ''
  on('prompt.read', () => ({ value: { text: prompt, cursor: prompt.length } }))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  const m = machine(on, { clipboard: { change: 7, types: ['public.png'], isImage: true } })
  return {
    clock,
    opened,
    logs,
    runs: m.runs,
    removed: m.removed,
    files: () => m.left(DIR),
    list: () => ((stored.get('images') as { value?: PeekImage[] } | undefined)?.value ?? []) as PeekImage[],
    selected: () => stored.get('selected'),
    isDebug: () => stored.get('isDebug'),
    unplace: () => {
      isPlaced = false
    },
    setPrompt: (text: string) => {
      prompt = text
    },
  }
}

const peek = async ($: $, args: string) =>
  ((await $.command.run({ command: 'peek', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })) as { text?: string })
    .text

/** Raises `prompt.change` as the engine does when it puts a placeholder in the box itself. */
const promptChange = ($: $, e: PromptChangeInput) =>
  ($.prompt as unknown as { change: (e: PromptChangeInput) => Promise<unknown> }).change(e)

/** The engine pastes Image #`n` from the clipboard into the draft, and the picture is made. */
async function paste($: $, w: ReturnType<typeof world>, n: number) {
  const text = `[Image #${n}]`
  w.setPrompt(text)
  await promptChange($, { text, cursor: text.length, origin: { kind: 'engine' } })
  await w.clock.settle()
}

/** A drawing of a sent prompt's row on `surface`, reporting `viewport`. */
async function drawRow($: $, surface: 'terminal' | 'desktop', viewport?: RenderViewport) {
  const row = await $.ui.mount({
    plugin: 'image-peek',
    surface,
    component: 'UserMessage',
    requestId: 'msg-1',
    viewport,
    props: { text: 'fix the margin in [Image #1]', origin: { kind: 'composer' }, isExpanded: false },
  })
  await row.unmount()
}

test('/peek counts the pictures and opens the pane on the list, saying when nothing draws it', async ($, on) => {
  const w = world(on, [SHOT])
  expect(await peek($, '')).toBe('1 image.')
  expect([w.opened, w.selected()]).toEqual([[{ focus: true }], null])
  w.unplace()
  expect(await peek($, '')).toBe('1 image (no surface draws the pane here).')
})

test('/peek N shows the picture big in the pane', { options: { graphics: 'file' } }, async ($, on) => {
  const w = world(on, [SHOT])
  expect(await peek($, '1')).toBe('Showing Image #1.')
  expect([w.opened, w.selected()]).toEqual([[{ focus: true }], SHOT.id])
  expect(w.runs.filter(r => r.argv[0] === 'open')).toEqual([])
})

test('/peek N with graphics off opens the picture in the system viewer', { options: { graphics: 'off' } }, async ($, on) => {
  const w = world(on, [SHOT])
  expect(await peek($, '1')).toBe('Opened Image #1 in the system viewer.')
  expect(w.runs.filter(r => r.argv[0] === 'open').map(r => r.argv)).toEqual([['open', SHOT.path]])
  expect(w.opened).toEqual([])
})

test('/peek open N opens the picture in the system viewer, graphics or not', { options: { graphics: 'file' } }, async ($, on) => {
  const w = world(on, [SHOT])
  expect(await peek($, 'open 1')).toBe('Opened Image #1 in the system viewer.')
  expect(w.runs.filter(r => r.argv[0] === 'open').map(r => r.argv)).toEqual([['open', SHOT.path]])
  expect(w.opened).toEqual([])
})

test('/peek of a picture not there yet says how to use it', async ($, on) => {
  world(on, [SHOT])
  expect(await peek($, '9')).toBe('No Image #9 yet. Usage: /peek [N | open N | clear | debug]')
  expect(await peek($, 'open')).toBe('No Image #? yet. Usage: /peek [N | open N | clear | debug]')
  expect(await peek($, 'what')).toBe('No Image #what yet. Usage: /peek [N | open N | clear | debug]')
})

test('/peek debug sends the probe lines to the transcript, and back to the debug log', async ($, on) => {
  const w = world(on)
  // A placeholder the engine puts in is a probe line.
  const edit = () => paste($, w, 1)
  const where = () => w.logs.filter(l => l.text.startsWith('[image-peek] prompt.change')).map(l => l.to)
  expect(await peek($, 'debug')).toBe('Debug lines shown in the transcript.')
  expect(w.isDebug()).toBe(true)
  await edit()
  expect(await peek($, 'debug')).toBe('Debug lines in the debug log only.')
  expect(w.isDebug()).toBe(false)
  await edit()
  expect(where()).toEqual(['transcript', 'debug'])
})

test('autoOpenPane: the first pasted picture opens the pane in fullscreen, keys left in the prompt; again after a /clear', { options: { autoOpenPane: true, graphics: 'off' } }, async ($, on) => {
  const w = world(on)
  await drawRow($, 'terminal', FULLSCREEN)
  await paste($, w, 1)
  await paste($, w, 2)
  expect(w.list().map(img => img.n)).toEqual([1, 2])
  expect(w.opened).toEqual([{ focus: undefined }])

  await $.session.end({ sessionId: 'sess-1', reason: 'clear', resume: { id: 'sess-1' } })
  await w.clock.advance(300)
  await w.clock.settle()
  await paste($, w, 1)
  expect(w.opened).toEqual([{ focus: undefined }, { focus: undefined }])
})

test('autoOpenPane: on the main screen a pasted picture opens no pane, whatever a remote surface reports', { options: { autoOpenPane: true, graphics: 'off' } }, async ($, on) => {
  const w = world(on, [SHOT])
  await drawRow($, 'terminal', MAIN_SCREEN)
  // The desktop app docks panes; its layout is not the terminal's.
  await drawRow($, 'desktop', FULLSCREEN)
  await paste($, w, 2)
  expect(w.list().map(img => img.n).sort()).toEqual([1, 2])
  expect(w.opened).toEqual([])
})

test("fullscreen: a band that reports no layout shows hover previews after the mobile app's row drew", { options: { graphics: 'file' } }, async ($, on) => {
  world(on, [SHOT])
  await drawRow($, 'terminal', FULLSCREEN)
  // The mobile app is never fullscreen; the terminal still is.
  await drawRow($, 'desktop', MAIN_SCREEN)
  const band = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} },
  })
  expect((await band.find({ key: 'preview-msg-1-1' }))?.type).toBe('Box')
  await band.unmount()
})

/** The conversation a resumed session reads back: one prompt with a picture. */
const conversation = (on: On) =>
  on('session.messages', () => ({
    value: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at [Image #2]' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ],
      },
    ],
  }))

test("a /resume clears the list, then reads the resumed conversation's pictures back", { options: { graphics: 'file' } }, async ($, on) => {
  const w = world(on, [SHOT])
  conversation(on)
  await $.session.end({ sessionId: 'sess-1', reason: 'resume', resume: { id: 'sess-1' } })
  expect(w.list()).toEqual([])
  await w.clock.settle()
  // The switch settles before the old folder goes and the pictures are read back.
  expect(w.list()).toEqual([])
  await w.clock.advance(300)
  await w.clock.settle()
  expect(w.removed()).toEqual([DIR])
  expect(w.list().map(img => [img.n, img.stage])).toEqual([[2, 'history']])
  expect(w.files()).toEqual(['.lease', 'hist-1-2.png', 'hist-1-2.small.png', 'hist-1-2.thumb.png'])
})

test('a /clear clears the list and reads nothing back', { options: { graphics: 'file' } }, async ($, on) => {
  const w = world(on, [SHOT])
  conversation(on)
  await $.session.end({ sessionId: 'sess-1', reason: 'clear', resume: { id: 'sess-1' } })
  await w.clock.advance(300)
  await w.clock.settle()
  expect(w.removed()).toEqual([DIR])
  expect(w.list()).toEqual([])
})
