import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { dclWorldDestinations, sceneDeployments } from '../src/db/schema.js'
import { afterDeploy } from '../src/services/dcl/world-deployer.js'
import {
  MAP_CHECK_CONCURRENCY, MAP_MANIFEST_MAX_BYTES, abgenMapCheck, mapManifestUrl, nextMapCheckAt, sweepMapStatus, type MapCheck,
} from '../src/services/dcl/map-status.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser } from './helpers/factories.js'

const T0 = new Date('2026-11-07T12:00:00Z')
const min = (m: number) => new Date(T0.getTime() + m * 60_000)

beforeEach(async () => { await resetDb() })

let n = 0
async function destination(opts: { kind?: 'world' | 'parcels' } = {}) {
  const user = await createUser()
  const { scene } = await createScene(user, 'Cafe')
  const kind = opts.kind ?? 'world'
  n++
  const [dest] = await db.insert(dclWorldDestinations).values({
    sceneId: scene.id, ownerUserId: user.id, ownerWallet: '0xabc', kind,
    worldName: kind === 'world' ? `cafe${n}.dcl.eth` : null, base: `${n},0`, parcels: [`${n},0`], mode: 'virvi',
  }).returning()
  return dest
}

/** A deploy of `entityId` that went live at `at`. */
async function deploy(dest: typeof dclWorldDestinations.$inferSelect, entityId: string, at = T0) {
  const [dep] = await db.insert(sceneDeployments).values({
    sceneId: dest.sceneId, platform: 'decentraland', deploymentType: dest.kind === 'world' ? 'world' : 'parcel', target: {},
    status: 'deploying', destinationId: dest.id,
  }).returning()
  vi.useFakeTimers({ now: at, toFake: ['Date'] })
  try {
    await afterDeploy(dest, entityId, ['scene.json'], dep.id)
  } finally {
    vi.useRealTimers()
  }
  return dep
}

const row = async (id: string) => (await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, id) }))!

const missing: MapCheck = async () => ({ published: false })
const ready = (assets: number | null): MapCheck => async () => ({ published: true, assets })

describe('map status columns', () => {
  it('a destination that was never checked is unknown', async () => {
    const d = await destination()
    expect(d.mapStatus).toBe('unknown')
    expect(d.mapEntityId).toBeNull()
    expect(d.mapAssets).toBeNull()
    expect(d.mapCheckAt).toBeNull()
  })
})

describe('afterDeploy starts the map checks', () => {
  it('a deploy makes the map pending, its first check due 2 minutes after it went live', async () => {
    const d = await destination()
    await deploy(d, 'bafynew')
    const r = await row(d.id)
    expect(r).toMatchObject({ mapStatus: 'pending', mapEntityId: 'bafynew', mapAssets: null, mapCheckedAt: null })
    expect(r.mapSince).toEqual(T0)
    expect(r.mapCheckAt).toEqual(min(2))
  })

  it('a newer deploy resets a ready map', async () => {
    const d = await destination()
    await deploy(d, 'bafyone')
    await sweepMapStatus(min(2), { check: ready(12) })
    expect(await row(d.id)).toMatchObject({ mapStatus: 'ready', mapAssets: 12 })
    await deploy(d, 'bafytwo', min(30))
    const r = await row(d.id)
    expect(r).toMatchObject({ mapStatus: 'pending', mapEntityId: 'bafytwo', mapAssets: null, mapCheckedAt: null })
    expect(r.mapCheckAt).toEqual(min(32))
  })

  it('finishing the same entity again (a reconciled deploy) keeps what was found', async () => {
    const d = await destination()
    await deploy(d, 'bafyone')
    await sweepMapStatus(min(2), { check: ready(3) })
    await deploy(await row(d.id), 'bafyone', min(20))
    expect(await row(d.id)).toMatchObject({ mapStatus: 'ready', mapAssets: 3 })
  })

  it('Genesis City parcels are checked too', async () => {
    const d = await destination({ kind: 'parcels' })
    await deploy(d, 'bafyparcels')
    expect((await row(d.id)).mapStatus).toBe('pending')
  })
})

describe('nextMapCheckAt', () => {
  it('2, 5, 10, 20, 40 minutes, then hourly up to 24 hours', () => {
    const slots: number[] = []
    let t: Date | null = T0
    while ((t = nextMapCheckAt(T0, t))) slots.push((t.getTime() - T0.getTime()) / 60_000)
    expect(slots.slice(0, 7)).toEqual([2, 5, 10, 20, 40, 60, 120])
    expect(slots.at(-1)).toBe(24 * 60)
    expect(slots).toHaveLength(5 + 24)
  })

  it('after a gap (a restart) the next slot is the first one still ahead', () => {
    expect(nextMapCheckAt(T0, min(185))).toEqual(min(240))
    expect(nextMapCheckAt(T0, min(24 * 60))).toBeNull()
  })
})

