import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { giveawayItems, giveaways, giveawayScenes, sceneCollaborators, sceneElements } from '../src/db/schema.js'
import { serializePreset } from '../src/services/scene-serializer.js'
import { withKioskItems } from '../src/giveaways/kiosk.js'
import { issueScenePass } from '../src/auth/scene-pass.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { giveawaysOn } from './helpers/giveaways-fake.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

/** Giveaway kiosks (scene elements of type claim_point): saved, checked, linked to their giveaway, and sent to scenes. */
const C1 = '0x' + 'c1'.repeat(20)
const C2 = '0x' + 'c2'.repeat(20)
const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
const propsOf = async (id: string) => (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!.properties as Record<string, any>
const scenesOf = async (giveawayId: string) => (await db.select().from(giveawayScenes).where(eq(giveawayScenes.giveawayId, giveawayId))).map((r) => r.sceneId)

async function giveawayFor(owner: TestUser, over: Partial<typeof giveaways.$inferInsert> = {}) {
  const [g] = await db.insert(giveaways).values({ ownerId: owner.id, name: 'Launch party', ...over }).returning()
  await db.insert(giveawayItems).values([
    { giveawayId: g.id, contractAddress: C2, itemId: '0', name: 'Shoes', imageUrl: null },
    { giveawayId: g.id, contractAddress: C1, itemId: '10', name: 'Cape', imageUrl: 'https://peer.example/cape.png' },
    { giveawayId: g.id, contractAddress: C1, itemId: '2', name: 'Hat', imageUrl: 'https://peer.example/hat.png' },
  ])
  return g
}

describe('scene serializer', () => {
  it('puts claim_point elements in claimPoints (it used to look for "claimpoint")', () => {
    const el = (id: string, type: string) => ({
      id, presetId: 'p', type, name: id, enabled: true, customId: null, customRendering: false, clickEvent: null, properties: { hoverText: 'Get it' }, instances: [],
    })
    const s = serializePreset({ id: 'p', sceneId: 's', name: 'Default', locale: null, elements: [el('k', 'claim_point'), el('i', 'image')] })
    expect(s.claimPoints.map((e) => e.sk)).toEqual(['k'])
    expect(s.claimPoints[0].hoverText).toBe('Get it')
    expect(s.images.map((e) => e.sk)).toEqual(['i'])
  })
})

describe('kiosk items', () => {
  beforeEach(() => resetDb())

  it("adds the linked giveaway's items in card order, with wearable URNs; nothing for a deleted or missing giveaway", async () => {
    const host = await createUser()
    const g = await giveawayFor(host)
    const gone = await giveawayFor(host, { deletedAt: new Date() })
    const out = await withKioskItems([
      { sk: 'a', giveawayId: g.id }, { sk: 'b', giveawayId: gone.id }, { sk: 'c' }, { sk: 'd', giveawayId: crypto.randomUUID(), giveawayItems: [{ urn: 'forged' }] },
    ])
    expect(out[0].giveawayItems).toEqual([
      { name: 'Hat', thumbnail: 'https://peer.example/hat.png', urn: `urn:decentraland:matic:collections-v2:${C1}:2` },
      { name: 'Cape', thumbnail: 'https://peer.example/cape.png', urn: `urn:decentraland:matic:collections-v2:${C1}:10` },
      { name: 'Shoes', thumbnail: null, urn: `urn:decentraland:matic:collections-v2:${C2}:0` },
    ])
    expect(out.slice(1).map((k) => k.giveawayItems)).toEqual([[], [], []])
  })
})

describe('saving kiosks', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let off: () => void
  let host: TestUser
  let sceneId: string
  let presetId: string
  beforeEach(async () => {
    await resetDb()
    ;({ off } = giveawaysOn())
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    const s = await createScene(host, 'Venue')
    sceneId = s.scene.id
    presetId = s.preset.id
  })
  afterEach(async () => { off(); await app.close() })

  const create = (properties: unknown, user = host, headers = as(user)) =>
    app.inject({ method: 'POST', url: `/api/presets/${presetId}/elements`, headers, payload: { type: 'claim_point', name: 'Kiosk 1', properties } })

  it("a kiosk picking the host's giveaway links the giveaway to the scene", async () => {
    const g = await giveawayFor(host)
    const res = await create({ giveawayId: g.id, claimPointType: 1, imgSrc: ' https://cdn.virvi.io/k.png ', hoverText: ' Claim ', giveawayItems: [{ urn: 'x' }] })
    expect(res.statusCode).toBe(201)
    expect(res.json().element.type).toBe('claim_point')
    expect(await propsOf(res.json().element.id)).toEqual({ giveawayId: g.id, claimPointType: 1, imgSrc: 'https://cdn.virvi.io/k.png', hoverText: 'Claim' })
    expect(await scenesOf(g.id)).toEqual([sceneId])
    // Already linked: saving again changes nothing
    const again = await create({ giveawayId: g.id })
    expect(again.statusCode).toBe(201)
    expect(await scenesOf(g.id)).toEqual([sceneId])
  })

  it('a kiosk with no giveaway yet is fine', async () => {
    const res = await create({ claimPointType: 0 })
    expect(res.statusCode).toBe(201)
  })

  it("refuses someone else's giveaway (404) and saves nothing", async () => {
    const stranger = await createUser()
    const g = await giveawayFor(stranger)
    const res = await create({ giveawayId: g.id })
    expect([res.statusCode, res.json().error]).toEqual([404, 'not_found'])
    expect(await db.select().from(sceneElements)).toEqual([])
    expect(await scenesOf(g.id)).toEqual([])
  })

  it("an editor of the scene can't pick the scene owner's giveaway, but can pick their own", async () => {
    const editor = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId, userId: editor.id, role: 'editor' })
    const theirs = await giveawayFor(host)
    expect((await create({ giveawayId: theirs.id }, editor)).statusCode).toBe(404)
    const own = await giveawayFor(editor)
    expect((await create({ giveawayId: own.id }, editor)).statusCode).toBe(201)
    expect(await scenesOf(own.id)).toEqual([sceneId])
  })

  it('refuses bad settings with the reason', async () => {
    const res = await create({ claimPointType: 9 })
    expect([res.statusCode, res.json().error]).toEqual([400, 'bad_kiosk'])
    expect((await create({ hoverText: 'x'.repeat(41) })).statusCode).toBe(400)
    expect((await create({ color1: { r: 3, g: 0, b: 0 } })).statusCode).toBe(400)
  })

  it('a scene pass may not pick a giveaway (it is picked in the dashboard)', async () => {
    const g = await giveawayFor(host)
    const pass = issueScenePass(app, host as any, host.wallet!, { sceneId, locationId: null }).accessToken
    const res = await create({ giveawayId: g.id }, host, { authorization: `Bearer ${pass}` })
    expect(res.statusCode).toBe(403)
    expect(await scenesOf(g.id)).toEqual([])
  })

  it('without giveaways switched on, picking one is 503 giveaways_off', async () => {
    const g = await giveawayFor(host)
    off()
    off = () => {}
    const res = await create({ giveawayId: g.id })
    expect([res.statusCode, res.json().error]).toEqual([503, 'giveaways_off'])
  })

  it('changing the giveaway links the new one; other edits leave the links alone', async () => {
    const first = await giveawayFor(host)
    const el = await createElement(presetId, { type: 'claim_point', name: 'K', properties: { giveawayId: first.id } })
    const put = (properties: unknown) => app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(host), payload: { properties } })
    // The kiosk was stored by hand, unlinked: an edit that keeps its giveaway doesn't link it
    expect((await put({ giveawayId: first.id, enableSpin: true })).statusCode).toBe(200)
    expect(await scenesOf(first.id)).toEqual([])
    const second = await giveawayFor(host)
    expect((await put({ giveawayId: second.id })).statusCode).toBe(200)
    expect(await scenesOf(second.id)).toEqual([sceneId])
    const stranger = await createUser()
    const theirs = await giveawayFor(stranger)
    expect((await put({ giveawayId: theirs.id })).statusCode).toBe(404)
    expect((await propsOf(el.id)).giveawayId).toBe(second.id)
    expect((await put({ giveawayId: null })).statusCode).toBe(200)
    expect((await propsOf(el.id)).giveawayId).toBeNull()
  })

  it("an image can't smuggle someone else's giveaway into a kiosk by changing its type", async () => {
    const stranger = await createUser()
    const theirs = await giveawayFor(stranger)
    // Creating an image with a giveawayId stores none
    const made = await app.inject({ method: 'POST', url: `/api/presets/${presetId}/elements`, headers: as(host), payload: { type: 'image', name: 'Pic', properties: { textureSrc: 'a.png', giveawayId: theirs.id, giveawayItems: [{ urn: 'x' }] } } })
    expect(made.statusCode).toBe(201)
    expect(await propsOf(made.json().element.id)).toEqual({ textureSrc: 'a.png' })
    // One stored before this check (or by hand): turning it into a kiosk, with no properties in the body, checks the giveaway
    const old = await createElement(presetId, { type: 'image', name: 'Old', properties: { textureSrc: 'a.png', giveawayId: theirs.id } })
    const put = await app.inject({ method: 'PUT', url: `/api/elements/${old.id}`, headers: as(host), payload: { type: 'claim_point' } })
    expect(put.statusCode).toBe(404)
    expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, old.id) }))!.type).toBe('image')
    expect(await scenesOf(theirs.id)).toEqual([])
    // With properties that keep the old giveawayId, too
    const put2 = await app.inject({ method: 'PUT', url: `/api/elements/${old.id}`, headers: as(host), payload: { type: 'claim_point', properties: { giveawayId: theirs.id } } })
    expect(put2.statusCode).toBe(404)
  })

  it('a type change to a kiosk with the host\'s own giveaway links it and stores the settings tidied', async () => {
    const g = await giveawayFor(host)
    const el = await createElement(presetId, { type: 'image', name: 'Pic', properties: { giveawayId: g.id, hoverText: ' Hi ' } })
    const put = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(host), payload: { type: 'claim_point' } })
    expect(put.statusCode).toBe(200)
    expect(await propsOf(el.id)).toEqual({ giveawayId: g.id, hoverText: 'Hi' })
    expect(await scenesOf(g.id)).toEqual([sceneId])
  })

  it('a kiosk turned into something else drops its giveaway', async () => {
    const g = await giveawayFor(host)
    const el = await createElement(presetId, { type: 'claim_point', name: 'K', properties: { giveawayId: g.id, textureSrc: 'a.png' } })
    const put = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(host), payload: { type: 'image' } })
    expect(put.statusCode).toBe(200)
    expect(await propsOf(el.id)).toEqual({ textureSrc: 'a.png' })
    const upd = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(host), payload: { properties: { textureSrc: 'b.png', giveawayId: g.id } } })
    expect(upd.statusCode).toBe(200)
    expect(await propsOf(el.id)).toEqual({ textureSrc: 'b.png' })
  })

  it('a giveaway being deleted takes no kiosk', async () => {
    const g = await giveawayFor(host, { deleteState: 'returning' })
    expect((await create({ giveawayId: g.id })).statusCode).toBe(409)
  })
})

