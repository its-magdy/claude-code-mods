import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { PeekImage } from '../types'
import { toBase64 } from '../hooks/base64'
import { Lru } from '../hooks/cache'
import { imagePaths } from '../hooks/capture'
import { addDraft, drafts, forRow, sent, storePrompt, submitDrafts, unread } from '../hooks/list'
import { IMAGES_SHAPE } from '../hooks/pictures'
import { bmpToCells, readBmp } from '../hooks/raster'
import { machine } from './machine'

const SHOT: PeekImage = {
  id: 'msg-1-1',
  n: 1,
  path: '/tmp/claude-image-peek/s/msg-1-1.png',
  thumb: '/tmp/claude-image-peek/s/msg-1-1.thumb.png',
  small: '/tmp/claude-image-peek/s/msg-1-1.small.png',
  width: 800,
  height: 400,
  source: 'transcript',
  stage: 'stored',
  messageId: 'msg-1',
  promptText: 'fix the margin in [Image #1]',
  addedAt: 1,
}

/** The image list as the session stores it: with its shape tag, as the atom's `{ shape }` writes it. */
const storedList = (images: PeekImage[]) => ({ shape: IMAGES_SHAPE, value: images })

/** A picture of SHOT's still in the prompt: a draft has no row and no prompt text yet. */
const draftOf = (img: Partial<PeekImage> = {}): PeekImage => ({ ...SHOT, id: 'draft-1-5', source: 'clipboard', stage: 'draft', messageId: undefined, promptText: undefined, ...img })

/** A picture of SHOT's read back from a resumed session: its row is known by its text only. */
const historyOf = (id: string, promptText: string): PeekImage => ({ ...SHOT, id, stage: 'history', messageId: undefined, promptText })

// Stands in for the session's stored values: what an earlier event wrote.
const seed = (values: { images?: PeekImage[]; isDebug?: boolean }) => (_: unknown, e: { key: string }) => ({
  value: {
    value: e.key === 'images' ? storedList(values.images ?? []) : e.key === 'isDebug' ? values.isDebug : undefined,
    version: 1,
  },
})

test('paths a terminal types for a drop are read back', async () => {
  expect(imagePaths('/Users/me/Desktop/Screenshot\\ 2026-10-25\\ at\\ 1.02.03\\ PM.png ')).toEqual([
    '/Users/me/Desktop/Screenshot 2026-10-25 at 1.02.03 PM.png',
  ])
  expect(imagePaths("'/tmp/a b.JPG' /tmp/c.webp")).toEqual(['/tmp/a b.JPG', '/tmp/c.webp'])
  expect(imagePaths('file:///tmp/x%20y.png')).toEqual(['/tmp/x y.png'])
  expect(imagePaths('C:\\Users\\me\\shot.png')).toEqual(['C:\\Users\\me\\shot.png'])
  expect(imagePaths('"C:\\Users\\me\\my shot.png"')).toEqual(['C:\\Users\\me\\my shot.png'])
  expect(imagePaths('look at /tmp/notes.txt and fix it')).toEqual([])
})

test('the picture cache stays within its budget, least recently used out', async () => {
  const cache = new Lru<string | null>(10, value => value?.length ?? 0)
  cache.set('a', 'aaaa')
  cache.set('b', 'bbbb')
  cache.get('a') // a is now the most recent
  cache.set('c', 'cccc') // 12 > 10: b goes, not a
  expect([cache.has('a'), cache.has('b'), cache.has('c')]).toEqual([true, false, true])
  expect(cache.weight).toBe(8)
  cache.set('huge', 'x'.repeat(11)) // heavier than the whole budget: not kept, nothing evicted
  expect([cache.has('huge'), cache.size]).toEqual([false, 2])
  cache.set('miss', null) // a failed read is remembered and weighs one
  expect([cache.has('miss'), cache.weight]).toEqual([true, 9])
  cache.set('a', 'aa') // replacing re-weighs
  expect(cache.weight).toBe(7)
})

