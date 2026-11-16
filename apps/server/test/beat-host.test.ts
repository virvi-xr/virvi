import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { arDevices, beatClaims, beats, beatScenes, hyperfyPairings, hyperfyWorlds, mediaAssets, sceneCollaborators } from '../src/db/schema.js'
import { issueArPass, issueHyperfyPass, issueScenePass, issueStudioPass } from '../src/auth/scene-pass.js'
import { copyBeatImage, refundBeat } from '../src/beats/payments.js'
import { BeatError, testHooks } from '../src/beats/service.js'
import { setImageSizeReader } from '../src/beats/image.js'
import { resetDb } from './helpers/db.js'
import { BEATS_READY } from './helpers/beats-ready.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

// The payment steps are Task 6's: count the calls, keep the stubs' behaviour
vi.mock('../src/beats/payments.js', async (orig) => {
  const a = await orig<typeof import('../src/beats/payments.js')>()
  return { ...a, refundBeat: vi.fn(a.refundBeat), copyBeatImage: vi.fn(a.copyBeatImage) }
})

const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
const H = 3_600_000
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

describe('BEAT host API (LIV-11)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let sceneA: string
  let sceneB: string
  let imageId: string
  const sizes = new Map<string, { width: number; height: number }>()
  const prev = config.beats

  const setBeats = (patch: Record<string, unknown>) => { ;(config as any).beats = { ...config.beats, ...patch } }

  beforeEach(async () => {
    await resetDb()
    vi.mocked(refundBeat).mockClear()
    vi.mocked(copyBeatImage).mockClear()
    sizes.clear()
    setImageSizeReader(async (url) => sizes.get(url) ?? null)
    setBeats({ enabled: true, chain: 'polygon', ...BEATS_READY })
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    sceneA = (await createScene(host, 'A')).scene.id
    sceneB = (await createScene(host, 'B')).scene.id
    imageId = (await media(host, 1024, 1024)).id
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    setImageSizeReader(null)
    await app.close()
  })

  async function media(owner: TestUser, width: number, height: number, contentType = 'image/png') {
    const url = `https://cdn.example/${Math.random().toString(36).slice(2)}.png`
    sizes.set(url, { width, height })
    const [m] = await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'b.png', contentType, sizeBytes: 1, storageKey: 'k', publicUrl: url }).returning()
    return m
  }
  const call = (method: string, url: string, user: TestUser = host, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: as(user), payload: payload as any })
  const valid = (over: Record<string, unknown> = {}) => ({
    name: 'Opening night', description: 'Thanks for coming', imageMediaId: imageId, startsAt: iso(2 * H), endsAt: iso(4 * H),
    minPresentMinutes: 5, supplyCap: 100, tradeable: false, sceneIds: [sceneA], ...over,
  })
  const create = (over: Record<string, unknown> = {}, user: TestUser = host) => call('POST', '/api/beats', user, valid(over))
  async function collaborator(sceneId: string, role: 'editor' | 'viewer') {
    const u = await createUser({ wallet: randomWallet() })
    await db.insert(sceneCollaborators).values({ sceneId, userId: u.id, role })
    return u
  }
  /** A BEAT row straight in the database, for states the API can't reach yet. */
  async function seed(over: Partial<typeof beats.$inferInsert> = {}, scenes = [sceneA]) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon', ownerUserId: host.id, name: 'Seed', description: '', imageMediaId: imageId,
      startsAt: new Date(Date.now() + 2 * H), endsAt: new Date(Date.now() + 4 * H), ...over,
    }).returning()
    await db.insert(beatScenes).values(scenes.map((sceneId) => ({ beatId: b.id, sceneId })))
    return b
  }

  describe('create', () => {
    it('creates a draft with events.run on both scenes', async () => {
      const res = await create({ sceneIds: [sceneA, sceneB] })
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toMatchObject({
        status: 'draft', chain: 'polygon', name: 'Opening night', supplyCap: 100, minPresentSeconds: 300, tradeable: false, test: false, frozen: false,
        tokenId: null, counts: { claimed: 0, minting: 0, minted: 0, failed: 0 },
      })
      expect(res.json().sceneIds.sort()).toEqual([sceneA, sceneB].sort())
      expect(res.json().imageUrl).toMatch(/^https:\/\/cdn\.example\//)
    })

    it('forbids a scene the caller has no events.run in, and a viewer', async () => {
      const other = await createUser()
      const foreign = (await createScene(other)).scene.id
      const mixed = await create({ sceneIds: [sceneA, foreign] })
      expect([mixed.statusCode, mixed.json().error]).toEqual([403, 'forbidden'])
      const viewer = await collaborator(sceneA, 'viewer')
      const v = await create({}, viewer)
      expect([v.statusCode, v.json().error]).toEqual([403, 'forbidden'])
      expect(await db.select().from(beats)).toHaveLength(0)
    })

    it('a co-host editor with events.run on every scene may create', async () => {
      const editor = await collaborator(sceneA, 'editor')
      const res = await create({ imageMediaId: (await media(editor, 800, 800)).id }, editor)
      expect(res.statusCode, res.body).toBe(201)
    })

    it('on Amoy a non-admin gets forbidden and an admin succeeds', async () => {
      setBeats({ chain: 'polygon-amoy' })
      const denied = await create()
      expect([denied.statusCode, denied.json().error]).toEqual([403, 'forbidden'])
      const admin = await createUser({ role: 'admin', wallet: randomWallet() })
      const img = (await media(admin, 600, 600)).id
      const ok = await create({ imageMediaId: img, sceneIds: [sceneA] }, admin)
      expect(ok.statusCode, ok.body).toBe(201)
      expect(ok.json()).toMatchObject({ chain: 'polygon-amoy', test: true })
    })

    const code = async (over: Record<string, unknown>) => { const r = await create(over); return [r.statusCode, r.json().error] }

    it('refuses each bad value with its own code at the boundary', async () => {
      expect(await code({ name: 'x'.repeat(61) })).toEqual([400, 'bad_name'])
      expect(await code({ name: '   ' })).toEqual([400, 'bad_name'])
      expect(await code({ description: 'x'.repeat(501) })).toEqual([400, 'bad_name'])
      expect(await code({ supplyCap: 5001 })).toEqual([400, 'bad_cap'])
      expect(await code({ supplyCap: 0 })).toEqual([400, 'bad_cap'])
      expect(await code({ minPresentMinutes: 121 })).toEqual([400, 'bad_window'])
      expect(await code({ startsAt: iso(-H), endsAt: iso(H) })).toEqual([400, 'bad_window'])
      expect(await code({ startsAt: iso(4 * H), endsAt: iso(2 * H) })).toEqual([400, 'bad_window'])
      expect(await code({ startsAt: iso(H), endsAt: iso(H + 32 * 24 * H) })).toEqual([400, 'bad_window'])
      expect(await code({ sceneIds: [] })).toEqual([400, 'bad_scenes'])
      expect(await code({ sceneIds: [sceneA, sceneA] })).toEqual([400, 'bad_scenes'])
      const small = (await media(host, 511, 511)).id
      expect(await code({ imageMediaId: small })).toEqual([400, 'bad_image'])
      const wide = (await media(host, 1024, 512)).id
      expect(await code({ imageMediaId: wide })).toEqual([400, 'bad_image'])
      const gif = (await media(host, 1024, 1024, 'image/gif')).id
      expect(await code({ imageMediaId: gif })).toEqual([400, 'bad_image'])
      const stranger = await createUser()
      const theirs = (await media(stranger, 1024, 1024)).id
      expect(await code({ imageMediaId: theirs })).toEqual([400, 'bad_image'])
      expect(await code({ imageMediaId: undefined })).toEqual([400, 'bad_image'])
    })

    it('counts a name in characters, not UTF-16 units: 60 emoji pass, 61 fail', async () => {
      expect((await create({ name: '🎉'.repeat(60) })).statusCode).toBe(201)
      expect(await code({ name: '🎉'.repeat(61), startsAt: iso(30 * H), endsAt: iso(31 * H) })).toEqual([400, 'bad_name'])
    })

    it('refuses an image file over 10 MB before reading it', async () => {
      const [m] = await db.insert(mediaAssets).values({ ownerId: host.id, filename: 'big.png', contentType: 'image/png', sizeBytes: 11 * 1024 * 1024, storageKey: 'k', publicUrl: 'https://cdn.example/big.png' }).returning()
      sizes.set('https://cdn.example/big.png', { width: 1024, height: 1024 })
      expect(await code({ imageMediaId: m.id })).toEqual([400, 'bad_image'])
    })

    it('accepts the boundary values: 60-character name, 512 px image, 5000 cap, 31 days, 120 minutes', async () => {
      const edge = (await media(host, 512, 512)).id
      const res = await create({
        name: 'x'.repeat(60), description: 'x'.repeat(500), imageMediaId: edge, supplyCap: 5000, minPresentMinutes: 120,
        startsAt: iso(H), endsAt: iso(H + 31 * 24 * H),
      })
      expect(res.statusCode, res.body).toBe(201)
    })

    it('overlap fires on a shared scene and not for touching windows', async () => {
      const t0 = Date.now() + 2 * H
      const first = await create({ startsAt: new Date(t0).toISOString(), endsAt: new Date(t0 + 2 * H).toISOString() })
      expect(first.statusCode).toBe(201)
      const clash = await create({ startsAt: new Date(t0 + H).toISOString(), endsAt: new Date(t0 + 3 * H).toISOString(), sceneIds: [sceneB, sceneA] })
      expect([clash.statusCode, clash.json().error]).toEqual([409, 'overlap'])
      const touching = await create({ startsAt: new Date(t0 + 2 * H).toISOString(), endsAt: new Date(t0 + 3 * H).toISOString() })
      expect(touching.statusCode, touching.body).toBe(201)
      const elsewhere = await create({ startsAt: new Date(t0).toISOString(), endsAt: new Date(t0 + 2 * H).toISOString(), sceneIds: [sceneB] })
      expect(elsewhere.statusCode).toBe(201)
    })

    it('a cancelled BEAT does not block its window', async () => {
      const first = await create()
      expect((await call('POST', `/api/beats/${first.json().id}/cancel`)).statusCode).toBe(200)
      expect((await create()).statusCode).toBe(201)
    })
  })

  describe('edit', () => {
    it('a draft changes freely, cap and scenes included', async () => {
      const id = (await create()).json().id
      const res = await call('PATCH', `/api/beats/${id}`, host, { name: 'Renamed', supplyCap: 250, sceneIds: [sceneA, sceneB], tradeable: true, minPresentMinutes: 10 })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ name: 'Renamed', supplyCap: 250, tradeable: true, minPresentSeconds: 600 })
      expect(res.json().sceneIds).toHaveLength(2)
    })

    it('a paid BEAT can be edited before the start, but not its cap', async () => {
      const b = await seed({ status: 'paid', imageUrl: 'https://cdn.example/frozen.png', tokenId: 1 })
      const ok = await call('PATCH', `/api/beats/${b.id}`, host, { name: 'Better name', description: 'New', minPresentMinutes: 15, sceneIds: [sceneA, sceneB] })
      expect(ok.statusCode, ok.body).toBe(200)
      expect(ok.json()).toMatchObject({ name: 'Better name', minPresentSeconds: 900 })
      const cap = await call('PATCH', `/api/beats/${b.id}`, host, { supplyCap: 500 })
      expect([cap.statusCode, cap.json().error]).toEqual([409, 'locked'])
      expect((await db.query.beats.findFirst({ where: eq(beats.id, b.id) }))!.supplyCap).toBe(100)
    })

    it('editing after the start, or after frozen_at, is locked', async () => {
      const started = await seed({ status: 'paid', imageUrl: 'https://cdn.example/frozen.png', tokenId: 2, startsAt: new Date(Date.now() - H), endsAt: new Date(Date.now() + H) })
      const a = await call('PATCH', `/api/beats/${started.id}`, host, { name: 'Late' })
      expect([a.statusCode, a.json().error]).toEqual([409, 'locked'])
      const frozen = await seed({ status: 'paid', imageUrl: 'https://cdn.example/frozen.png', tokenId: 3, frozenAt: new Date(), startsAt: new Date(Date.now() + 10 * H), endsAt: new Date(Date.now() + 12 * H) }, [sceneB])
      const b = await call('PATCH', `/api/beats/${frozen.id}`, host, { name: 'Frozen' })
      expect([b.statusCode, b.json().error]).toEqual([409, 'locked'])
    })

    it('holdMints is stored from create (off by default)', async () => {
      const on = await create({ holdMints: true })
      expect([on.statusCode, on.json().holdMints, on.json().mintsHeldUntil === null]).toEqual([201, true, false])
      const off = await create({ startsAt: iso(30 * H), endsAt: iso(31 * H) })
      expect(off.json()).toMatchObject({ holdMints: false, mintsHeldUntil: null, mintsReleasedAt: null, scheduledEndsAt: null })
    })

    it('an image change on a paid BEAT clears any stale copy and copies nothing: the frozen copy is made at go-live', async () => {
      const b = await seed({ status: 'paid', imageUrl: 'https://cdn.example/frozen.png', tokenId: 20 })
      const next = await media(host, 700, 700)
      const res = await call('PATCH', `/api/beats/${b.id}`, host, { imageMediaId: next.id })
      expect(res.statusCode, res.body).toBe(200)
      expect(copyBeatImage).not.toHaveBeenCalled()
      const row = await db.query.beats.findFirst({ where: eq(beats.id, b.id) })
      expect([row!.imageMediaId, row!.imageUrl]).toEqual([next.id, null])
      expect((await call('GET', `/api/beats/${b.id}`)).json().imageUrl).toBe(next.publicUrl)
    })

    it('tradeable can change after payment until go-live (it goes on chain with the create at go-live)', async () => {
      const b = await seed({ status: 'paid', tokenId: 22 })
      const res = await call('PATCH', `/api/beats/${b.id}`, host, { tradeable: true })
      expect([res.statusCode, res.json().tradeable]).toEqual([200, true])
    })

    it('a paid BEAT edit that keeps the image does not copy it again', async () => {
      const b = await seed({ status: 'paid', imageUrl: 'https://cdn.example/frozen.png', tokenId: 21 })
      expect((await call('PATCH', `/api/beats/${b.id}`, host, { name: 'Same image' })).statusCode).toBe(200)
      expect(copyBeatImage).not.toHaveBeenCalled()
    })

    it('an edit without sceneIds checks overlap against the BEAT\'s scenes as stored', async () => {
      await seed({ startsAt: new Date(Date.now() + 10 * H), endsAt: new Date(Date.now() + 12 * H) }, [sceneB])
      const id = (await create({ sceneIds: [sceneB], startsAt: iso(20 * H), endsAt: iso(22 * H) })).json().id
      const clash = await call('PATCH', `/api/beats/${id}`, host, { startsAt: iso(9 * H), endsAt: iso(11 * H) })
      expect([clash.statusCode, clash.json().error]).toEqual([409, 'overlap'])
    })

    it('validates an edit and refuses an overlap with another BEAT', async () => {
      await seed({ startsAt: new Date(Date.now() + 10 * H), endsAt: new Date(Date.now() + 12 * H) })
      const id = (await create()).json().id
      const bad = await call('PATCH', `/api/beats/${id}`, host, { name: '' })
      expect([bad.statusCode, bad.json().error]).toEqual([400, 'bad_name'])
      const clash = await call('PATCH', `/api/beats/${id}`, host, { startsAt: iso(9 * H), endsAt: iso(11 * H) })
      expect([clash.statusCode, clash.json().error]).toEqual([409, 'overlap'])
    })

    it('a co-host with events.run on one scene of two sees the BEAT but cannot change it', async () => {
      const id = (await create({ sceneIds: [sceneA, sceneB] })).json().id
      const partial = await collaborator(sceneA, 'editor')
      expect((await call('GET', `/api/beats/${id}`, partial)).statusCode).toBe(200)
      const res = await call('PATCH', `/api/beats/${id}`, partial, { name: 'Mine now' })
      expect([res.statusCode, res.json().error]).toEqual([403, 'forbidden'])
      const cancel = await call('POST', `/api/beats/${id}/cancel`, partial)
      expect(cancel.statusCode).toBe(403)
    })

    it('a co-host with events.run on every scene may change it', async () => {
      const id = (await create()).json().id
      const editor = await collaborator(sceneA, 'editor')
      const res = await call('PATCH', `/api/beats/${id}`, editor, { name: 'By editor' })
      expect(res.statusCode, res.body).toBe(200)
    })
  })

  describe('cancel and end early', () => {
    it('a draft becomes cancelled', async () => {
      const id = (await create()).json().id
      const res = await call('POST', `/api/beats/${id}/cancel`)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().status).toBe('cancelled')
    })

    it('cancelling after the start is too_late; an ended BEAT is locked', async () => {
      const started = await seed({ status: 'paid', imageUrl: 'https://cdn.example/frozen.png', tokenId: 4, startsAt: new Date(Date.now() - H), endsAt: new Date(Date.now() + H) })
      const a = await call('POST', `/api/beats/${started.id}/cancel`)
      expect([a.statusCode, a.json().error]).toEqual([409, 'too_late'])
      const live = await seed({ status: 'live', tokenId: 5, startsAt: new Date(Date.now() - H), endsAt: new Date(Date.now() + H) }, [sceneB])
      const b = await call('POST', `/api/beats/${live.id}/cancel`)
      expect([b.statusCode, b.json().error]).toEqual([409, 'too_late'])
      const done = await seed({ status: 'ended', tokenId: 6, startsAt: new Date(Date.now() - 3 * H), endsAt: new Date(Date.now() - 2 * H) }, [sceneB])
      const c = await call('POST', `/api/beats/${done.id}/cancel`)
      expect([c.statusCode, c.json().error]).toEqual([409, 'locked'])
    })

    it('a paid BEAT cancel goes through the refund step', async () => {
      const b = await seed({ status: 'paid', imageUrl: 'https://cdn.example/frozen.png', tokenId: 7 })
      const res = await call('POST', `/api/beats/${b.id}/cancel`)
      // Nothing was paid through a payment row here, so nothing is refunded (beat-payments.test.ts covers refunds)
      expect([res.statusCode, res.json().status]).toEqual([200, 'cancelled'])
      expect(refundBeat).toHaveBeenCalledTimes(1)
    })

    it('cancelling an already cancelled BEAT changes nothing and answers 200', async () => {
      const id = (await create()).json().id
      expect((await call('POST', `/api/beats/${id}/cancel`)).statusCode).toBe(200)
      const again = await call('POST', `/api/beats/${id}/cancel`)
      expect([again.statusCode, again.json().status]).toEqual([200, 'cancelled'])
      expect(refundBeat).not.toHaveBeenCalled()
    })

    it('a draft paid while the cancel was waiting is refunded: the state is read under the lock', async () => {
      const id = (await create()).json().id
      // The cancel's first read sees a draft; the row turns paid before its transaction reads it again
      const orig = db.transaction.bind(db)
      const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(async (fn: any, cfg?: any) => {
        await db.update(beats).set({ status: 'paid', tokenId: 99 }).where(eq(beats.id, id))
        return orig(fn, cfg)
      })
      const res = await call('POST', `/api/beats/${id}/cancel`)
      spy.mockRestore()
      expect(refundBeat).toHaveBeenCalledTimes(1)
      expect([res.statusCode, res.json().status]).toEqual([200, 'cancelled'])
    })

    it('a payment confirmed between the cancel\'s read and its update is never cancelled without a refund', async () => {
      const id = (await create()).json().id
      testHooks.afterCancelRead = async (beatId) => {
        await db.update(beats).set({ status: 'paid', tokenId: 98 }).where(eq(beats.id, beatId))
      }
      let res
      try { res = await call('POST', `/api/beats/${id}/cancel`) } finally { testHooks.afterCancelRead = undefined }
      expect([res.statusCode, res.json().error]).toEqual([409, 'conflict'])
      expect((await db.query.beats.findFirst({ where: eq(beats.id, id) }))!.status).toBe('paid')
    })

    it('a BEAT that went live while the cancel waited answers 409 conflict', async () => {
      const id = (await create()).json().id
      const orig = db.transaction.bind(db)
      const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(async (fn: any, cfg?: any) => {
        await db.update(beats).set({ status: 'ended' }).where(eq(beats.id, id))
        return orig(fn, cfg)
      })
      const res = await call('POST', `/api/beats/${id}/cancel`)
      spy.mockRestore()
      expect([res.statusCode, res.json().error]).toEqual([409, 'conflict'])
    })

    it('end early ends a live BEAT now; anything else is not_live', async () => {
      const live = await seed({ status: 'live', tokenId: 8, startsAt: new Date(Date.now() - H), endsAt: new Date(Date.now() + 5 * H) })
      const res = await call('POST', `/api/beats/${live.id}/end-early`)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().status).toBe('ended')
      expect(new Date(res.json().endsAt).getTime()).toBeLessThanOrEqual(Date.now())
      expect(new Date(res.json().endsAt).getTime()).toBeGreaterThan(Date.now() - 10_000)
      const draft = (await create()).json().id
      const no = await call('POST', `/api/beats/${draft}/end-early`)
      expect([no.statusCode, no.json().error]).toEqual([409, 'not_live'])
    })
  })

  describe('read and list', () => {
    it('counts claims by status, newest claimant first, with tx links', async () => {
      const id = (await create()).json().id
      const w = () => randomWallet()
      const mk = (status: string, ageMs: number, extra: Record<string, unknown> = {}) => ({
        beatId: id, wallet: w(), displayName: `P ${status}`, consentVersion: 1, status: status as any, createdAt: new Date(Date.now() - ageMs), ...extra,
      })
      await db.insert(beatClaims).values([
        mk('present', 5000), mk('claimed', 4000, { claimedAt: new Date() }), mk('minted', 3000, { claimedAt: new Date(), mintedAt: new Date(), mintTx: '0xabc' }),
        mk('minted', 2000, { claimedAt: new Date(), mintedAt: new Date() }), mk('failed', 1000),
      ])
      const one = await call('GET', `/api/beats/${id}`)
      expect(one.json().counts).toEqual({ claimed: 1, minting: 0, minted: 2, failed: 1 })
      const res = await call('GET', `/api/beats/${id}/claimants`)
      expect(res.statusCode).toBe(200)
      const rows = res.json()
      expect(rows.map((r: any) => r.status)).toEqual(['failed', 'minted', 'minted', 'claimed', 'present'])
      expect(rows[2].txUrl).toBe('https://polygonscan.com/tx/0xabc')
      expect(rows[0]).toEqual(expect.objectContaining({ wallet: expect.any(String), displayName: 'P failed', claimedAt: null, mintedAt: null, txUrl: null }))
    })

    it('a co-host on one of two scenes lists claimants; an editor of an unrelated scene gets 404', async () => {
      const id = (await create({ sceneIds: [sceneA, sceneB] })).json().id
      const partial = await collaborator(sceneB, 'editor')
      expect((await call('GET', `/api/beats/${id}/claimants`, partial)).statusCode).toBe(200)
      const unrelatedOwner = await createUser()
      const unrelatedScene = (await createScene(unrelatedOwner)).scene.id
      const unrelated = await collaborator(unrelatedScene, 'editor')
      for (const url of [`/api/beats/${id}`, `/api/beats/${id}/claimants`]) {
        const r = await call('GET', url, unrelated)
        expect([url, r.statusCode]).toEqual([url, 404])
      }
      expect((await call('GET', '/api/beats/not-a-uuid')).statusCode).toBe(404)
    })

    it('lists what the caller created or runs through a scene, and a scene lists its own', async () => {
      const mine = (await create()).json().id
      const theirScene = (await createScene(await createUser())).scene.id
      const other = await createUser()
      await db.insert(sceneCollaborators).values({ sceneId: theirScene, userId: host.id, role: 'editor' })
      const theirs = await seed({ ownerUserId: other.id }, [theirScene])
      const stranger = await seed({ ownerUserId: other.id, startsAt: new Date(Date.now() + 20 * H), endsAt: new Date(Date.now() + 21 * H) }, [(await createScene(other)).scene.id])
      const res = await call('GET', '/api/beats')
      expect(res.json().map((b: any) => b.id).sort()).toEqual([mine, theirs.id].sort())
      expect(res.json().map((b: any) => b.id)).not.toContain(stranger.id)
      const onScene = await call('GET', `/api/scenes/${sceneA}/beats`)
      expect(onScene.json().map((b: any) => b.id)).toEqual([mine])
      const viewer = await collaborator(sceneA, 'viewer')
      expect((await call('GET', `/api/scenes/${sceneA}/beats`, viewer)).statusCode).toBe(403)
      expect((await call('GET', '/api/scenes/00000000-0000-4000-8000-000000000000/beats')).statusCode).toBe(404)
    })

    it('after mainnet, Amoy BEATs are only for admins (listed and readable, test: true)', async () => {
      const test = await seed({ chain: 'polygon-amoy' })
      const real = await seed({ startsAt: new Date(Date.now() + 20 * H), endsAt: new Date(Date.now() + 21 * H) })
      const res = await call('GET', '/api/beats')
      expect(res.json().map((b: any) => b.id)).toEqual([real.id])
      expect((await call('GET', `/api/beats/${test.id}`)).statusCode).toBe(404)
      expect((await call('GET', `/api/scenes/${sceneA}/beats`)).json().map((b: any) => b.id)).toEqual([real.id])
      const admin = await createUser({ role: 'admin', wallet: randomWallet() })
      const all = await call('GET', '/api/beats', admin)
      expect(all.json().map((b: any) => [b.id, b.test]).sort()).toEqual([[real.id, false], [test.id, true]].sort())
      expect((await call('GET', `/api/beats/${test.id}`, admin)).json().test).toBe(true)
    })
  })

  describe('scene passes', () => {
    it('a Decentraland pass reads a BEAT on its scene but cannot change a multi-scene BEAT; a pass for another scene sees nothing', async () => {
      const id = (await create({ sceneIds: [sceneA, sceneB] })).json().id
      const sceneC = (await createScene(host, 'C')).scene.id
      const hdr = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` })
      const dcl = (sid: string) => hdr(issueScenePass(app, host as any, host.wallet!, { sceneId: sid, locationId: null }).accessToken)
      const go = (method: string, url: string, headers: Record<string, string>, payload?: unknown) => app.inject({ method: method as any, url, headers, payload: payload as any })
      // Reads: for either scene the BEAT is on
      for (const sid of [sceneA, sceneB]) {
        expect((await go('GET', `/api/beats/${id}`, dcl(sid))).statusCode).toBe(200)
        expect((await go('GET', `/api/beats/${id}/claimants`, dcl(sid))).statusCode).toBe(200)
      }
      expect((await go('GET', `/api/scenes/${sceneA}/beats`, dcl(sceneA))).statusCode).toBe(200)
      // A pass for a scene the BEAT isn't on: 404, like a BEAT that doesn't exist
      for (const url of [`/api/beats/${id}`, `/api/beats/${id}/claimants`]) {
        expect([url, (await go('GET', url, dcl(sceneC))).statusCode]).toEqual([url, 404])
      }
      // Writes, list and create refuse any pass
      for (const [method, url] of [['PATCH', `/api/beats/${id}`], ['POST', `/api/beats/${id}/cancel`], ['POST', `/api/beats/${id}/end-early`], ['GET', '/api/beats'], ['POST', '/api/beats'], ['GET', '/api/beats/availability']] as const) {
        const r = await go(method, url, dcl(sceneA), method === 'GET' ? undefined : { name: 'moved', sceneIds: [sceneC] })
        expect([method, url, r.statusCode, r.json().error]).toEqual([method, url, 403, 'scene_pass_not_allowed'])
      }
      const row = await db.query.beats.findFirst({ where: eq(beats.id, id) })
      expect([row!.status, row!.name]).toEqual(['draft', 'Opening night'])
      expect(await db.select().from(beatScenes).where(eq(beatScenes.beatId, id))).toHaveLength(2)
      const visitor = hdr(issueScenePass(app, host as any, host.wallet!, { sceneId: null, locationId: null }).accessToken)
      expect((await go('GET', `/api/beats/${id}`, visitor)).statusCode).toBe(403)
    })

    it('Hyperfy, AR and studio passes are refused on every BEAT route', async () => {
      const id = (await create()).json().id
      const hdr = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` })
      const other = { id: host.id, role: host.role }
      const [world] = await db.insert(hyperfyWorlds).values({ sceneId: sceneA, ownerId: host.id, name: 'W', keyHash: 'beat-world-hash', keyPrefix: 'virviw_b' }).returning()
      const soon = new Date(Date.now() + H)
      const [pairing] = await db.insert(hyperfyPairings).values({ worldId: world.id, userId: host.id, secretHash: 'beat-secret-hash', status: 'claimed', codeExpiresAt: soon, expiresAt: soon }).returning()
      const hy = issueHyperfyPass(app, other, host.wallet, { id: pairing.id, worldId: world.id, sceneId: sceneA }).pass
      const [device] = await db.insert(arDevices).values({ userId: host.id, secretHash: 'beat-device-hash', kind: 'shared', status: 'claimed', codeExpiresAt: soon, expiresAt: soon }).returning()
      const ar = issueArPass(app, other, host.wallet, { deviceId: device.id, sceneId: sceneA }).pass
      const studio = issueStudioPass(app, host as any, host.wallet!).accessToken
      const routes: Array<[string, string]> = [
        ['GET', '/api/beats'], ['POST', '/api/beats'], ['GET', '/api/beats/availability'], ['GET', `/api/beats/${id}`], ['PATCH', `/api/beats/${id}`],
        ['GET', `/api/beats/${id}/claimants`], ['POST', `/api/beats/${id}/cancel`], ['POST', `/api/beats/${id}/end-early`], ['GET', `/api/scenes/${sceneA}/beats`],
      ]
      for (const [name, token] of [['hyperfy', hy], ['ar', ar], ['studio', studio]] as const) {
        for (const [method, url] of routes) {
          const r = await app.inject({ method: method as any, url, headers: hdr(token), payload: method === 'GET' ? undefined : {} })
          expect([name, method, url, r.statusCode]).toEqual([name, method, url, 403])
        }
      }
      expect((await db.query.beats.findFirst({ where: eq(beats.id, id) }))!.status).toBe('draft')
    })
  })

  describe('availability and the dark launch', () => {
    it('reports enabled, chain, test and canCreate', async () => {
      expect((await call('GET', '/api/beats/availability')).json()).toEqual({ enabled: true, chain: 'polygon', test: false, canCreate: true, reason: null })
      setBeats({ chain: 'polygon-amoy' })
      expect((await call('GET', '/api/beats/availability')).json()).toEqual({ enabled: true, chain: 'polygon-amoy', test: true, canCreate: false, reason: null })
      const admin = await createUser({ role: 'admin' })
      expect((await call('GET', '/api/beats/availability', admin)).json().canCreate).toBe(true)
      setBeats({ enabled: false, chain: 'polygon' })
      expect((await call('GET', '/api/beats/availability')).json()).toEqual({ enabled: false, chain: 'polygon', test: false, canCreate: false, reason: null })
    })

    it('M4: enabled without a contract or minter key for the server chain: BEATs stay on but nobody can create or pay', async () => {
      const admin = await createUser({ role: 'admin' })
      const draft = await seed({ name: 'Draft' })
      const paid = await seed({ name: 'Paid', status: 'paid', tokenId: 41, startsAt: new Date(Date.now() + 6 * H), endsAt: new Date(Date.now() + 8 * H) }, [sceneB])
      for (const patch of [{ contracts: { 'polygon-amoy': BEATS_READY.contracts['polygon-amoy'] } }, { minterKey: null }]) {
        setBeats({ enabled: true, chain: 'polygon', ...BEATS_READY, ...patch })
        for (const who of [host, admin]) {
          expect((await call('GET', '/api/beats/availability', who)).json()).toEqual({ enabled: true, chain: 'polygon', test: false, canCreate: false, reason: 'not_configured' })
        }
        // Existing BEATs still list and open
        const list = await call('GET', '/api/beats')
        expect(list.statusCode).toBe(200)
        expect(list.json().map((b: { name: string }) => b.name).sort()).toEqual(['Draft', 'Paid'])
        expect((await call('GET', `/api/beats/${paid.id}`)).json()).toMatchObject({ name: 'Paid', status: 'paid' })
        expect((await call('GET', `/api/beats/${paid.id}/claimants`)).statusCode).toBe(200)
        expect((await call('GET', `/api/scenes/${sceneA}/beats`)).json().map((b: { id: string }) => b.id)).toEqual([draft.id])
        // Create, checkout and top-up refuse
        const refusals = [
          await call('POST', '/api/beats', admin, valid()),
          await call('POST', `/api/beats/${draft.id}/checkout`, host, { method: 'card' }),
          await call('POST', `/api/beats/${paid.id}/cap`, host, { supplyCap: 200, method: 'card' }),
        ]
        for (const res of refusals) {
          expect([res.statusCode, res.json().error]).toEqual([503, 'not_configured'])
          expect(res.json().message).toBe("BEATs aren't set up yet. Try again later.")
        }
      }
      expect(await db.select().from(beats)).toHaveLength(2)
    })

    it('needs a sign-in', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/beats/availability' })).statusCode).toBe(401)
    })

    it('answers 404 to a signed-out caller too while disabled', async () => {
      setBeats({ enabled: false })
      for (const [method, url] of [['GET', '/api/beats'], ['POST', '/api/beats'], ['GET', '/api/beats/availability']] as const) {
        const r = await app.inject({ method, url })
        expect([method, url, r.statusCode]).toEqual([method, url, url.endsWith('availability') ? 401 : 404])
      }
    })

    it('every route but availability is 404 when disabled', async () => {
      const b = await seed()
      setBeats({ enabled: false })
      const routes: Array<[string, string]> = [
        ['GET', '/api/beats'], ['POST', '/api/beats'], ['GET', `/api/beats/${b.id}`], ['PATCH', `/api/beats/${b.id}`],
        ['GET', `/api/beats/${b.id}/claimants`], ['POST', `/api/beats/${b.id}/cancel`], ['POST', `/api/beats/${b.id}/end-early`],
        ['GET', `/api/scenes/${sceneA}/beats`],
      ]
      for (const [method, url] of routes) {
        const r = await call(method, url, host, method === 'GET' ? undefined : valid())
        expect([method, url, r.statusCode]).toEqual([method, url, 404])
      }
      expect(await db.select().from(beats)).toHaveLength(1)
    })
  })
})
