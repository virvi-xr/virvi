import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { ads, adCreatives, adPlacements, adEvents, locationSetups } from '../src/db/schema.js'
import { recordAdEvents } from '../src/ads/events.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { signedSceneHeaders, SCENE_META } from './helpers/dcl-sign.js'

const NOW = new Date('2026-10-19T12:00:00Z')

async function mkAd(kind: 'house' | 'partner', shape = '1:1', creativeKind: 'image' | 'video' = 'image') {
  const [ad] = await db.insert(ads).values({ name: 'A', kind, clickUrl: 'https://x.example', reviewStatus: 'approved', audience: 'family' }).returning()
  const [c] = await db.insert(adCreatives).values({ adId: ad.id, shape, kind: creativeKind, url: `https://cdn.example/${ad.id}` }).returning()
  return { ad, c }
}

/** A Virvi scene set up at SCENE_META's parcel, recorded as that signed deployment, so a signed request binds to it. */
async function boundScene() {
  const owner = await createUser()
  const { scene, preset } = await createScene(owner)
  const loc = await createAnalyticsScene({ locationKey: `gc:${SCENE_META.parcel}`, baseParcel: SCENE_META.parcel, parcels: [SCENE_META.parcel] } as any)
  const setup = await createSetup(loc.id, scene.id)
  await db.update(locationSetups).set({ deploymentEntityId: SCENE_META.sceneId }).where(eq(locationSetups.id, setup.id))
  return { owner, scene, preset }
}