test('a 24-bit bottom-up BMP becomes half-block cells', async () => {
  // 1 x 2 pixels: red on top, blue below (rows stored bottom-up, padded to 4 bytes).
  const header = new Uint8Array(54)
  const view = new DataView(header.buffer)
  header[0] = 0x42
  header[1] = 0x4d
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, 1, true)
  view.setInt32(22, 2, true)
  view.setUint16(28, 24, true)
  const pixels = Uint8Array.of(0xff, 0, 0, 0, 0, 0, 0xff, 0) // blue row, then red row
  const bmp = new Uint8Array(header.length + pixels.length)
  bmp.set(header)
  bmp.set(pixels, header.length)

  const read = readBmp(bmp)
  expect(read?.at(0, 0)).toBe(0xff0000)
  expect(read?.at(0, 1)).toBe(0x0000ff)

  const cells = bmpToCells(toBase64(bmp), 1, 1)
  expect(cells).toBe(toBase64(new Uint8Array(Uint32Array.of(0x2580, 0xff0000, 0x0000ff).buffer)))
})

test('the pane says how to start when there are no images', async ($, on) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'image-peek',
      surface,
      component: 'Pane',
      requestId: 'image-peek',
      props: {
        title: 'Images',
        isFocused: false,
        bodyColumns: 40,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /No images yet/ }))?.text).toBe('No images yet.')
    await ui.unmount()
  }
})

test('a sent prompt with an image gets a chip under it', async ($, on) => {
  on('state.get', seed({ images: [SHOT], isDebug: false }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })

  const ui = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'msg-1',
    props: { text: 'fix the margin in [Image #1]', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeDefined()
  expect((await ui.find({ key: 'peek-msg-1-1' }))?.props.label).toBe('▣ Image 1')
  await ui.unmount()
})

test('a row with no image of its own is left to the engine', async ($, on) => {
  on('state.get', seed({ images: [SHOT], isDebug: false }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })

  const ui = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'msg-2',
    props: { text: 'and now [Image #3] please', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect(await ui.find({ key: 'peek-msg-1-1' })).toBeUndefined()
  await ui.unmount()
})

const FULLSCREEN = { columns: 100, rows: 40, isFullscreen: true }
// No terminal here: every environment variable the mod asks for is unset.
const noEnv = () => ({ value: undefined })

const BAND = {
  plugin: 'image-peek',
  surface: 'terminal',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: FULLSCREEN,
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

test('fullscreen: the chip lights a hover scope and the band holds its picture', { options: { graphics: 'file' } }, async ($, on) => {
  on('state.get', seed({ images: [SHOT], isDebug: false }))
  on('env.get', noEnv)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })

  const row = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'msg-1',
    viewport: FULLSCREEN,
    props: { text: 'fix the margin in [Image #1]', origin: { kind: 'composer' }, isExpanded: false },
  })
  // The kit shows a Box by its key alone; its hover styles are the surface's.
  expect((await row.find({ key: 'chip-msg-1-1' }))?.type).toBe('Box')
  await row.unmount()

  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'preview-msg-1-1' }))?.type).toBe('Box')
  expect((await band.find({ type: 'Image' }))?.props.source).toEqual({ file: SHOT.thumb, format: 'png' })
  await band.unmount()
})

test('fullscreen: a draft shows as a chip, its picture only on hover', { options: { graphics: 'file' } }, async ($, on) => {
  const draft = draftOf()
  on('state.get', seed({ images: [draft], isDebug: false }))
  on('env.get', noEnv)
  const band = await $.ui.mount(BAND)
  // The chip's Box lights the scope; the one picture drawn is the hidden preview's.
  expect((await band.find({ key: 'band-draft-1-5' }))?.type).toBe('Box')
  expect((await band.find({ key: 'preview-draft-1-5' }))?.type).toBe('Box')
  expect((await band.find({ type: 'Image' }))?.props.source).toEqual({ file: SHOT.thumb, format: 'png' })
  await band.unmount()
})

