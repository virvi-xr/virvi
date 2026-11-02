import { describe, expect, it } from 'vitest'
import { VirviApi } from '../src/virvi-api.js'

type Res = { ok: boolean; status: number; json(): Promise<unknown> } | undefined
type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }
const res = (status: number, body: unknown = {}): Res => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function make(responses: Array<Res | Error>, pass: string | null = 'P', renew: (() => string | null) | null = null) {
  const calls: Call[] = []
  let auth = 0
  const api = new VirviApi({
    feedUrl: 'https://api.example',
    fetch: async (url, init) => {
      calls.push({ url, init: init as Call['init'] })
      const r = responses.shift()
      if (r instanceof Error) throw r
      return r
    },
    getPass: () => pass,
    onAuthFailure: async () => {
      auth++
      const next = renew ? renew() : null
      if (!next) return false
      pass = next
      return true
    },
  })
  return { api, calls, auth: () => auth }
}
const T = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 45, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
const body = (c: Call) => JSON.parse(c.init.body!)

describe('VirviApi', () => {
  it('403 on save maps to the no-access reason', async () => {
    const t = make([res(403, { error: 'Forbidden' })])
    expect(await t.api.saveTransform('i1', T)).toEqual({ ok: false, reason: 'no_access' })
    expect(t.auth()).toBe(0)
  })

  it('a 401 renews and retries once with the fresh pass', async () => {
    const t = make([res(401), res(200, { ok: 1 })], 'OLD', () => 'NEW')
    expect(await t.api.saveTransform('i1', T)).toEqual({ ok: true, value: { ok: 1 } })
    expect(t.auth()).toBe(1)
    expect(t.calls.map((c) => c.init.headers!.Authorization)).toEqual(['Bearer OLD', 'Bearer NEW'])
    expect(body(t.calls[1])).toEqual(body(t.calls[0]))
  })

  it('no pass renews first, then sends; a second 401 after renewing is auth without another retry', async () => {
    const n = make([res(200, {})], null, () => 'NEW')
    expect((await n.api.setEnabled('e1', true)).ok).toBe(true)
    expect(n.calls.map((c) => c.init.headers!.Authorization)).toEqual(['Bearer NEW'])
    const twice = make([res(401), res(401)], 'OLD', () => 'NEW')
    expect(await twice.api.setEnabled('e1', true)).toEqual({ ok: false, reason: 'auth' })
    expect(twice.calls).toHaveLength(2)
    expect(twice.auth()).toBe(1)
  })

  it('401 is auth and calls onAuthFailure; no pass is auth without a request', async () => {
    const t = make([res(401)])
    expect(await t.api.setEnabled('e1', true)).toEqual({ ok: false, reason: 'auth' })
    expect(t.auth()).toBe(1)
    const n = make([], null)
    expect(await n.api.setEnabled('e1', true)).toEqual({ ok: false, reason: 'auth' })
    expect(n.calls).toHaveLength(0)
    expect(n.auth()).toBe(1)
  })

  it('undefined fetch is lost-connection, then recovers', async () => {
    const t = make([undefined, new Error('boom'), res(200, { instance: { id: 'i1' } })])
    expect(await t.api.saveTransform('i1', T)).toEqual({ ok: false, reason: 'lost' })
    expect(await t.api.saveTransform('i1', T)).toEqual({ ok: false, reason: 'lost' })
    expect((await t.api.saveTransform('i1', T)).ok).toBe(true)
  })

  it('maps 400/404/409 to invalid and 5xx to server', async () => {
    const t = make([res(400), res(404), res(409), res(500), res(502)])
    const r = []
    for (let i = 0; i < 5; i++) r.push(await t.api.setLive('e1', true))
    expect(r.map((x) => (x.ok ? 'ok' : x.reason))).toEqual(['invalid', 'invalid', 'invalid', 'server', 'server'])
  })

  it('uses the real routes and bodies, with the pass as a bearer', async () => {
    const t = make([
      res(200, { instance: {} }),
      res(200, { element: {} }),
      res(200, { scene: {} }),
      res(200, { element: {} }),
      res(200, { items: [{ id: 'l1', name: 'Chair', kind: 'model', url: 'u' }] }),
      res(200, { assets: [{ id: 'a1', name: 'Rock' }], total: 1 }),
      res(201, { id: 'l2' }),
    ])
    await t.api.saveTransform('i1', T)
    await t.api.setEnabled('e1', false)
    await t.api.setPreset('s1', 'p1')
    await t.api.setLive('e1', true)
    const lib = await t.api.listLibrary('s1')
    const cat = await t.api.listCatalog('rock & roll')
    await t.api.addFromCatalog('s1', { id: 'a1' })
    const seen = t.calls.map((c) => `${c.init.method} ${c.url.replace('https://api.example', '')}`)
    expect(seen).toEqual([
      'PUT /api/instances/i1',
      'PUT /api/elements/e1',
      'PUT /api/scenes/s1',
      'POST /api/elements/e1/live',
      'GET /api/scenes/s1/library',
      'GET /api/assets?q=rock%20%26%20roll&limit=24',
      'POST /api/scenes/s1/library',
    ])
    expect(body(t.calls[0])).toEqual(T)
    expect(body(t.calls[1])).toEqual({ enabled: false })
    expect(body(t.calls[2])).toEqual({ activePresetId: 'p1' })
    expect(body(t.calls[3])).toEqual({ enabled: true })
    expect(t.calls[4].init.body).toBeUndefined()
    expect(body(t.calls[6])).toEqual({ assetItemId: 'a1' })
    expect(t.calls.every((c) => c.init.headers!.Authorization === 'Bearer P')).toBe(true)
    expect(lib).toEqual({ ok: true, value: [{ id: 'l1', name: 'Chair', kind: 'model', url: 'u' }] })
    expect(cat).toEqual({ ok: true, value: { assets: [{ id: 'a1', name: 'Rock' }], total: 1 } })
  })

  it('placeModel creates a model element then its instance; a failed instance removes the element', async () => {
    const t = make([res(201, { element: { id: 'e9' } }), res(201, { instance: { id: 'i9' } })])
    const r = await t.api.placeModel('p1', 'https://cdn/x/My%20Rock.glb', T)
    expect(r).toEqual({ ok: true, value: { elementId: 'e9', instanceId: 'i9' } })
    expect(t.calls[0].url).toBe('https://api.example/api/presets/p1/elements')
    expect(body(t.calls[0])).toEqual({ type: 'model', name: 'My Rock', properties: { modelSrc: 'https://cdn/x/My%20Rock.glb' } })
    expect(t.calls[1].url).toBe('https://api.example/api/elements/e9/instances')
    expect(body(t.calls[1])).toEqual(T)

    const f = make([res(201, { element: { id: 'e9' } }), res(403), res(200)])
    expect(await f.api.placeModel('p1', 'https://cdn/r.glb', T)).toEqual({ ok: false, reason: 'no_access' })
    expect(f.calls[2].init.method).toBe('DELETE')
    expect(f.calls[2].url).toBe('https://api.example/api/elements/e9')
  })

  it('placeModel takes a given name over the URL\'s file name, without .glb', async () => {
    const t = make([res(201, { element: { id: 'e9' } }), res(201, { instance: { id: 'i9' } })])
    await t.api.placeModel('p1', 'https://cdn/u/3cb079fe-bc44-4ebf-87db-459e003c7c3f.glb', T, ' Chair.glb ')
    expect(body(t.calls[0]).name).toBe('Chair')
  })

  it('getScene reads the scene and its presets with the pass', async () => {
    const t = make([res(200, { scene: { id: 's1', activePresetId: 'p1', presets: [{ id: 'p1', name: 'Day' }, { id: 'p2', name: 'Night', extra: 1 }] } })])
    expect(await t.api.getScene('s1')).toEqual({ ok: true, value: { id: 's1', activePresetId: 'p1', presets: [{ id: 'p1', name: 'Day' }, { id: 'p2', name: 'Night' }] } })
    expect(t.calls[0].url).toBe('https://api.example/api/scenes/s1')
    expect(t.calls[0].init).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer P' } })
  })
})
