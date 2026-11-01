import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { config } from '../src/config.js'
import { LEGACY_ENTITY_LABEL, mergeLegacyEntityTargets, resetEmoteLabelCache, resolveEmoteLabels } from '../src/analytics/labels.js'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const URN_A = 'urn:decentraland:matic:collections-v2:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0'
const URN_B = 'urn:decentraland:matic:collections-v2:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:3'
const entity = (urn: string, name: string) => ({ pointers: [urn], metadata: { name } })

describe('resolveEmoteLabels', () => {
  beforeEach(() => resetEmoteLabelCache())
  afterEach(() => vi.unstubAllGlobals())

  it('title-cases base emote ids without calling the catalyst', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await resolveEmoteLabels(['wave', 'fistpump', 'dance'])).toEqual({ wave: 'Wave', fistpump: 'Fistpump', dance: 'Dance' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves collection URNs with one batched catalyst call', async () => {
    const fetchMock = vi.fn(async () => json([entity(URN_A, 'Cool Dance'), entity(URN_B, 'Backflip')]))
    vi.stubGlobal('fetch', fetchMock)
    const labels = await resolveEmoteLabels([URN_A, 'wave', URN_B])
    expect(labels).toEqual({ [URN_A]: 'Cool Dance', wave: 'Wave', [URN_B]: 'Backflip' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${config.catalystUrl}/content/entities/active`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ pointers: [URN_A, URN_B] })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('matches pointers case-insensitively', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([entity(URN_A.toLowerCase(), 'Cool Dance')])))
    const mixed = URN_A.replace('0xaaaa', '0xAAAA')
    expect(await resolveEmoteLabels([mixed])).toEqual({ [mixed]: 'Cool Dance' })
  })

  it('caches resolved names until the TTL passes', async () => {
    const fetchMock = vi.fn(async () => json([entity(URN_A, 'Cool Dance')]))
    vi.stubGlobal('fetch', fetchMock)
    let t = 1_000
    await resolveEmoteLabels([URN_A], { now: () => t })
    await resolveEmoteLabels([URN_A], { now: () => t + 23 * 3_600_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await resolveEmoteLabels([URN_A], { now: () => t + 25 * 3_600_000 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('only asks the catalyst for URNs it does not know yet', async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => json(JSON.parse(init.body as string).pointers.map((p: string) => entity(p, p === URN_A ? 'A' : 'B'))))
    vi.stubGlobal('fetch', fetchMock)
    await resolveEmoteLabels([URN_A])
    await resolveEmoteLabels([URN_A, URN_B])
    expect(JSON.parse((fetchMock.mock.calls[1] as any)[1].body)).toEqual({ pointers: [URN_B] })
  })

  it('falls back to a short readable label on HTTP errors, network errors and unknown URNs, and never throws', async () => {
    const short = '0xaaaa…aaaa:0'
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)))
    expect(await resolveEmoteLabels([URN_A])).toEqual({ [URN_A]: short })
    resetEmoteLabelCache()
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('boom'))))
    expect(await resolveEmoteLabels([URN_A])).toEqual({ [URN_A]: short })
    resetEmoteLabelCache()
    vi.stubGlobal('fetch', vi.fn(async () => json([])))
    expect(await resolveEmoteLabels([URN_A])).toEqual({ [URN_A]: short })
    resetEmoteLabelCache()
    vi.stubGlobal('fetch', vi.fn(async () => json({ not: 'an array' })))
    expect(await resolveEmoteLabels([URN_A])).toEqual({ [URN_A]: short })
  })

  it('a failed lookup is retried after a short pause, not on every load', async () => {
    const fetchMock = vi.fn(async () => json({}, 500))
    vi.stubGlobal('fetch', fetchMock)
    let t = 1_000
    await resolveEmoteLabels([URN_A], { now: () => t })
    await resolveEmoteLabels([URN_A], { now: () => t + 60_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await resolveEmoteLabels([URN_A], { now: () => t + 6 * 60_000 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the cache under its size cap', async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => json(JSON.parse(init.body as string).pointers.map((p: string) => entity(p, 'N'))))
    vi.stubGlobal('fetch', fetchMock)
    await resolveEmoteLabels([URN_A, URN_B], { maxEntries: 1 })
    await resolveEmoteLabels([URN_A], { maxEntries: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('title-cases every word of a base emote id', async () => {
    expect(await resolveEmoteLabels(['head_explode', 'fistpump', 'hands-air'])).toEqual({ head_explode: 'Head Explode', fistpump: 'Fistpump', 'hands-air': 'Hands Air' })
  })

  it('sends only the top 50 URNs, in chunks of at most 100 pointers', async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => json(JSON.parse(init.body as string).pointers.map((p: string) => entity(p, 'N'))))
    vi.stubGlobal('fetch', fetchMock)
    const urns = Array.from({ length: 200 }, (_, i) => `urn:decentraland:matic:collections-v2:0x${String(i).padStart(40, '0')}:0`)
    const labels = await resolveEmoteLabels(urns)
    const sent = fetchMock.mock.calls.flatMap((c: any) => JSON.parse(c[1].body).pointers)
    expect(sent).toEqual(urns.slice(0, 50))
    expect(labels[urns[0]]).toBe('N')
    expect(labels[urns[150]]).toBe('0x0000…0150:0')
    expect(Object.keys(labels)).toHaveLength(200)
    resetEmoteLabelCache()
    fetchMock.mockClear()
    await resolveEmoteLabels(urns, { limit: 250 })
    const sizes = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body).pointers.length)
    expect(sizes).toEqual([100, 100])
  })

  it('shares one in-flight lookup between concurrent callers', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchMock = vi.fn(async () => {
      await gate
      return json([entity(URN_A, 'Cool Dance')])
    })
    vi.stubGlobal('fetch', fetchMock)
    const a = resolveEmoteLabels([URN_A])
    const b = resolveEmoteLabels([URN_A])
    release()
    expect(await a).toEqual({ [URN_A]: 'Cool Dance' })
    expect(await b).toEqual({ [URN_A]: 'Cool Dance' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shortens other URN shapes to their last segments', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([])))
    const u = 'urn:decentraland:off-chain:base-avatars:kiss'
    expect(await resolveEmoteLabels([u])).toEqual({ [u]: 'base-avatars:kiss' })
  })
})

describe('mergeLegacyEntityTargets', () => {
  it('folds entity:<n> rows into one older-data row and leaves the rest alone', () => {
    expect(mergeLegacyEntityTargets({ 'entity:539': 3, 'entity:541': 4, Door: 2, 'entity:x': 1, 'my entity:5': 1 })).toEqual({
      [LEGACY_ENTITY_LABEL]: 7,
      Door: 2,
      'entity:x': 1,
      'my entity:5': 1,
    })
    expect(LEGACY_ENTITY_LABEL).toBe('Unnamed objects (older data)')
  })

  it('adds the count to an existing row of that name and adds no row when there is no old data', () => {
    expect(mergeLegacyEntityTargets({ 'entity:1': 2, [LEGACY_ENTITY_LABEL]: 1 })).toEqual({ [LEGACY_ENTITY_LABEL]: 3 })
    expect(mergeLegacyEntityTargets({ Door: 1 })).toEqual({ Door: 1 })
  })
})