test('fullscreen: a short band never outgrows its rows; a hint stands in for a tiny picture', { options: { graphics: 'file' } }, async ($, on) => {
  const draft = draftOf()
  on('state.get', seed({ images: [draft], isDebug: false }))
  on('env.get', noEnv)
  // Title, picture and chip row fit the band whole.
  const tall = await $.ui.mount(BAND)
  expect((await tall.find({ type: 'Image' }))?.props.rows).toBeLessThanOrEqual(BAND.props.maxRows - 2)
  await tall.unmount()
  // Three rows: the chip row and a one-line hint, no picture.
  const short = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 3, scroll: { offset: 0, bodyRows: 3 } } })
  expect(await short.find({ type: 'Image' })).toBeUndefined()
  expect(await short.find({ type: 'Text', text: /Image 1 · click to open/ })).toBeDefined()
  expect((await short.find({ key: 'band-draft-1-5' }))?.type).toBe('Box')
  await short.unmount()
  // One row: the chip row alone.
  const one = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 1, scroll: { offset: 0, bodyRows: 1 } } })
  expect(await one.find({ key: 'preview-draft-1-5' })).toBeUndefined()
  expect((await one.find({ key: 'band-draft-1-5' }))?.type).toBe('Box')
  await one.unmount()
})

test('graphics off: the hidden preview says how to open the picture', { options: { graphics: 'off' } }, async ($, on) => {
  on('state.get', seed({ images: [SHOT], isDebug: false }))
  on('env.get', noEnv)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Image' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /\/peek open 1/ })).toBeDefined()
  await band.unmount()
})

test('a resumed row matches past the source path the engine stores beside a dropped file', async ($, on) => {
  const old = historyOf('hist-5-1', '[Image #1] [Image: source: /var/folders/v6/x/T/TemporaryItems/NSIRD_screencaptureui_7uILAW/Screenshot 2026-10-25 at 8.42.23 PM.png]')
  on('state.get', seed({ images: [old], isDebug: false }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const ui = await rowOf($, '4d2840a8-3149-4d33-b412-000000000000', '[Image #1]')
  expect(await ui.find({ key: 'peek-hist-5-1' })).toBeDefined()
  await ui.unmount()
})

/**
 * The command a stored prompt's bytes are decoded with, on a platform its
 * environment names.
 */
async function decodeCommand($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], env: Record<string, string>) {
  const clock = mock.clock(on)
  on('ui.log', () => ({ value: undefined }))
  const { runs } = machine(on, { env })
  await storeJpeg($)
  await clock.settle()
  return runs.find(r => r.stdin === 'aGVsbG8=')
}

test('on Windows the image bytes reach the decoder on its standard input', { options: { graphics: 'file' } }, async ($, on) => {
  const run = await decodeCommand($, on, { OS: 'Windows_NT', LOCALAPPDATA: "C:\\Users\\o'brien\\AppData\\Local" })
  expect(run?.argv[0]).toBe('powershell.exe')
  expect(run?.argv.at(-1)).toMatch(/^\[IO\.File\]::WriteAllBytes\('C:\\Users\\o''brien\\AppData\\Local\\claude-image-peek\\sess-1\\[^']+\.jpg', \[Convert\]::FromBase64String\(\[Console\]::In\.ReadToEnd\(\)\)\)$/)
})

test('on macOS the image bytes reach the decoder on its standard input', { options: { graphics: 'file' } }, async ($, on) => {
  const run = await decodeCommand($, on, { TMPDIR: '/t/' })
  expect(run?.argv.slice(0, 4)).toEqual(['sh', '-c', 'base64 --decode > "$1"', 'sh'])
  expect(run?.argv[4]).toMatch(/^\/t\/claude-image-peek\/sess-1\/[^/]+\.jpg$/)
})

test('a macOS screenshot dropped from the Desktop is read as one path', async () => {
  // macOS puts a narrow no-break space (U+202F) before AM/PM in screenshot names.
  const name = '/Users/me/Desktop/Screenshot\\ 2026-10-25\\ at\\ 8.31.06 PM.png'
  expect(imagePaths(name)).toEqual(['/Users/me/Desktop/Screenshot 2026-10-25 at 8.31.06 PM.png'])
})

test('the band above the prompt shows the draft images', async ($, on) => {
  const draft = draftOf()
  on('state.get', seed({ images: [draft], isDebug: false }))
  on('env.get', noEnv)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'image-peek',
      surface,
      component: 'AbovePrompt',
      requestId: 'above-prompt',
      viewport: FULLSCREEN,
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await ui.find({ key: 'draft-draft-1-5' })).toBeDefined()
    await ui.unmount()
  }
})

