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

  it('swallows send failures (reporting never throws, and retries only when asked or timed)', async () => {
    const h = harness({ fail: true })
    h.q.add(crash())
    await expect(h.q.flush()).resolves.toBeUndefined()
    expect(h.sent).toHaveLength(1)
    expect(h.hasTimer()).toBe(true)
  })
})

describe('ErrorQueue: sizes, failures and retries (I4)', () => {
  const big = (i: number): ClientErrorEvent => ({
    kind: 'crash', t: 1, errorType: 'TypeError', message: `big ${'abcdefghij'[i]}`, stack: 'at f (https://virvi.io/a.js:1:1)\n'.repeat(115),
    breadcrumbs: Array.from({ length: 30 }, () => ({ t: 1, type: 'api' as const, method: 'GET', path: '/api/' + 'x'.repeat(150), status: 500, ms: 3 })),
  })
  function h2(results: Array<'ok' | 'retry' | 'drop'>) {
    const calls: Array<{ events: ClientErrorEvent[]; keepalive: boolean; bytes: number }> = []
    let timer: (() => void) | null = null
    const q = new ErrorQueue({
      send: async (events, o) => { calls.push({ events, keepalive: o.keepalive, bytes: JSON.stringify({ v: 1, release: 'dev', events }).length }); return results.shift() ?? 'ok' },
      setTimer: (fn) => { timer = fn; return 1 },
      clearTimer: () => { timer = null },
    })
    return { q, calls, fire: async () => { const t = timer; timer = null; t?.(); await new Promise((r) => setTimeout(r, 0)) } }
  }

  it('splits a batch so every send stays under the body and keepalive limit', async () => {
    const h = h2([])
    for (let i = 0; i < 10; i++) h.q.add(big(i))
    await h.q.flush()
    expect(h.calls.length).toBeGreaterThan(1)
    for (const c of h.calls) expect(c.bytes).toBeLessThan(60_000)
    expect(h.calls.flatMap((c) => c.events)).toHaveLength(10)
  })

  it('trims the breadcrumbs of later events in the same send', async () => {
    const h = h2([])
    h.q.add(big(0))
    h.q.add(big(1))
    await h.q.flush()
    const [first, second] = h.calls[0].events
    expect(first.breadcrumbs).toHaveLength(30)
    expect(second.breadcrumbs!.length).toBeLessThanOrEqual(10)
  })

  it('a failed send is not marked sent and is retried, a few times at most', async () => {
    const h = h2(['retry', 'retry', 'ok'])
    h.q.add(crash())
    await h.q.flush()
    await h.fire()
    await h.fire()
    expect(h.calls).toHaveLength(3)
    expect(h.calls.every((c) => !c.events[0].repeat && c.events[0].breadcrumbs)).toBe(true) // still the full first occurrence
    h.q.add(crash())
    await h.q.flush()
    expect(h.calls[3].events[0].repeat).toBe(true) // sent once it got through
    const g = h2(['retry', 'retry', 'retry', 'retry', 'retry'])
    g.q.add(crash())
    await g.q.flush()
    for (let i = 0; i < 5; i++) await g.fire()
    expect(g.calls).toHaveLength(3)
  })

  it('a refused send (413, 400) is dropped, not retried', async () => {
    const h = h2(['drop'])
    h.q.add(crash())
    await h.q.flush()
    await h.fire()
    expect(h.calls).toHaveLength(1)
  })

  it('uses keepalive only when the page is going away', async () => {
    const h = h2([])
    h.q.add(crash('a'))
    await h.q.flush()
    h.q.add(crash('b'))
    await h.q.flush({ keepalive: true })
    expect(h.calls.map((c) => c.keepalive)).toEqual([false, true])
  })
})
