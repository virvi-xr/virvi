import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ringCodeOf } from '@virvixr/shared'
import { BEAT_CLAIM_GRACE_MS } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatArcs, beats, mediaAssets } from '../src/db/schema.js'
import { allocateRingId } from '../src/ar/arcs.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const queue = vi.hoisted(() => ({ ids: [] as number[] }))
vi.mock('@virvixr/shared', async (orig) => {
  const real = await orig<typeof import('@virvixr/shared')>()
  return { ...real, randomRingId: () => queue.ids.shift() ?? real.randomRingId() }
})

const H = 3_600_000
const at = (ms: number) => new Date(Date.now() + ms)
const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

describe('one ARC id space and the app lookup', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let spaceCode: string
  let spaceId: string
  let imageId: string
  const prev = config.beats
  let tokenSeq = 900

  beforeEach(async () => {
    await resetDb()
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon' }
    queue.ids = []
    app = await testApp()
    owner = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(owner)
    const space = (await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/ar/spaces`, headers: as(owner), payload: { name: 'Arcade' } })).json()
    spaceId = space.id
    spaceCode = (await app.inject({ method: 'POST', url: `/api/ar/floors/${space.floors[0].id}/markers`, headers: as(owner), payload: {} })).json().code
    await app.inject({ method: 'PUT', url: `/api/ar/spaces/${spaceId}`, headers: as(owner), payload: { published: true } })
    const [m] = await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'b.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'k', publicUrl: 'https://cdn.example/b.png' }).returning()
    imageId = m.id
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    await app.close()
  })

  async function eventArc(over: Partial<typeof beats.$inferInsert> = {}, ringId = 4242424) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon', ownerUserId: owner.id, name: 'Opening night', description: 'Thanks', imageMediaId: imageId,
      imageUrl: 'https://cdn.example/frozen.png', tokenId: tokenSeq++, status: 'live', minPresentSeconds: 300, supplyCap: 100,
      startsAt: at(-H), endsAt: at(H), locationType: 'in_person', locationVenue: 'The Hall', ...over,
    }).returning()
    await db.insert(beatArcs).values({ beatId: b.id, ringId, code: ringCodeOf(ringId) })
    return { beat: b, code: ringCodeOf(ringId) }
  }
  const arc = (code: string) => app.inject({ method: 'GET', url: `/api/app/arcs/${code}` })

  it('allocateRingId skips an id taken by a BEAT ARC', async () => {
    const { code } = await eventArc({}, 777)
    expect(code).toBe(ringCodeOf(777))
    queue.ids = [777, 888]
    expect(await allocateRingId(db)).toBe(888)
  })

  it('allocateRingId gives up after 20 clashes', async () => {
    await eventArc({}, 777)
    queue.ids = Array(20).fill(777)
    await expect(allocateRingId(db)).rejects.toThrow()
  })

  it('answers a space ARC with its lookup', async () => {
    const res = await arc(spaceCode)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ kind: 'space', lookup: { spaceId, spaceName: 'Arcade' } })
  })

  it('answers an unpublished space ARC 404 except to a builder', async () => {
    await app.inject({ method: 'PUT', url: `/api/ar/spaces/${spaceId}`, headers: as(owner), payload: { published: false } })
    expect((await arc(spaceCode)).statusCode).toBe(404)
    const res = await app.inject({ method: 'GET', url: `/api/app/arcs/${spaceCode}`, headers: as(owner) })
    expect(res.statusCode).toBe(200)
  })

  it('answers an event ARC with the BEAT while it is visible', async () => {
    const { beat, code } = await eventArc()
    const res = await arc(code)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ kind: 'beat', beatId: beat.id, name: 'Opening night' })
  })

  it('answers an event ARC 404 when unpaid, cancelled or past the claim grace', async () => {
    const cases: Array<Partial<typeof beats.$inferInsert>> = [
      { status: 'draft' as any }, { status: 'cancelled' as any },
      { status: 'ended', startsAt: at(-3 * H), endsAt: at(-BEAT_CLAIM_GRACE_MS - H) },
    ]
    let id = 5000
    for (const c of cases) {
      const { code } = await eventArc(c, id++)
      expect((await arc(code)).statusCode).toBe(404)
    }
    const { code } = await eventArc({ status: 'ended', startsAt: at(-3 * H), endsAt: at(-H) }, id++)
    expect((await arc(code)).statusCode).toBe(200)
  })

  it('answers an unknown or malformed code 404', async () => {
    expect((await arc(ringCodeOf(31337))).statusCode).toBe(404)
    expect((await arc('nope')).statusCode).toBe(404)
  })

  it('keeps by-code for spaces only: an event ARC is 404 there, a space code is unchanged', async () => {
    const { code } = await eventArc()
    expect((await app.inject({ method: 'GET', url: `/api/ar/markers/by-code/${code}` })).statusCode).toBe(404)
    const res = await app.inject({ method: 'GET', url: `/api/ar/markers/by-code/${spaceCode}` })
    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.json()).sort()).toEqual(['floorId', 'markerId', 'spaceId', 'spaceName', 'whereText'])
  })
})