const rowOf = async ($: Parameters<TestBody>[0], requestId: string, text: string) =>
  $.ui.mount({
    plugin: 'image-peek',
    surface: 'desktop',
    component: 'UserMessage',
    requestId,
    props: { text, origin: { kind: 'composer' }, isExpanded: false },
  })

test("a row finds its stored image by the row id's shared prefix", async ($, on) => {
  const sent: PeekImage = { ...SHOT, id: 'sent-1', messageId: '08e22b78-772c-44ea-8c48-220f9dd6f0cb', promptText: 'something else' }
  on('state.get', seed({ images: [sent], isDebug: false }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const ui = await rowOf($, '08e22b78-772c-44ea-8c48-000000000000', '[Image #1]')
  expect(await ui.find({ key: 'peek-sent-1' })).toBeDefined()
  await ui.unmount()
})

test('a resumed row finds its image past the engine reminder in the stored text', async ($, on) => {
  const old = historyOf('hist-3-1', '<system-reminder>\n# Environment\nworking directory: /x\n</system-reminder>\n[Image #1]')
  on('state.get', seed({ images: [old], isDebug: false }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const ui = await rowOf($, 'aaaaaaaa-bbbb-cccc-dddd-000000000000', '[Image #1]')
  expect(await ui.find({ key: 'peek-hist-3-1' })).toBeDefined()
  await ui.unmount()
})

test('a resumed row finds its image past a slash command record merged into its row', async ($, on) => {
  const old = historyOf('hist-5-1', '<command-name>/peek</command-name> <command-message>peek</command-message> <command-args></command-args> <local-command-stdout>image-peek: 0 images.</local-command-stdout> [Image #1] [Image #2] test')
  on('state.get', seed({ images: [old], isDebug: false }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const ui = await rowOf($, 'aaaaaaaa-bbbb-cccc-dddd-000000000000', '[Image #1] [Image #2] test')
  expect(await ui.find({ key: 'peek-hist-5-1' })).toBeDefined()
  await ui.unmount()
})

test('the pane lists a submitted picture under Sent before its stored bytes arrive', async ($, on) => {
  const submitted = draftOf({ stage: 'submitted', promptText: 'fix the margin in [Image #1]' })
  on('state.get', seed({ images: [submitted], isDebug: false }))
  const ui = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'image-peek',
    props: { title: 'Images', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /^In your prompt$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Sent$/ })).toBeDefined()
  await ui.unmount()
})

test('a picture goes from the draft to its sent row; the next draft stays', async () => {
  const draft = (n: number, addedAt: number) => draftOf({ id: `draft-${n}-${addedAt}`, n, addedAt })
  let list = addDraft(addDraft([], draft(1, 1)), draft(1, 2)) // a second paste of #1 replaces the first
  expect(drafts(list).map(img => img.id)).toEqual(['draft-1-2'])

  list = submitDrafts(list, 'fix the margin in [Image #1]')
  expect([drafts(list).length, sent(list).map(img => img.stage)]).toEqual([0, ['submitted']])
  // Before its bytes are stored, the row finds the picture by its text.
  expect(forRow(list, '08e22b78-772c-44ea-8c48-000000000000', 'fix the margin in [Image #1]').map(img => img.id)).toEqual(['draft-1-2'])

  list = addDraft(list, draft(1, 3)) // the next prompt's #1
  // The stored bytes come in as fresh pictures: the step gives them their stage.
  const stored: PeekImage = { ...SHOT, id: 'msg-1', stage: 'draft', messageId: '08e22b78-772c-44ea-8c48-220f9dd6f0cb', addedAt: 4 }
  list = storePrompt(list, [stored], { messageId: stored.messageId, text: 'fix the margin in [Image #1]', stage: 'stored' })
  expect(list.map(img => [img.id, img.stage])).toEqual([
    ['draft-1-3', 'draft'],
    ['msg-1', 'stored'],
  ])
  expect(forRow(list, '08e22b78-772c-44ea-8c48-000000000000', 'anything').map(img => img.id)).toEqual(['msg-1'])
})

test('a resumed row is read back unless this session sent as many rows of its text', async () => {
  const row = (index: number, reminder: string) => ({
    idPrefix: `hist-${index}`,
    content: [{ type: 'text' as const, text: `<system-reminder>${reminder}</system-reminder>\n[Image #1] test` }],
  })
  const sentOnce: PeekImage = { ...SHOT, id: 'msg-1', messageId: 'msg-1', promptText: '[Image #1] test' }
  // Two rows of one prompt text that differ only in a hidden reminder: one was sent here, one is new.
  expect(unread([sentOnce], [row(2, 'a'), row(7, 'b')]).map(r => r.idPrefix)).toEqual(['hist-7'])
  // A row read back on an earlier load is not read again.
  expect(unread([{ ...SHOT, id: 'hist-7-1' }], [row(7, 'b')])).toEqual([])
  // A picture read back is not one sent here: another row of its text is still new.
  expect(unread([historyOf('hist-2-1', '[Image #1] test')], [row(7, 'b')]).map(r => r.idPrefix)).toEqual(['hist-7'])
})

test('a stored row replaces only what was submitted with its text, never a picture read back', async () => {
  const old = historyOf('hist-2-1', '[Image #1] test')
  const submitted = draftOf({ stage: 'submitted', promptText: '[Image #1] test' })
  const list = storePrompt([old, submitted], [{ ...SHOT, id: 'msg-1' }], { messageId: 'msg-1', text: '[Image #1] test', stage: 'stored' })
  expect(list.map(img => [img.id, img.stage])).toEqual([
    ['hist-2-1', 'history'],
    ['msg-1', 'stored'],
  ])
})

// A 1 x 2 BMP, red over blue (blue over red when flipped): every cell it is
// scaled to reads red on top, blue below.
const tinyBmp = (isFlipped = false) => {
  const bmp = new Uint8Array(54 + 8)
  const view = new DataView(bmp.buffer)
  bmp[0] = 0x42
  bmp[1] = 0x4d
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, 1, true)
  view.setInt32(22, 2, true)
  view.setUint16(28, 24, true)
  bmp.set(isFlipped ? Uint8Array.of(0, 0, 0xff, 0, 0xff, 0, 0, 0) : Uint8Array.of(0xff, 0, 0, 0, 0, 0, 0xff, 0), 54)
  return toBase64(bmp)
}

test('blocks: a sent picture draws a placeholder, then its cells once made off the drawing', { options: { graphics: 'blocks' } }, async ($, on) => {
  const clock = mock.clock(on)
  on('state.get', seed({ images: [SHOT], isDebug: false }))
  const { runs } = machine(on, { env: {}, disk: [SHOT.small] })
  on('fs.read', () => ({ value: { base64: tinyBmp() } }))
  const logs: string[] = []
  on('ui.log', (_, e) => {
    logs.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })

  const row = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'msg-1',
    viewport: { columns: 100, rows: 40, isFullscreen: false },
    props: { text: 'fix the margin in [Image #1]', origin: { kind: 'composer' }, isExpanded: false },
  })
  // No process runs while drawing: the first drawing holds a placeholder.
  expect(await row.find({ type: 'Raster' })).toBeUndefined()
  expect(await row.find({ type: 'Text', text: /\[Image 1…\]/ })).toBeDefined()

  await clock.settle()
  const raster = await row.find({ type: 'Raster' })
  // 800 x 400 in the 28 x 8 inline box: 28 columns, 7 rows of cells.
  expect(logs).toEqual([])
  expect([raster?.props.columns, raster?.props.rows]).toEqual([28, 7])
  expect(runs.map(({ argv }) => argv[0])).toContain('sips')
  await row.unmount()
})

test('blocks: a picture cleared and then restored at the same path draws its cells again, made afresh', { options: { graphics: 'blocks' } }, async ($, on) => {
  const clock = mock.clock(on)
  // A store the mod can write: `/peek clear` empties the list.
  const stored = new Map<string, unknown>([['images', storedList([SHOT])]])
  let version = 1
  on('state.get', (_, e) => ({ value: { value: stored.get(e.key), version } }))
  on('state.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: { isSet: true, version: ++version } }
  })
  machine(on, { env: {}, disk: [SHOT.small] })
  let bmp = tinyBmp()
  on('fs.read', () => ({ value: { base64: bmp } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const ROW = {
    plugin: 'image-peek',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'msg-1',
    viewport: { columns: 100, rows: 40, isFullscreen: false },
    props: { text: 'fix the margin in [Image #1]', origin: { kind: 'composer' }, isExpanded: false },
  } as const
  const drawsCells = async () => {
    const row = await $.ui.mount(ROW)
    await clock.settle()
    const raster = await row.find({ type: 'Raster' })
    await row.unmount()
    return raster?.props.cells
  }

  const first = await drawsCells()
  expect(first).toBeDefined()
  await $.command.run({ command: 'peek', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  // A resumed session reads the same row back to the same file names, with
  // other pixels in them: the cleared picture's cells are not drawn again.
  bmp = tinyBmp(true)
  stored.set('images', storedList([SHOT]))
  const again = await drawsCells()
  expect(again).toBeDefined()
  expect(again).not.toEqual(first)
})

test('blocks: a /peek clear while cells are made keeps none; the picture restored at the same path draws its own', { options: { graphics: 'blocks' } }, async ($, on) => {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>([['images', storedList([SHOT])]])
  let version = 1
  on('state.get', (_, e) => ({ value: { value: stored.get(e.key), version } }))
  on('state.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: { isSet: true, version: ++version } }
  })
  let isCleared = false
  machine(on, {
    env: {},
    disk: [SHOT.small],
    // The person clears the list while the first cells' BMP is made.
    onRun: async argv => {
      if (argv[0] !== 'sips' || isCleared) return
      isCleared = true
      await $.command.run({ command: 'peek', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    },
  })
  let bmp = tinyBmp()
  on('fs.read', () => ({ value: { base64: bmp } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const ROW = {
    plugin: 'image-peek',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'msg-1',
    viewport: { columns: 100, rows: 40, isFullscreen: false },
    props: { text: 'fix the margin in [Image #1]', origin: { kind: 'composer' }, isExpanded: false },
  } as const
  const drawsCells = async () => {
    const row = await $.ui.mount(ROW)
    await clock.settle()
    const raster = await row.find({ type: 'Raster' })
    await row.unmount()
    return raster?.props.cells
  }

  // The cells made after the clear, of the old pixels, are not kept.
  await drawsCells()
  expect(isCleared).toBe(true)
  bmp = tinyBmp(true)
  stored.set('images', storedList([SHOT]))
  const again = await drawsCells()
  expect(again).toBe(bmpToCells(tinyBmp(true), 28, 7))
  expect(again).not.toBe(bmpToCells(tinyBmp(), 28, 7))
})

const STORE_DIR = '/t/claude-image-peek/sess-1'

/** A macOS session folder's files, left as the mod's commands write and delete them. */
function fakeMac(on: Parameters<TestBody>[1], isConverting: boolean, onRun?: (argv: readonly string[]) => unknown) {
  on('ui.log', () => ({ value: undefined }))
  const { left } = machine(on, { isConverting, onRun })
  return () => left(STORE_DIR)
}

const WIN_STORE_DIR = 'C:\\L\\claude-image-peek\\sess-1'

/** A Windows session folder's files, left as PowerShell writes and deletes them. */
function fakeWindows(on: Parameters<TestBody>[1]) {
  on('ui.log', () => ({ value: undefined }))
  const { left } = machine(on, { os: 'windows' })
  return () => left(WIN_STORE_DIR)
}

const storeJpeg = ($: Parameters<TestBody>[0]) =>
  $.session.append({
    message: {
      type: 'user',
      role: 'user',
      content: [
        { type: 'text', text: 'look at [Image #1]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } },
      ],
    },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'row-1',
  })

test('a stored prompt keeps its PNG and thumbnails; the step file and /peek clear leave only the lease', { options: { graphics: 'file' } }, async ($, on) => {
  const clock = mock.clock(on)
  const left = fakeMac(on, true)
  const { uuid } = await storeJpeg($)
  await clock.settle()
  expect(left()).toEqual(['.lease', `${uuid}-1.png`, `${uuid}-1.small.png`, `${uuid}-1.thumb.png`])

  await $.command.run({ command: 'peek', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(left()).toEqual(['.lease'])
})

test('on Windows a stored prompt keeps its PNG and thumbnails; the step file and /peek clear leave only the lease', { options: { graphics: 'file' } }, async ($, on) => {
  const clock = mock.clock(on)
  const left = fakeWindows(on)
  const { uuid } = await storeJpeg($)
  await clock.settle()
  expect(left()).toEqual(['.lease', `${uuid}-1.png`, `${uuid}-1.small.png`, `${uuid}-1.thumb.png`])

  await $.command.run({ command: 'peek', args: 'clear', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(left()).toEqual(['.lease'])
})

test('a stored prompt whose picture cannot be converted leaves no files behind', { options: { graphics: 'file' } }, async ($, on) => {
  const clock = mock.clock(on)
  const left = fakeMac(on, false)
  await storeJpeg($)
  await clock.settle()
  expect(left()).toEqual(['.lease'])
})

test('a stored prompt still being made when the session switches is not kept, and its files go', { options: { graphics: 'file' } }, async ($, on) => {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  let version = 0
  on('state.get', (_, e) => ({ value: { value: stored.get(e.key), version } }))
  on('state.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: { isSet: true, version: ++version } }
  })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  let isSwitched = false
  const left = fakeMac(on, true, async argv => {
    if (argv[0] !== 'sips' || isSwitched) return
    isSwitched = true
    // A /clear while the thumbnails are made: the process goes on under a new id.
    await $.session.end({ sessionId: 'sess-1', reason: 'clear', resume: { id: 'sess-1' } })
  })
  await storeJpeg($)
  await clock.settle()

  expect(isSwitched).toBe(true)
  expect(stored.get('images')).toEqual(storedList([]))
  expect(left()).toEqual(['.lease'])
})

test('a resumed session reads its prompts\' pictures back from the conversation', { options: { graphics: 'file' } }, async ($, on) => {
  const clock = mock.clock(on)
  const left = fakeMac(on, true)
  on('session.messages', () => ({
    value: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at [Image #2]' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ],
      },
    ],
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(left()).toEqual(['.lease', 'hist-2-2.png', 'hist-2-2.small.png', 'hist-2-2.thumb.png'])
})

test("a sent row's chip opens the pane on its picture; Back goes to the list", async ($, on) => {
  const stored = new Map<string, unknown>([['images', storedList([SHOT])]])
  on('state.get', (_, e) => ({ value: { value: stored.get(e.key), version: 1 } }))
  on('state.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: { isSet: true, version: 2 } }
  })
  const opened: { focus?: boolean }[] = []
  on('ui.open', (_, e) => {
    opened.push({ focus: e.focus })
    return { value: { isPlaced: true } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const row = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'msg-1',
    props: { text: 'fix the margin in [Image #1]', origin: { kind: 'composer' }, isExpanded: false },
  })
  await row.press({ key: 'peek-msg-1-1' })
  await row.unmount()
  expect(opened).toEqual([{ focus: true }])

  const pane = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'image-peek',
    props: { title: 'Images', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect((await pane.find({ type: 'Text', text: /^Image 1$/ }))?.text).toBe('Image 1')
  await pane.press({ key: 'back' })
  await pane.unmount()
  const list = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'image-peek',
    props: { title: 'Images', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect((await list.find({ type: 'Text', text: /^Sent$/ }))?.text).toBe('Sent')
  expect(await list.find({ key: 'back' })).toBeUndefined()
  await list.unmount()
})
