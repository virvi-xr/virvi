import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { DEFAULT_VENUE_RULES, VENUE_ROLE_SCOPES } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { ads, adCreatives, adEvents, adPlacements, adSpaceApprovals, adSpaceSettings, accessGrants, bookings, sceneCollaborators, sceneRoles, sceneElements, scenePresets, venues } from '../src/db/schema.js'
import { selectAdsForElements } from '../src/ads/select.js'
import { resetDb } from './helpers/db.js'
import { testApp, tokenFor, createUser, createScene, createElement, randomWallet, type TestUser } from './helpers/factories.js'

let app: FastifyInstance
beforeAll(async () => { app = await testApp() })
afterAll(async () => { await app.close() })
beforeEach(async () => { await resetDb() })

const call = (user: TestUser, method: 'GET' | 'PUT', url: string, payload?: unknown, extra: Record<string, unknown> = {}) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(user, extra)}` }, payload: payload as any })

async function mkAd(
  kind: 'house' | 'partner',
  creatives: Array<{ shape: string; kind: 'image' | 'video' }> = [{ shape: '1:1', kind: 'image' }],
  over: Partial<typeof ads.$inferInsert> = {},
) {
  const [ad] = await db.insert(ads).values({ name: 'A', kind, clickUrl: 'https://x.example', reviewStatus: 'approved', audience: 'family', ...over }).returning()
  const cs = []
  for (const c of creatives) {
    cs.push((await db.insert(adCreatives).values({ adId: ad.id, shape: c.shape, kind: c.kind, url: `https://cdn.example/${crypto.randomUUID()}` }).returning())[0])
  }
  return { ad, cs }
}

async function seed() {
  const owner = await createUser()
  const { scene, preset } = await createScene(owner)
  const el = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
  return { owner, scene, preset, el }
}

const settings = () => db.select().from(adSpaceSettings)
const approvals = () => db.select().from(adSpaceApprovals)

