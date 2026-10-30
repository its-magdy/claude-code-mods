import { expect, mock, test } from 'claude-code/testing'
import type { FsStat } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

type $ = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const ROOT = '/t/claude-image-peek'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = 10 * DAY

const dir = (mtimeMs: number): FsStat => ({ kind: 'dir', size: 0, mtimeMs, isLink: false })
const file = (mtimeMs: number): FsStat => ({ kind: 'file', size: 1, mtimeMs, isLink: false })

/**
 * A session `sess-1` on macOS (or Windows), its folder's parent holding the
 * folders `stats` names: each process the mod runs and each lease it writes
 * is recorded, and every process succeeds.
 */
function world(on: On, { os = 'mac', stats = {} }: { os?: 'mac' | 'windows'; stats?: Record<string, FsStat> } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const runs: string[][] = []
  const leases: { path: string; text: string }[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', (_, e) => ({ value: os === 'windows' ? { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\L' }[e.name] : e.name === 'TMPDIR' ? '/t/' : undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('fs.write', (_, e) => {
    leases.push({ path: e.path, text: String(e.text) })
    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: Object.entries(stats)
      .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === e.path)
      .map(([path, stat]) => ({ name: path.slice(path.lastIndexOf('/') + 1), ...stat })),
  }))
  on('fs.stat', (_, e) => {
    const stat = stats[e.path]
    if (!stat) throw new Error('ENOENT')
    return { value: stat }
  })
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: e.argv[0] === 'uname' ? 'Darwin 25.0.0' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const removed = () => runs.filter(argv => argv[0] === 'rm' || argv.at(-1)?.startsWith('Remove-Item')).map(argv => argv.at(-1)!)
  return { clock, runs, leases, removed }
}

const start = ($: $) => $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
const end = ($: $, reason: 'clear' | 'resume' | 'prompt_input_exit') =>
  $.session.end({ reason, sessionId: 'sess-1', resume: { id: 'sess-1' } })

test("a start sweeps other sessions' folders whose lease is a day old, and no other", async ($, on) => {
  const w = world(on, {
    stats: {
      [`${ROOT}/sess-1`]: dir(0), // this session's own: never
      [`${ROOT}/stale`]: dir(NOW),
      [`${ROOT}/stale/.lease`]: file(NOW - DAY - 1),
      [`${ROOT}/live`]: dir(0),
      [`${ROOT}/live/.lease`]: file(NOW - DAY + HOUR),
      [`${ROOT}/unleased`]: dir(NOW - 2 * DAY), // no lease: the folder's own age
      [`${ROOT}/odd.name`]: dir(0), // not a session's folder
      [`${ROOT}/a-file`]: file(0),
    },
  })
  await start($)
  await w.clock.settle()
  expect(w.removed().sort()).toEqual([`${ROOT}/stale`, `${ROOT}/unleased`])
})

test("a living session renews its folder's lease every hour", async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  expect(w.leases).toEqual([])
  await w.clock.advance(HOUR)
  expect(w.leases).toEqual([{ path: `${ROOT}/sess-1/.lease`, text: String(NOW + HOUR) }])
  // Made readable by this user alone the first time only.
  expect(w.runs.filter(argv => argv[0] === 'chmod')).toEqual([['chmod', '700', ROOT, `${ROOT}/sess-1`]])
  await w.clock.advance(2 * HOUR)
  expect(w.leases.map(lease => lease.text)).toEqual([NOW + HOUR, NOW + 2 * HOUR, NOW + 3 * HOUR].map(String))
  expect(w.runs.filter(argv => argv[0] === 'chmod')).toHaveLength(1)
})

test('an exit deletes the folder at once', async ($, on) => {
  const w = world(on)
  await end($, 'prompt_input_exit')
  expect(w.removed()).toEqual([`${ROOT}/sess-1`])
})

test('an exit on Windows leaves the folder for the next start to sweep', async ($, on) => {
  const w = world(on, { os: 'windows' })
  await end($, 'prompt_input_exit')
  await w.clock.advance(1000)
  expect(w.removed()).toEqual([])
})

for (const reason of ['clear', 'resume'] as const) {
  test(`a /${reason} deletes the old folder once the switch has settled`, async ($, on) => {
    const w = world(on)
    await end($, reason)
    await w.clock.settle()
    expect(w.removed()).toEqual([])
    await w.clock.advance(300)
    expect(w.removed()).toEqual([`${ROOT}/sess-1`])
  })
}