describe('/api/ads/serve and /api/ads/events', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const signed = async (url: string, payload: unknown, opts: { metadata?: Record<string, unknown> } = {}) => {
    const body = JSON.stringify(payload)
    const { headers, wallet } = await signedSceneHeaders({ method: 'POST', path: url, body, metadata: opts.metadata })
    const res = await app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: body })
    return { res, wallet }
  }

  it("serve returns the selected ads for the signed scene's elements", async () => {
    const { preset } = await boundScene()
    const el = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const house = await mkAd('house')
    const { res } = await signed('/api/ads/serve', { elementIds: [el.id] })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      spaces: {
        [el.id]: { paused: false, ads: [{ adId: house.ad.id, creativeId: house.c.id, kind: 'image', url: house.c.url, clickUrl: 'https://x.example', house: true }] },
      },
    })
  })

  it('rejects element ids that are not in the signed scene', async () => {
    const { owner, preset } = await boundScene()
    const mine = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const other = await createScene(owner, 'Other')
    const theirs = await createElement(other.preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    await mkAd('house')
    for (const ids of [[mine.id, theirs.id], [theirs.id], ['not-a-uuid']]) {
      const { res } = await signed('/api/ads/serve', { elementIds: ids })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'element_not_in_scene' })
    }
    const tooMany = Array.from({ length: 51 }, () => mine.id)
    expect((await signed('/api/ads/serve', { elementIds: tooMany })).res.statusCode).toBe(400)
  })

  it('serve accepts a booking-preset element and its original through clonedFromId', async () => {
    const { scene, preset } = await boundScene()
    const original = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const { scenePresets, scenes, sceneElements } = await import('../src/db/schema.js')
    const [booking] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Booking' }).returning()
    const [clone] = await db.insert(sceneElements).values({ presetId: booking.id, type: 'ad_space', name: 'Clone', properties: { shape: '1:1', formats: 'both' }, clonedFromId: original.id }).returning()
    await db.update(scenes).set({ activePresetId: booking.id }).where(eq(scenes.id, scene.id))
    await mkAd('house')
    const { res } = await signed('/api/ads/serve', { elementIds: [clone.id, original.id] })
    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.json().spaces).sort()).toEqual([clone.id, original.id].sort())
  })

  it('rejects unsigned requests', async () => {
    const { preset } = await boundScene()
    const el = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const serve = await app.inject({ method: 'POST', url: '/api/ads/serve', payload: { elementIds: [el.id] } })
    expect(serve.statusCode).toBe(401)
    const events = await app.inject({ method: 'POST', url: '/api/ads/events', payload: { v: 1, sessionId: 's', events: [] } })
    expect(events.statusCode).toBe(401)
    // A signature over a different body is not a signed request for this one.
    const { headers } = await signedSceneHeaders({ method: 'POST', path: '/api/ads/serve', body: '{"elementIds":[]}' })
    const forged = await app.inject({ method: 'POST', url: '/api/ads/serve', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ elementIds: [el.id] }) })
    expect(forged.statusCode).toBe(401)
  })

  // The web explorer signs the request (wallet, scene) but leaves the body out of the signature.
  const WEB = { metadata: { hashPayload: undefined } }

  it('serve answers a web-explorer request (signed, body not hashed)', async () => {
    const { preset } = await boundScene()
    const el = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    await mkAd('house')
    const { res } = await signed('/api/ads/serve', { elementIds: [el.id] }, WEB)
    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.json().spaces)).toEqual([el.id])
  })

  it('web-explorer events count under the signed wallet, once per ad per level per day', async () => {
    const { preset } = await boundScene()
    const a = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const onA = await mkAd('partner')
    await db.insert(adPlacements).values({ adId: onA.ad.id, elementId: a.id })
    const batch = { v: 1, sessionId: 'web-1', events: [{ adId: onA.ad.id, elementId: a.id, level: 'screen', t: 1 }] }
    const first = await signed('/api/ads/events', batch, WEB)
    expect(first.res.statusCode).toBe(200)
    expect(first.res.json()).toEqual({ accepted: 1 })
    // A new session id does not make the same wallet count again
    const again = await signed('/api/ads/events', { ...batch, sessionId: 'web-2' }, WEB)
    expect(again.res.json()).toEqual({ accepted: 0 })
    const rows = await db.select().from(adEvents)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ viewerKey: `w:${first.wallet}`, verified: true })
  })

  it('a signed request with no bound scene is 404 scene_not_found', async () => {
    const { res } = await signed('/api/ads/serve', { elementIds: [] })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'scene_not_found' })
  })

  it('an empty events batch is a 400', async () => {
    await boundScene()
    const { res } = await signed('/api/ads/events', { v: 1, sessionId: 's1', events: [] })
    expect(res.statusCode).toBe(400)
  })

  it('counts a wallet once per ad per level per day and drops unplaced pairs', async () => {
    const { owner, preset } = await boundScene()
    const a = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const b = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const other = await createScene(owner, 'Other')
    const foreign = await createElement(other.preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const onA = await mkAd('partner')
    const onB = await mkAd('partner')
    await db.insert(adPlacements).values([{ adId: onA.ad.id, elementId: a.id }, { adId: onB.ad.id, elementId: b.id }, { adId: onA.ad.id, elementId: foreign.id }])
    const batch = {
      v: 1,
      sessionId: 'sess-1',
      events: [
        { adId: onA.ad.id, elementId: a.id, level: 'scene', t: 1 },
        { adId: onA.ad.id, elementId: a.id, level: 'screen', t: 2 },
        { adId: onA.ad.id, elementId: a.id, level: 'screen', t: 3 }, // same wallet, ad, level, day
        { adId: onB.ad.id, elementId: a.id, level: 'screen', t: 4 }, // placed on b, not a
        { adId: onA.ad.id, elementId: foreign.id, level: 'look', t: 5 }, // another scene's element
      ],
    }
    const first = await signed('/api/ads/events', batch)
    expect(first.res.statusCode).toBe(200)
    expect(first.res.json()).toEqual({ accepted: 2 })
    const again = await signed('/api/ads/events', batch)
    expect(again.res.json()).toEqual({ accepted: 0 })
    const rows = await db.select().from(adEvents)
    expect(rows.map((r) => [r.adId, r.elementId, r.level]).sort()).toEqual([[onA.ad.id, a.id, 'scene'], [onA.ad.id, a.id, 'screen']].sort())
    const today = new Date().toISOString().slice(0, 10)
    expect(rows.every((r) => r.viewerKey === `w:${first.wallet}` && r.verified === true && r.house === false && r.day === today)).toBe(true)
  })

  it('the same ad on two spaces counts once per wallet on each space', async () => {
    const { preset } = await boundScene()
    const a = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const b = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const p = await mkAd('partner')
    await db.insert(adPlacements).values([{ adId: p.ad.id, elementId: a.id }, { adId: p.ad.id, elementId: b.id }])
    const batch = {
      v: 1,
      sessionId: 'sess-1',
      events: [
        { adId: p.ad.id, elementId: a.id, level: 'screen', t: 1 },
        { adId: p.ad.id, elementId: b.id, level: 'screen', t: 2 },
        { adId: p.ad.id, elementId: b.id, level: 'screen', t: 3 },
      ],
    }
    const { res } = await signed('/api/ads/events', batch)
    expect(res.json()).toEqual({ accepted: 2 })
    const rows = await db.select().from(adEvents)
    expect(rows.map((r) => r.elementId).sort()).toEqual([a.id, b.id].sort())
  })

  it('guest and unsigned-wallet viewers are stored as unverified with a session key', async () => {
    const { scene, preset } = await boundScene()
    const el = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const house = await mkAd('house')
    const { res } = await signed('/api/ads/events', { v: 1, sessionId: 'guest-sess', events: [{ adId: house.ad.id, elementId: el.id, level: 'screen', t: 1 }] }, { metadata: { isGuest: true } })
    expect(res.json()).toEqual({ accepted: 1 })
    const n = await recordAdEvents(scene.id, { wallet: null, isGuest: false, sessionId: 'anon-sess' }, [{ adId: house.ad.id, elementId: el.id, level: 'screen', t: 1 }], NOW)
    expect(n).toBe(1)
    const rows = await db.select().from(adEvents)
    expect(rows.map((r) => [r.viewerKey, r.verified, r.house]).sort()).toEqual([['u:anon-sess', false, true], ['u:guest-sess', false, true]])
    expect(rows.find((r) => r.viewerKey === 'u:anon-sess')!.day).toBe('2026-10-19')
  })

  it('dwellMs is kept for look events only', async () => {
    const { scene, preset } = await boundScene()
    const el = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
    const house = await mkAd('house')
    const viewer = { wallet: '0x00000000000000000000000000000000000000a1', isGuest: false, sessionId: 's' }
    const n = await recordAdEvents(scene.id, viewer, [
      { adId: house.ad.id, elementId: el.id, level: 'look', t: 1, dwellMs: 1500 },
      { adId: house.ad.id, elementId: el.id, level: 'screen', t: 2, dwellMs: 900 },
    ], NOW)
    expect(n).toBe(2)
    const rows = await db.select().from(adEvents)
    expect(Object.fromEntries(rows.map((r) => [r.level, r.dwellMs]))).toEqual({ look: 1500, screen: null })
    expect(rows.every((r) => r.viewerKey === `w:${viewer.wallet}` && r.verified)).toBe(true)
  })
})
