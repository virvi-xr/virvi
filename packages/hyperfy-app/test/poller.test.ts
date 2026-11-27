import { describe, expect, it } from 'vitest'
import { HUD_VERSION_HEADER, HYPERFY_APP_VERSION, type HyperfyFeedResponse } from '@virvixr/shared'
import { FeedPoller } from '../src/poller.js'
import { VisitRecorder } from '../src/visits.js'

type Res = { ok: boolean; status: number; json(): Promise<unknown> } | undefined
type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }

const snap = (version: string): HyperfyFeedResponse => ({ v: 1, version, scene: null })
const ok = (body: unknown): Res => ({ ok: true, status: 200, json: async () => body })
const status = (code: number): Res => ({ ok: false, status: code, json: async () => ({ error: 'x' }) })

/** Fake timers: setTimeout only records; `tick()` runs the oldest pending timer and lets its promises settle. */
function harness(responses: Array<Res | Error>) {
  const calls: Call[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const delays: number[] = []
  const fetch = async (url: string, init: object): Promise<Res> => {
    calls.push({ url, init: init as Call['init'] })
    const r = responses.shift()
    if (r instanceof Error) throw r
    return r
  }
  const setTimeout = (fn: () => void, ms: number) => {
    timers.push({ fn, ms })
    delays.push(ms)
    return timers.length
  }
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  const tick = async () => {
    const t = timers.shift()
    if (!t) throw new Error('no timer pending')
    t.fn()
    await settle()
  }
  return { calls, delays, fetch, setTimeout, settle, tick }
}

function poller(responses: Array<Res | Error>) {
  const h = harness(responses)
  const seen: HyperfyFeedResponse[] = []
  const p = new FeedPoller({
    feedUrl: 'https://api.example',
    worldKey: 'virviw_k',
    fetch: h.fetch,
    setTimeout: h.setTimeout,
    onSnapshot: (r) => seen.push(r),
  })
  return { ...h, seen, p }
}

describe('FeedPoller', () => {
  it('sends since and the world key, and calls onSnapshot only on a new version', async () => {
    const t = poller([ok(snap('a')), ok(snap('a')), ok(snap('b'))])
    t.p.start()
    await t.settle()
    await t.tick()
    await t.tick()
    expect(t.calls.map((c) => c.url)).toEqual([
      'https://api.example/api/hyperfy/feed?since=',
      'https://api.example/api/hyperfy/feed?since=a',
      'https://api.example/api/hyperfy/feed?since=a',
    ])
    for (const c of t.calls) {
      expect(c.init.headers).toMatchObject({ Authorization: 'Bearer virviw_k', 'X-Virvi-App-Version': '1', 'x-virvi-hud-version': HYPERFY_APP_VERSION })
    }
    expect(t.seen.map((s) => s.version)).toEqual(['a', 'b'])
  })

  it('poller backs off on 401 and keeps the last snapshot', async () => {
    const t = poller([ok(snap('a')), ...Array.from({ length: 8 }, () => status(401))])
    t.p.start()
    await t.settle()
    for (let i = 0; i < 8; i++) await t.tick()
    // After the success, the next poll is immediate; then each 401 doubles the wait, capped at 30 s.
    expect(t.delays).toEqual([0, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
    expect(t.seen.map((s) => s.version)).toEqual(['a'])
    expect(t.calls.at(-1)!.url).toBe('https://api.example/api/hyperfy/feed?since=a')
  })

  it("an undefined response from Hyperfy's fetch counts as a failure", async () => {
    const t = poller([undefined, new Error('boom'), ok({ nope: true })])
    t.p.start()
    await t.settle()
    await t.tick()
    await t.tick()
    // undefined, a throw and a malformed body all back off
    expect(t.delays).toEqual([1000, 2000, 4000])
    expect(t.seen).toEqual([])
  })

  it('recovers to immediate polling after a success', async () => {
    const t = poller([status(500), status(500), ok(snap('a')), status(500)])
    t.p.start()
    await t.settle()
    for (let i = 0; i < 3; i++) await t.tick()
    expect(t.delays).toEqual([1000, 2000, 0, 1000])
    expect(t.seen.map((s) => s.version)).toEqual(['a'])
  })

  it('a 404 (scene deleted) clears the world once and keeps backing off', async () => {
    const t = poller([ok(snap('a')), status(404), status(404)])
    t.p.start()
    await t.settle()
    await t.tick()
    await t.tick()
    expect(t.seen).toEqual([snap('a'), { v: 1, version: '', scene: null }])
    expect(t.delays).toEqual([0, 1000, 2000])
  })

  it('stop() ends the loop', async () => {
    const t = poller([ok(snap('a')), ok(snap('b'))])
    t.p.start()
    await t.settle()
    t.p.stop()
    await t.tick()
    expect(t.calls).toHaveLength(1)
    expect(t.delays).toEqual([0])
  })
})

describe('VisitRecorder', () => {
  function recorder(responses: Res[], players: Array<{ id: string; position: { x: number; y: number; z: number } }>) {
    const h = harness(responses)
    let now = 1000
    const r = new VisitRecorder({
      feedUrl: 'https://api.example',
      worldKey: 'virviw_k',
      fetch: h.fetch,
      setTimeout: h.setTimeout,
      now: () => now,
      getPlayers: () => players,
    })
    return { ...h, r, advance: (ms: number) => (now += ms) }
  }
  const bodies = (calls: Call[]) => calls.map((c) => JSON.parse(c.init.body!))

  it('samples positions, queues enter and leave, and posts them on flush', async () => {
    const t = recorder([ok({ accepted: 3 })], [{ id: 'p1', position: { x: 1, y: 2, z: 3 } }])
    t.r.start() // p1 is already here: recorded as entering
    // timers: [sample at 5 s, flush at 15 s]
    expect(t.delays).toEqual([5000, 15000])
    t.advance(5000)
    await t.tick() // sample
    t.r.leave('p1')
    await t.tick() // flush
    expect(t.calls[0].url).toBe('https://api.example/api/hyperfy/analytics')
    expect(t.calls[0].init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer virviw_k' } })
    expect(bodies(t.calls)).toEqual([
      {
        v: 1,
        events: [
          { type: 'enter', playerId: 'p1', t: 1000 },
          { type: 'pos', playerId: 'p1', t: 6000, x: 1, y: 2, z: 3 },
          { type: 'leave', playerId: 'p1', t: 6000 },
        ],
      },
    ])
  })

  it('keeps events after a failed flush and caps the queue at 1,000, dropping the oldest', async () => {
    const t = recorder([undefined, ok({}), ok({}), ok({}), ok({}), ok({})], [])
    t.r.start()
    for (let i = 0; i < 1005; i++) t.r.enter(`p${i}`)
    await t.tick() // sample (no players)
    await t.tick() // flush fails
    expect(t.calls).toHaveLength(1)
    await t.tick() // next sample
    await t.tick() // flush succeeds, in batches of 200
    const sent = bodies(t.calls.slice(1)).flatMap((b) => b.events)
    expect(sent).toHaveLength(1000)
    expect(sent[0].playerId).toBe('p5')
    expect(bodies(t.calls.slice(1)).every((b) => b.events.length <= 200)).toBe(true)
  })
  it('records players already in the world when it starts', async () => {
    const players = [{ id: 'p1', position: { x: 0, y: 0, z: 0 } }, { id: 'p2', position: { x: 0, y: 0, z: 0 } }]
    const t = recorder([ok({})], players)
    t.r.start()
    await t.tick() // sample
    await t.tick() // flush
    const events = bodies(t.calls)[0].events
    expect(events.filter((e: { type: string }) => e.type === 'enter')).toEqual([
      { type: 'enter', playerId: 'p1', t: 1000 },
      { type: 'enter', playerId: 'p2', t: 1000 },
    ])
  })

  it('drops a batch the server refuses (4xx), and keeps retrying on 429, 5xx and network failures', async () => {
    const t = recorder([status(400), ok({}), status(429), status(503), undefined, ok({})], [])
    t.r.start()
    t.r.enter('bad')
    await t.tick() // sample
    await t.tick() // flush: 400, dropped
    expect(t.calls).toHaveLength(1)
    t.r.enter('good')
    await t.tick() // sample
    await t.tick() // flush: ok, only the new event
    expect(bodies(t.calls.slice(1, 2))[0].events.map((e: { playerId: string }) => e.playerId)).toEqual(['good'])
    t.r.enter('kept')
    for (let i = 0; i < 4; i++) {
      await t.tick() // sample
      await t.tick() // flush: 429, 503, network failure, then ok
    }
    const tries = bodies(t.calls.slice(2)).map((b) => b.events.map((e: { playerId: string }) => e.playerId))
    expect(tries).toEqual([['kept'], ['kept'], ['kept'], ['kept']])
  })
})

describe('HYPERFY_APP_VERSION', () => {
  it("matches the package's version, so a rebuilt .hyp reports its own release", async () => {
    const { readFile } = await import('node:fs/promises')
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(HYPERFY_APP_VERSION).toBe(pkg.version)
    expect(HUD_VERSION_HEADER).toBe("x-virvi-hud-version") // the poller spells it out
  })
})