describe('sweepMapStatus', () => {
  it('checks nothing before the first check is due', async () => {
    const d = await destination()
    await deploy(d, 'bafynew')
    const check = vi.fn(missing)
    expect(await sweepMapStatus(min(1), { check })).toMatchObject({ checked: 0 })
    expect(check).not.toHaveBeenCalled()
  })

  it('not published yet: stays pending and waits for the next slot', async () => {
    const d = await destination()
    await deploy(d, 'bafynew')
    const check = vi.fn(missing)
    expect(await sweepMapStatus(min(2), { check })).toMatchObject({ checked: 1, ready: 0 })
    expect(check).toHaveBeenCalledWith('bafynew')
    const r = await row(d.id)
    expect(r).toMatchObject({ mapStatus: 'pending', mapAssets: null })
    expect(r.mapCheckedAt).toEqual(min(2))
    expect(r.mapCheckAt).toEqual(min(5))
    // Not due again until then
    await sweepMapStatus(min(4), { check })
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('published: ready with the model count, and no more checks', async () => {
    const d = await destination()
    await deploy(d, 'bafynew')
    await sweepMapStatus(min(2), { check: missing })
    expect(await sweepMapStatus(min(5), { check: ready(42) })).toMatchObject({ checked: 1, ready: 1 })
    const r = await row(d.id)
    expect(r).toMatchObject({ mapStatus: 'ready', mapAssets: 42, mapCheckAt: null })
    expect(r.mapCheckedAt).toEqual(min(5))
    const check = vi.fn(missing)
    await sweepMapStatus(min(24 * 60), { check })
    expect(check).not.toHaveBeenCalled()
  })

  it('gives up after 24 hours: none', async () => {
    const d = await destination()
    await deploy(d, 'bafynew')
    let t: Date | null = min(2)
    let checks = 0
    while (t) {
      await sweepMapStatus(t, { check: missing })
      checks++
      t = (await row(d.id)).mapCheckAt
    }
    expect(checks).toBe(29)
    expect(await row(d.id)).toMatchObject({ mapStatus: 'none', mapCheckAt: null, mapCheckedAt: min(24 * 60) })
  })

  it('a check that fails (unreachable, 5xx) counts as not published yet', async () => {
    const d = await destination()
    await deploy(d, 'bafynew')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await sweepMapStatus(min(2), { check: async () => { throw new Error('boom') } })
    spy.mockRestore()
    expect(await row(d.id)).toMatchObject({ mapStatus: 'pending', mapCheckAt: min(5) })
  })

  it('a result for an entity a newer deploy replaced mid-check is dropped', async () => {
    const d = await destination()
    await deploy(d, 'bafyone')
    const check: MapCheck = async () => {
      await deploy(d, 'bafytwo', min(3))
      return { published: true, assets: 9 }
    }
    await sweepMapStatus(min(2), { check })
    expect(await row(d.id)).toMatchObject({ mapStatus: 'pending', mapEntityId: 'bafytwo', mapAssets: null })
  })

  it('a destination whose live entity moved on without Virvi (Use the live version) goes back to unknown', async () => {
    const d = await destination()
    await deploy(d, 'bafyone')
    await db.update(dclWorldDestinations).set({ lastEntityId: 'bafyowner' }).where(eq(dclWorldDestinations.id, d.id))
    const check = vi.fn(missing)
    await sweepMapStatus(min(2), { check })
    expect(check).not.toHaveBeenCalled()
    expect(await row(d.id)).toMatchObject({ mapStatus: 'unknown', mapCheckAt: null })
  })

  it(`checks at most ${MAP_CHECK_CONCURRENCY} at a time`, async () => {
    for (let i = 0; i < 10; i++) await deploy(await destination(), `bafy${i}`)
    let inFlight = 0
    let most = 0
    const check: MapCheck = async () => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { published: false }
    }
    expect(await sweepMapStatus(min(2), { check })).toMatchObject({ checked: 10 })
    expect(most).toBeLessThanOrEqual(MAP_CHECK_CONCURRENCY)
    expect(most).toBeGreaterThan(1)
  })
})

describe('abgenMapCheck', () => {
  const res = (status: number, body: string | Uint8Array = '', headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : body, { status, headers })

  it('asks the abgen CDN for the entity\'s Initial Scene State', async () => {
    const f = vi.fn(async () => res(404))
    await abgenMapCheck(f as unknown as typeof fetch)('bafkreiabc123')
    expect(f.mock.calls[0][0]).toBe(mapManifestUrl('bafkreiabc123'))
    expect(mapManifestUrl('bafkreiabc123')).toMatch(/\/bafkreiabc123_InitialSceneState\.json$/)
    const init = (f.mock.calls[0] as unknown[])[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.redirect).toBe('error')
  })

  it('404 and 403 (how the CDN answers a missing file) are not published', async () => {
    expect(await abgenMapCheck(async () => res(404))('bafyx')).toEqual({ published: false })
    expect(await abgenMapCheck(async () => res(403))('bafyx')).toEqual({ published: false })
  })

  it('200 with assets: published, counting them', async () => {
    const body = JSON.stringify({ assets: [{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }] })
    expect(await abgenMapCheck(async () => res(200, body))('bafyx')).toEqual({ published: true, assets: 3 })
  })

  it('200 that is not a scene state is not trusted (throws, so it is retried)', async () => {
    await expect(abgenMapCheck(async () => res(200, '<html>'))('bafyx')).rejects.toThrow()
    await expect(abgenMapCheck(async () => res(200, '{"nope":1}'))('bafyx')).rejects.toThrow()
  })

  it('other statuses throw', async () => {
    await expect(abgenMapCheck(async () => res(503))('bafyx')).rejects.toThrow(/503/)
  })

  it(`a file over ${MAP_MANIFEST_MAX_BYTES / (1024 * 1024)} MB is published but not counted, by header or while streaming`, async () => {
    const big = { 'content-length': String(MAP_MANIFEST_MAX_BYTES + 1) }
    expect(await abgenMapCheck(async () => res(200, '{}', big))('bafyx')).toEqual({ published: true, assets: null })
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new Uint8Array(1024 * 1024)) },
    })
    expect(await abgenMapCheck(async () => new Response(stream, { status: 200 }))('bafyx')).toEqual({ published: true, assets: null })
  })

  it('refuses an entity id that is not a plain content hash', async () => {
    const f = vi.fn(async () => res(404))
    await expect(abgenMapCheck(f as unknown as typeof fetch)('../x')).rejects.toThrow()
    expect(f).not.toHaveBeenCalled()
  })
})