describe('kiosks reach the scene', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  let app: Awaited<ReturnType<typeof testApp>>
  let off: () => void
  beforeEach(async () => { await resetDb(); ({ off } = giveawaysOn()); gs = await startGameServer(); app = await testApp() })
  afterEach(async () => { off(); await app.close(); await gs.stop() })

  it("a scene load carries each kiosk with its giveaway's items, and an edit sends it again with them", async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene, preset } = await createScene(host)
    const g = await giveawayFor(host)
    const el = await createElement(preset.id, { type: 'claim_point', name: 'K', properties: { giveawayId: g.id, claimPointType: 0 } })
    const c = await joinScene(gs.url, scene.id, tokenFor(host))
    const init = await c.waitFor('scene_preset_update')
    expect(init.scenePreset.claimPoints).toHaveLength(1)
    expect(init.scenePreset.claimPoints[0]).toMatchObject({ sk: el.id, giveawayId: g.id, claimPointType: 0 })
    expect(init.scenePreset.claimPoints[0].giveawayItems.map((i: any) => i.name)).toEqual(['Hat', 'Cape', 'Shoes'])

    const res = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(host), payload: { properties: { giveawayId: g.id, enableSpin: true } } })
    expect(res.statusCode).toBe(200)
    const up = await c.waitFor('scene_preset_update')
    expect(up).toMatchObject({ action: 'upsert', element: 'claim_point', elementData: { sk: el.id, enableSpin: true } })
    expect(up.elementData.giveawayItems).toHaveLength(3)
  })

  it("the room relays an edit without a giveaway or kiosk items, and no element type stores them", async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene, preset } = await createScene(host)
    const stranger = await createUser()
    const theirs = await giveawayFor(stranger)
    const el = await createElement(preset.id, { type: 'claim_point', name: 'K', properties: { hoverText: 'Claim' } })
    const img = await createElement(preset.id, { type: 'image', name: 'P', properties: { textureSrc: 'a.png' } })
    const sender = await joinScene(gs.url, scene.id, tokenFor(host))
    const watcher = await joinScene(gs.url, scene.id, tokenFor(host))
    await sender.waitFor('scene_preset_update')
    await watcher.waitFor('scene_preset_update')
    const forged = [{ name: 'Fake', thumbnail: 'https://evil/x.png', urn: 'urn:x' }]
    sender.room.send('scene_preset_update', {
      action: 'update', element: 'claim_point',
      elementData: { sk: el.id, giveawayId: theirs.id, giveawayItems: forged, hoverText: 'Free', properties: { giveawayId: theirs.id, giveawayItems: forged } },
    })
    const relayed = await watcher.waitFor('scene_preset_update')
    expect(relayed.elementData).toEqual({ sk: el.id, hoverText: 'Free', properties: {} })
    sender.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { sk: img.id, giveawayId: theirs.id, textureSrc: 'b.png' } })
    expect((await watcher.waitFor('scene_preset_update')).elementData).toEqual({ sk: img.id, textureSrc: 'b.png' })
    await new Promise((r) => setTimeout(r, 300))
    expect(await propsOf(img.id)).toEqual({ textureSrc: 'b.png' })
  })

  it("the room never stores a kiosk's giveaway (it is picked in the dashboard)", async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene, preset } = await createScene(host)
    const stranger = await createUser()
    const theirs = await giveawayFor(stranger)
    const el = await createElement(preset.id, { type: 'claim_point', name: 'K', properties: { hoverText: 'Claim' } })
    const c = await joinScene(gs.url, scene.id, tokenFor(host))
    await c.waitFor('scene_preset_update')
    c.room.send('scene_preset_update', { action: 'update', element: 'claim_point', elementData: { sk: el.id, giveawayId: theirs.id, hoverText: 'Free hat' } })
    await new Promise((r) => setTimeout(r, 300))
    expect(await propsOf(el.id)).toEqual({ hoverText: 'Free hat' })
    expect(await scenesOf(theirs.id)).toEqual([])
  })
})