describe('owner ad space API', () => {
  it('owner reads the setting, family by default, and changes it', async () => {
    const { owner, el } = await seed()
    const get = await call(owner, 'GET', `/api/ad-spaces/${el.id}`)
    expect(get.statusCode).toBe(200)
    expect(get.json().space).toEqual({ elementId: el.id, content: 'family', ads: [] })
    const put = await call(owner, 'PUT', `/api/ad-spaces/${el.id}/content`, { content: 'approve' })
    expect(put.statusCode).toBe(200)
    expect(put.json().space.content).toBe('approve')
    expect((await call(owner, 'PUT', `/api/ad-spaces/${el.id}/content`, { content: 'all' })).json().space.content).toBe('all')
    expect(await settings()).toHaveLength(1)
    const bad = await call(owner, 'PUT', `/api/ad-spaces/${el.id}/content`, { content: 'mature' })
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'content_must_be_family_all_or_approve'])
    expect((await call(owner, 'PUT', `/api/ad-spaces/${el.id}/content`, {})).statusCode).toBe(400)
  })

  it('candidates are approved ads in the space\'s shape and formats; partner ads only where placed', async () => {
    const { owner, preset } = await seed()
    const el = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'image' } })
    const house = await mkAd('house', [{ shape: '1:1', kind: 'image' }, { shape: '1:1', kind: 'video' }, { shape: '16:9', kind: 'image' }])
    const placed = await mkAd('partner')
    await db.insert(adPlacements).values({ adId: placed.ad.id, elementId: el.id })
    await mkAd('partner') // not placed
    await mkAd('house', [{ shape: '16:9', kind: 'image' }]) // wrong shape
    await mkAd('house', [{ shape: '1:1', kind: 'video' }]) // wrong format
    await mkAd('house', undefined, { reviewStatus: 'rejected' })
    await mkAd('house', undefined, { reviewStatus: 'pending' })
    await mkAd('house', undefined, { status: 'paused' })
    await mkAd('house', undefined, { endsAt: new Date(Date.now() - 1000) })
    await mkAd('house', undefined, { startsAt: new Date(Date.now() + 3_600_000) })
    const space = (await call(owner, 'GET', `/api/ad-spaces/${el.id}`)).json().space
    expect(space.ads.map((a: any) => a.adId).sort()).toEqual([house.ad.id, placed.ad.id].sort())
    const h = space.ads.find((a: any) => a.adId === house.ad.id)
    expect(h.creatives).toEqual([{ id: house.cs[0].id, kind: 'image', url: house.cs[0].url }])
    expect(h).toMatchObject({ house: true, decision: null, clickUrl: 'https://x.example', audience: 'family' })
  })

  it('owner approves and declines; serving follows', async () => {
    const { owner, scene, el } = await seed()
    const a = await mkAd('house')
    const b = await mkAd('house')
    await call(owner, 'PUT', `/api/ad-spaces/${el.id}/content`, { content: 'approve' })
    expect((await call(owner, 'PUT', `/api/ad-spaces/${el.id}/approvals/${a.ad.id}`, { decision: 'approved' })).statusCode).toBe(200)
    const res = await call(owner, 'PUT', `/api/ad-spaces/${el.id}/approvals/${b.ad.id}`, { decision: 'declined' })
    const dec = Object.fromEntries(res.json().space.ads.map((x: any) => [x.adId, x.decision]))
    expect(dec).toEqual({ [a.ad.id]: 'approved', [b.ad.id]: 'declined' })
    const out = await selectAdsForElements(scene.id, [el.id], new Date())
    expect(out[el.id].ads.map((x) => x.adId)).toEqual([a.ad.id])
    // flipping a decision upserts
    await call(owner, 'PUT', `/api/ad-spaces/${el.id}/approvals/${a.ad.id}`, { decision: 'declined' })
    expect(await approvals()).toHaveLength(2)
    expect((await selectAdsForElements(scene.id, [el.id], new Date()))[el.id].ads).toEqual([])
    const bad = await call(owner, 'PUT', `/api/ad-spaces/${el.id}/approvals/${a.ad.id}`, { decision: 'maybe' })
    expect(bad.statusCode).toBe(400)
  })

  it('editors and booking grant holders cannot change the setting or decide ads', async () => {
    const { owner, scene, preset, el } = await seed()
    const a = await mkAd('house')
    const editor = await createUser()
    const cohost = await createUser({ wallet: randomWallet() })
    const admin = await createUser({ role: 'admin' })
    await db.insert(sceneCollaborators).values([
      { sceneId: scene.id, userId: editor.id, role: 'editor' },
    ])
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: cohost.wallet!, userId: cohost.id, role: 'cohost', grantedByUserId: owner.id })
    const host = await createUser({ wallet: randomWallet() })
    const [venue] = await db.insert(venues).values({
      sceneId: scene.id, name: 'V', slug: `v-${crypto.randomUUID()}`, defaultPresetId: preset.id, rules: DEFAULT_VENUE_RULES,
    }).returning()
    const startsAt = new Date(Date.now() - 3600_000)
    const endsAt = new Date(Date.now() + 3600_000)
    const [booking] = await db.insert(bookings).values({
      venueId: venue.id, renterUserId: host.id, title: 'Show', startsAt, endsAt, status: 'live',
      blockedRange: `[${startsAt.toISOString()},${endsAt.toISOString()})`,
    }).returning()
    await db.insert(accessGrants).values({
      bookingId: booking.id, sceneId: scene.id, walletAddress: host.wallet, userId: host.id, role: 'host',
      scopes: [...VENUE_ROLE_SCOPES.host], validFrom: startsAt, validUntil: endsAt,
    })
    for (const u of [editor, host]) {
      expect((await call(u, 'GET', `/api/ad-spaces/${el.id}`)).statusCode).toBe(403)
      expect((await call(u, 'PUT', `/api/ad-spaces/${el.id}/content`, { content: 'all' })).statusCode).toBe(403)
      expect((await call(u, 'PUT', `/api/ad-spaces/${el.id}/approvals/${a.ad.id}`, { decision: 'approved' })).statusCode).toBe(403)
    }
    expect(await settings()).toHaveLength(0)
    expect(await approvals()).toHaveLength(0)
    for (const u of [cohost, admin]) {
      expect((await call(u, 'PUT', `/api/ad-spaces/${el.id}/content`, { content: 'all' })).statusCode).toBe(200)
      expect((await call(u, 'PUT', `/api/ad-spaces/${el.id}/approvals/${a.ad.id}`, { decision: 'approved' })).statusCode).toBe(200)
    }
  })

  it('refuses decisions on ads that are not candidates for the space', async () => {
    const { owner, preset, el } = await seed()
    const wrongShape = await mkAd('house', [{ shape: '16:9', kind: 'image' }])
    const rejected = await mkAd('house', undefined, { reviewStatus: 'rejected' })
    const pending = await mkAd('house', undefined, { reviewStatus: 'pending' })
    const unplaced = await mkAd('partner')
    for (const id of [wrongShape.ad.id, rejected.ad.id, pending.ad.id, unplaced.ad.id, crypto.randomUUID(), 'not-a-uuid']) {
      const res = await call(owner, 'PUT', `/api/ad-spaces/${el.id}/approvals/${id}`, { decision: 'approved' })
      expect([res.statusCode, res.json().error]).toEqual([400, 'ad_not_a_candidate'])
    }
    expect(await approvals()).toHaveLength(0)

    const other = await createUser()
    const theirs = await createScene(other)
    const theirEl = await createElement(theirs.preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const ok = await mkAd('house')
    for (const [m, u, body] of [
      ['GET', `/api/ad-spaces/${theirEl.id}`, undefined],
      ['PUT', `/api/ad-spaces/${theirEl.id}/content`, { content: 'all' }],
      ['PUT', `/api/ad-spaces/${theirEl.id}/approvals/${ok.ad.id}`, { decision: 'approved' }],
    ] as const) {
      expect((await call(owner, m, u, body)).statusCode).toBe(403)
    }
    expect(await approvals()).toHaveLength(0)
    expect(await settings()).toHaveLength(0)

    // not ad spaces, and unknown ids
    const image = await createElement(preset.id, { type: 'image' })
    const otherVideo = await createElement(preset.id, { type: 'video', properties: { offType: 1 } })
    for (const id of [image.id, otherVideo.id]) {
      const res = await call(owner, 'GET', `/api/ad-spaces/${id}`)
      expect([res.statusCode, res.json().error]).toEqual([404, 'not_an_ad_space'])
    }
    const adsVideo = await createElement(preset.id, { type: 'video', properties: { offType: 4 } })
    expect((await call(owner, 'GET', `/api/ad-spaces/${adsVideo.id}`)).statusCode).toBe(200)
    expect((await call(owner, 'GET', `/api/ad-spaces/${crypto.randomUUID()}`)).statusCode).toBe(404)
    expect((await call(owner, 'GET', '/api/ad-spaces/not-a-uuid')).statusCode).toBe(404)
  })

  it('a decision made through a booking clone is stored on the original', async () => {
    const { owner, scene, el } = await seed()
    const a = await mkAd('house')
    const [bp] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Booking' }).returning()
    const [clone] = await db.insert(sceneElements).values({ presetId: bp.id, type: 'ad_space', name: 'Clone', properties: { shape: '1:1', formats: 'both' }, clonedFromId: el.id }).returning()
    const c = await call(owner, 'PUT', `/api/ad-spaces/${clone.id}/content`, { content: 'approve' })
    expect(c.json().space.elementId).toBe(el.id)
    const d = await call(owner, 'PUT', `/api/ad-spaces/${clone.id}/approvals/${a.ad.id}`, { decision: 'approved' })
    expect(d.statusCode).toBe(200)
    expect((await settings()).map((s) => s.elementId)).toEqual([el.id])
    expect((await approvals()).map((s) => s.elementId)).toEqual([el.id])
    expect((await call(owner, 'GET', `/api/ad-spaces/${el.id}`)).json().space.ads[0].decision).toBe('approved')
    expect((await selectAdsForElements(scene.id, [clone.id], new Date()))[clone.id].ads.map((x) => x.adId)).toEqual([a.ad.id])
    // a stranger gets 403 through the clone too
    const stranger = await createUser()
    expect((await call(stranger, 'PUT', `/api/ad-spaces/${clone.id}/content`, { content: 'all' })).statusCode).toBe(403)
  })

  it('refuses scene-pass tokens, even for the same scene', async () => {
    const { owner, scene, el } = await seed()
    const a = await mkAd('house')
    const extra = { kind: 'scene', sceneId: scene.id, locationId: null, orgId: null }
    for (const via of [undefined, 'hyperfy', 'ar']) {
      const x = { ...extra, ...(via ? { via } : {}) }
      expect((await call(owner, 'GET', `/api/ad-spaces/${el.id}`, undefined, x)).statusCode).toBeGreaterThanOrEqual(401)
      const put = await call(owner, 'PUT', `/api/ad-spaces/${el.id}/content`, { content: 'all' }, x)
      expect(put.statusCode).toBeGreaterThanOrEqual(401)
      const dec = await call(owner, 'PUT', `/api/ad-spaces/${el.id}/approvals/${a.ad.id}`, { decision: 'approved' }, x)
      expect(dec.statusCode).toBeGreaterThanOrEqual(401)
    }
    const plain = await call(owner, 'GET', `/api/ad-spaces/${el.id}`, undefined, extra)
    expect([plain.statusCode, plain.json().error]).toEqual([403, 'scene_pass_not_allowed'])
    expect(await settings()).toHaveLength(0)
    expect(await approvals()).toHaveLength(0)
    expect((await db.select().from(sceneElements).where(eq(sceneElements.id, el.id)))).toHaveLength(1)
  })

  it('requires authentication', async () => {
    const { el } = await seed()
    expect((await app.inject({ method: 'GET', url: `/api/ad-spaces/${el.id}` })).statusCode).toBe(401)
  })

  it('the owner sees what the space delivered per ad, its booking copies included (LIV-38)', async () => {
    const { owner, scene, el } = await seed()
    const house = await mkAd('house', undefined, { name: 'Virvi house' })
    const paid = await mkAd('partner', undefined, { name: 'Sponsor' })
    const [bp] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Booking' }).returning()
    const [clone] = await db.insert(sceneElements).values({ presetId: bp.id, type: 'ad_space', name: 'Clone', properties: { shape: '1:1', formats: 'both' }, clonedFromId: el.id }).returning()
    const other = await createElement((await db.select().from(scenePresets).where(eq(scenePresets.sceneId, scene.id)))[0].id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10)
    const ev = (adId: string, elementId: string, level: string, viewer: string, verified = true, ago = 0) =>
      ({ adId, elementId, sceneId: scene.id, level, day: day(ago), viewerKey: viewer, verified, house: adId === house.ad.id, occurredAt: new Date() })
    await db.insert(adEvents).values([
      ev(paid.ad.id, el.id, 'screen', 'h:1'), ev(paid.ad.id, el.id, 'screen', 'h:2'), ev(paid.ad.id, clone.id, 'screen', 'h:3'),
      ev(paid.ad.id, el.id, 'click', 'h:1'), ev(paid.ad.id, el.id, 'screen', 'u:guest', false),
      ev(house.ad.id, el.id, 'scene', 'h:1'),
      ev(paid.ad.id, other.id, 'screen', 'h:9'), // another space
      ev(paid.ad.id, el.id, 'screen', 'h:old', true, 40), // outside 30 days
      ev(paid.ad.id, el.id, 'screen', 'h:week', true, 10), // inside 30 days, outside 7
    ])
    const res = await call(owner, 'GET', `/api/ad-spaces/${clone.id}/report`)
    expect(res.statusCode).toBe(200)
    const r = res.json().report
    expect(r).toMatchObject({ days: 30, from: day(29) })
    expect(r.ads.map((a: any) => [a.name, a.house, a.screen, a.click, a.unverified.screen, a.scene])).toEqual([
      ['Sponsor', false, 4, 1, 1, 0],
      ['Virvi house', true, 0, 0, 0, 1],
    ])
    expect(r.totals).toMatchObject({ screen: 4, click: 1, scene: 1 })
    expect((await call(owner, 'GET', `/api/ad-spaces/${el.id}/report?days=7`)).json().report.ads[0].screen).toBe(3)
    // Only full access: an editor and a stranger see nothing
    const editor = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: editor.id, role: 'editor' })
    expect((await call(editor, 'GET', `/api/ad-spaces/${el.id}/report`)).statusCode).toBe(403)
    expect((await call(await createUser(), 'GET', `/api/ad-spaces/${el.id}/report`)).statusCode).toBe(403)
  })
})
