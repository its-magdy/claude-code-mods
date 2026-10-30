import type { Register } from 'claude-code'

import { changed, edited, submitted } from './capture'
import { drawBand, drawRow } from './chips'
import { ensureDir, host, hostFor, openExternally, removeDir, sweepStale } from './host'
import { latest } from './list'
import { graphics } from './picture'
import { PANE, drawPane, openPane, resetPane } from './pane'
import { later, pictures, reset } from './pictures'
import { noteViewport, toggleDebug } from './session'
import { keepSent, loadHistory } from './stored'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'peek',
      description: 'Show pasted images: /peek, /peek N, /peek open N, /peek clear, /peek debug',
      argumentHint: '[N | open N | clear | debug]',
    })
    later($, 'start', async work => {
      await graphics($, options)
      await loadHistory($, options, work)
      await sweepStale($, await host($))
    })
    // Renews the folder's lease while the session lives, so no other
    // session's sweep takes it for abandoned.
    $.clock.every(60 * 60 * 1000, () => {
      void host($).then(h => ensureDir($, h))
    })
    return started
  })

  // No session.start follows a /clear or an in-session /resume: the process
  // goes on under a new id, so the old pictures go and a resumed
  // conversation's are read back here. A real exit shares one short bound
  // with every plugin; what it leaves, the next start sweeps.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    await reset($, 'leave')
    await resetPane($, 'session')
    const old = await hostFor($, e.sessionId)
    if (e.reason === 'clear' || e.reason === 'resume') {
      later($, 'switch', async work => {
        await removeDir($, old)
        if (e.reason === 'resume') await loadHistory($, options, work)
      }, 300)
    } else if (old.os !== 'windows' && next.budget.remainingMs > 300) {
      await removeDir($, old)
    }
    return ended
  })

  // The draft's pictures: what a paste, a drop or an engine insert put in
  // the box, and the tag a submit gives them (see capture.ts).
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await edited($, options, e, box)
    return box
  }).catch(($, e, next) => next(e))

  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    await changed($, options, e)
    return result
  }).catch(($, e, next) => next(e))

  // Tags the draft's pictures before the prompt's row draws, so the row
  // finds them even before the stored bytes arrive.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    await submitted($, e)
    return result
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (stored.deny === undefined && e.agentId === undefined && e.message.type === 'user' && e.door === 'prompt') {
      const content = stored.message.content
      if (content.some(b => b.type === 'image')) {
        const messageId = stored.uuid
        later($, 'sent', work => keepSent($, options, work, content, messageId))
      }
    }
    return stored
  }).catch(($, e, next) => next(e))

  // The band above the prompt and a sent prompt's row: a chip per picture,
  // pressed to show it big in the pane (see chips.tsx).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    noteViewport(e.viewport)
    return (await drawBand($, e, options)) ?? next(e)
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    noteViewport(e.viewport)
    return (await drawRow($, e, options, () => next(e))) ?? next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    noteViewport(e.viewport)
    return drawPane($, e, options)
  })

  on('command.run', { command: 'peek' }, async ($, e) => {
    const [first, second] = e.args.trim().split(/\s+/).filter(Boolean)
    if (first === 'debug') {
      const isOn = await toggleDebug($)
      return { text: `Debug lines ${isOn ? 'shown in the transcript' : 'in the debug log only'}.` }
    }
    if (first === 'clear') {
      await reset($, 'delete')
      await resetPane($, 'list')
      return { text: 'Image list cleared.' }
    }
    const list = await pictures($)
    if (first === undefined) {
      const { isPlaced } = await openPane($)
      return { text: `${list.length} image${list.length === 1 ? '' : 's'}${isPlaced ? '' : ' (no surface draws the pane here)'}.` }
    }
    const isOpen = first === 'open'
    const n = Number(isOpen ? second : first)
    const img = Number.isInteger(n) ? latest(list, n) : undefined
    if (!img) return { text: `No Image #${isOpen ? second ?? '?' : first} yet. Usage: /peek [N | open N | clear | debug]` }
    if (isOpen || (await graphics($, options)) === 'off') {
      const isOpened = await openExternally($, await host($), img.path)
      return { text: isOpened ? `Opened Image #${n} in the system viewer.` : `Could not open ${img.path}.` }
    }
    await openPane($, img)
    return { text: `Showing Image #${n}.` }
  })
}
