import { describe, it, expect } from 'vitest'
import type { ClientErrorEvent } from '@virvixr/shared'
import { ErrorQueue, PAGE_CAP } from './queue'

function harness(opts: { fail?: boolean } = {}) {
  const sent: ClientErrorEvent[][] = []
  let timer: (() => void) | null = null
  const q = new ErrorQueue({
    send: async (events) => { sent.push(events); if (opts.fail) throw new Error('offline') },
    setTimer: (fn) => { timer = fn; return 1 },
    clearTimer: () => { timer = null },
  })
  return { q, sent, fire: () => { const t = timer; timer = null; t?.() }, hasTimer: () => !!timer }
}
const crash = (msg = 'Cannot read item 4', over: Partial<ClientErrorEvent> = {}): ClientErrorEvent => ({
  kind: 'crash', t: 1, errorType: 'TypeError', message: msg, stack: 'at f (https://virvi.io/a.js:1:1)', breadcrumbs: [{ t: 1, type: 'nav', path: '/' }], ...over,
})

describe('ErrorQueue: batching and sampling', () => {
  it('sends in small batches: at 10 events, or after a few seconds', async () => {
    const h = harness()
    for (let i = 0; i < 9; i++) h.q.add(crash(`m${String.fromCharCode(97 + i)}`))
    expect(h.sent).toHaveLength(0)
    expect(h.hasTimer()).toBe(true)
    h.q.add(crash('mj'))
    await Promise.resolve()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toHaveLength(10)
    h.q.add(crash('mk'))
    h.fire()
    await Promise.resolve()
    expect(h.sent[1]).toHaveLength(1)
  })

  it('counts repeats of one signature instead of sending each', async () => {
    const h = harness()
    h.q.add(crash('Cannot read item 4'))
    h.q.add(crash('Cannot read item 9'))
    h.q.add(crash('Cannot read item 1'))
    await h.q.flush()
    expect(h.sent[0]).toHaveLength(1)
    expect(h.sent[0][0].count).toBe(3)
    expect(h.sent[0][0].breadcrumbs).toHaveLength(1)
  })

  it('after the first occurrence on this page, later ones go as counted repeats without their details', async () => {
    const h = harness()
    h.q.add(crash())
    await h.q.flush()
    h.q.add(crash())
    h.q.add(crash())
    await h.q.flush()
    expect(h.sent[1]).toEqual([{ kind: 'crash', t: 1, errorType: 'TypeError', message: 'Cannot read item 4', stack: 'at f (https://virvi.io/a.js:1:1)', count: 2, repeat: true }])
  })

  it('stops taking new signatures past the page cap, but still counts known ones', async () => {
    const h = harness()
    for (let i = 0; i < PAGE_CAP + 5; i++) h.q.add(crash(`err ${'x'.repeat(i)}`))
    await h.q.flush()
    const total = h.sent.flat()
    expect(total).toHaveLength(PAGE_CAP)
    expect(h.q.dropped).toBe(5)
  })

  it('swallows send failures (reporting never throws or loops)', async () => {
    const h = harness({ fail: true })
    h.q.add(crash())
    await expect(h.q.flush()).resolves.toBeUndefined()
    await h.q.flush()
    expect(h.sent).toHaveLength(1)
  })
})
