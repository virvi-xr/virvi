import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beats, beatScenes, mediaAssets } from '../src/db/schema.js'
import { geocodeAddress, resetGeocoder } from '../src/beats/geocode.js'
import { setImageSizeReader } from '../src/beats/image.js'
import { resetDb } from './helpers/db.js'
import { BEATS_READY } from './helpers/beats-ready.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
const H = 3_600_000
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

const hit = (lat: string, lon: string) => new Response(JSON.stringify([{ lat, lon }]), { status: 200 })
const none = () => new Response('[]', { status: 200 })

describe('geocodeAddress', () => {
  beforeEach(() => { resetGeocoder(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('parses lat and lng from the strings the geocoder returns, with the User-Agent and the address query', async () => {
    const fetcher = vi.fn(async () => hit('38.7223', '-9.1393'))
    const p = geocodeAddress({ venue: 'The Hall', address: 'Rua A 1', city: 'Lisbon', country: 'Portugal' }, fetcher as any)
    await vi.runAllTimersAsync()
    expect(await p).toEqual({ lat: 38.7223, lng: -9.1393 })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://nominatim.openstreetmap.org/search')
    expect(u.searchParams.get('format')).toBe('jsonv2')
    expect(u.searchParams.get('limit')).toBe('1')
    expect(u.searchParams.get('q')).toBe('Rua A 1, Lisbon, Portugal')
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('Virvi/1.0 (+https://virvi.io)')
  })

  it('returns null for an empty result (after trying the venue name too)', async () => {
    const fetcher = vi.fn(async () => none())
    const p = geocodeAddress({ venue: 'The Hall', address: 'Nowhere 1', city: 'Lisbon', country: 'Portugal' }, fetcher as any)
    await vi.runAllTimersAsync()
    expect(await p).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not call the geocoder twice for the same query', async () => {
    const fetcher = vi.fn(async () => hit('1', '2'))
    const parts = { address: 'Rua A 1', city: 'Lisbon', country: 'Portugal' }
    const a = geocodeAddress(parts, fetcher as any)
    await vi.runAllTimersAsync()
    await a
    const b = geocodeAddress({ ...parts, address: '  rua a 1 ' }, fetcher as any)
    await vi.runAllTimersAsync()
    expect(await b).toEqual({ lat: 1, lng: 2 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('spaces two requests in the same second by at least 1000 ms', async () => {
    const times: number[] = []
    const fetcher = vi.fn(async () => { times.push(Date.now()); return hit('1', '2') })
    const a = geocodeAddress({ address: 'One', city: 'C', country: 'P' }, fetcher as any)
    const b = geocodeAddress({ address: 'Two', city: 'C', country: 'P' }, fetcher as any)
    await vi.runAllTimersAsync()
    await Promise.all([a, b])
    expect(times).toHaveLength(2)
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000)
  })

  it('tries the address before the venue name, and the venue only when the address finds nothing', async () => {
    const queries: string[] = []
    const fetcher = vi.fn(async (url: string) => { queries.push(new URL(url).searchParams.get('q')!); return queries.length === 1 ? none() : hit('3', '4') })
    const p = geocodeAddress({ venue: 'The Hall', address: 'Rua A 1', city: 'Lisbon', country: 'Portugal' }, fetcher as any)
    await vi.runAllTimersAsync()
    expect(await p).toEqual({ lat: 3, lng: 4 })
    expect(queries).toEqual(['Rua A 1, Lisbon, Portugal', 'The Hall, Lisbon, Portugal'])
  })

  it('returns null when the geocoder fails or answers with junk', async () => {
    const p = geocodeAddress({ address: 'Boom', city: 'C', country: 'P' }, (async () => { throw new Error('down') }) as any)
    await vi.runAllTimersAsync()
    expect(await p).toBeNull()
  })
})

describe('venue pin on BEATs', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let sceneA: string
  let imageId: string
  const prev = config.beats

  beforeEach(async () => {
    await resetDb()
    resetGeocoder()
    setImageSizeReader(async () => ({ width: 1024, height: 1024 }))
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon', ...BEATS_READY }
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    sceneA = (await createScene(host, 'A')).scene.id
    const [m] = await db.insert(mediaAssets).values({ ownerId: host.id, filename: 'b.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'k', publicUrl: 'https://cdn.example/p.png' }).returning()
    imageId = m.id
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    setImageSizeReader(null)
    await app.close()
  })

  const call = (method: string, url: string, user: TestUser = host, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: as(user), payload: payload as any })
  const venue = (pin?: unknown) => ({ type: 'in_person', venue: 'The Hall', city: 'Lisbon', country: 'Portugal', ...(pin === undefined ? {} : { pin }) })
  let slot = 0
  // Each BEAT gets its own window: one scene can't host two at once
  const create = (location: unknown) => call('POST', '/api/beats', host, {
    name: 'Opening night', description: 'Thanks', imageMediaId: imageId, startsAt: iso((2 + 3 * slot) * H), endsAt: iso((4 + 3 * slot++) * H),
    minPresentMinutes: 5, supplyCap: 100, tradeable: false, sceneIds: [sceneA], location,
  })

  it('stores an in-person pin with the default radius, and shows it to the host', async () => {
    const res = await create(venue({ lat: 38.7223, lng: -9.1393 }))
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().location.pin).toEqual({ lat: 38.7223, lng: -9.1393, radiusM: 150 })
    const row = (await db.query.beats.findFirst({ where: eq(beats.id, res.json().id) }))!
    expect([row.pinLat, row.pinLng, row.pinRadiusM]).toEqual([38.7223, -9.1393, 150])
  })

  it('has no pin when none is given or it is null', async () => {
    expect((await create(venue())).json().location.pin).toBeNull()
    expect((await create(venue(null))).json().location.pin).toBeNull()
  })

  it('refuses a pin on a scene or online location (400)', async () => {
    const scene = await create({ type: 'scene', pin: { lat: 1, lng: 2 } })
    expect([scene.statusCode, scene.json().error]).toEqual([400, 'bad_location'])
    const online = await create({ type: 'online', platform: 'Zoom', url: 'https://zoom.us/j/1', pin: { lat: 1, lng: 2 } })
    expect(online.statusCode).toBe(400)
  })

  it('refuses a radius outside 50 to 1000, and a lat or lng out of range (400)', async () => {
    for (const pin of [
      { lat: 1, lng: 2, radiusM: 40 }, { lat: 1, lng: 2, radiusM: 1001 }, { lat: 1, lng: 2, radiusM: 99.5 },
      { lat: 91, lng: 2 }, { lat: -91, lng: 2 }, { lat: 1, lng: 181 }, { lat: 1, lng: -181 },
      { lat: '1', lng: 2 }, { lat: 1 }, 'here', { lat: NaN, lng: 2 },
    ]) {
      const r = await create(venue(pin))
      expect([JSON.stringify(pin), r.statusCode, r.json().error]).toEqual([JSON.stringify(pin), 400, 'bad_location'])
    }
    expect((await create(venue({ lat: 90, lng: -180, radiusM: 50 }))).statusCode).toBe(201)
    expect((await create(venue({ lat: -90, lng: 180, radiusM: 1000 }))).statusCode).toBe(201)
  })

  it('a draft can change its pin, and drop it', async () => {
    const id = (await create(venue({ lat: 1, lng: 2 }))).json().id
    const moved = await call('PATCH', `/api/beats/${id}`, host, { location: venue({ lat: 3, lng: 4, radiusM: 80 }) })
    expect(moved.json().location.pin).toEqual({ lat: 3, lng: 4, radiusM: 80 })
    const dropped = await call('PATCH', `/api/beats/${id}`, host, { location: venue() })
    expect(dropped.json().location.pin).toBeNull()
  })

  it('locks the pin at go-live like the rest of the location (409), but accepts it unchanged', async () => {
    const [b] = await db.insert(beats).values({
      chain: 'polygon', ownerUserId: host.id, name: 'Seed', description: '', imageMediaId: imageId, status: 'live', tokenId: 31,
      startsAt: new Date(Date.now() - H), endsAt: new Date(Date.now() + H), artFailedAt: new Date(),
      locationType: 'in_person', locationVenue: 'The Hall', locationCity: 'Lisbon', locationCountry: 'Portugal',
      pinLat: 1, pinLng: 2, pinRadiusM: 150,
    }).returning()
    await db.insert(beatScenes).values({ beatId: b.id, sceneId: sceneA })
    const moved = await call('PATCH', `/api/beats/${b.id}`, host, { imageMediaId: imageId, location: venue({ lat: 5, lng: 6 }) })
    expect([moved.statusCode, moved.json().error]).toEqual([409, 'locked'])
    const wider = await call('PATCH', `/api/beats/${b.id}`, host, { imageMediaId: imageId, location: venue({ lat: 1, lng: 2, radiusM: 500 }) })
    expect(wider.statusCode).toBe(409)
    const same = await call('PATCH', `/api/beats/${b.id}`, host, { imageMediaId: imageId, location: venue({ lat: 1, lng: 2 }) })
    expect(same.statusCode, same.body).toBe(200)
  })

  it('never puts the pin in the token metadata', async () => {
    const id = (await create(venue({ lat: 38.7223, lng: -9.1393, radiusM: 120 }))).json().id
    await db.update(beats).set({ status: 'live', tokenId: 41 }).where(eq(beats.id, id))
    const res = await app.inject({ method: 'GET', url: '/api/beats/metadata/polygon/41.json' })
    expect(res.statusCode, res.body).toBe(200)
    for (const needle of ['38.7223', '9.1393', 'radius', '"pin', 'latitude']) expect(res.body.toLowerCase()).not.toContain(needle.toLowerCase())
  })
})

describe('POST /api/beats/geocode', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let user: TestUser
  const prev = config.beats
  beforeEach(async () => {
    await resetDb()
    resetGeocoder()
    ;(config as any).beats = { ...config.beats, enabled: true }
    app = await testApp()
    user = await createUser({ wallet: randomWallet() })
  })
  afterEach(async () => { ;(config as any).beats = prev; vi.unstubAllGlobals(); await app.close() })
  const post = (payload: unknown, headers: Record<string, string> | undefined = as(user)) => app.inject({ method: 'POST', url: '/api/beats/geocode', headers, payload: payload as any })

  it('needs a sign-in', async () => {
    expect((await post({ country: 'Portugal' }, {})).statusCode).toBe(401)
  })

  it('answers with the pin, or null when nothing is found', async () => {
    const fetchMock = vi.fn(async () => hit('38.7', '-9.1'))
    vi.stubGlobal('fetch', fetchMock)
    const ok = await post({ address: 'Rua A 1', city: 'Lisbon', country: 'Portugal' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toEqual({ pin: { lat: 38.7, lng: -9.1 } })
    vi.stubGlobal('fetch', vi.fn(async () => none()))
    const miss = await post({ address: 'Nowhere 9', city: 'Lisbon', country: 'Portugal' })
    expect(miss.json()).toEqual({ pin: null })
  }, 15_000)

  it('refuses a body with no country (400)', async () => {
    expect((await post({ address: 'x' })).statusCode).toBe(400)
  })

  it('answers 429 over 10 a minute per user, from the cache or not', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => hit('1', '2')))
    for (let i = 0; i < 10; i++) expect((await post({ address: 'Same', city: 'C', country: 'P' })).statusCode).toBe(200)
    const over = await post({ address: 'Same', city: 'C', country: 'P' })
    expect(over.statusCode).toBe(429)
    const other = await createUser({ wallet: randomWallet() })
    expect((await post({ address: 'Same', city: 'C', country: 'P' }, as(other))).statusCode).toBe(200)
  })
})
