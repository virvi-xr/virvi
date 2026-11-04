import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEFAULT_VENUE_RULES, VENUE_ROLE_SCOPES } from '@virvixr/shared'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  accessGrants, bookings, roomSets, sceneCollaborators, sceneElementInstances, sceneElements, scenePresets, sceneRoles, scenes, venues,
} from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createElement, createInstance, createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const H = 3600_000

describe('scene presets (LIV-84)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let scene: Awaited<ReturnType<typeof createScene>>['scene']
  let preset: Awaited<ReturnType<typeof createScene>>['preset']
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    host = await createUser()
    ;({ scene, preset } = await createScene(host))
  })
  afterEach(async () => { await app.close() })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const create = (u: TestUser, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/presets`, headers: as(u), payload })
  const rename = (u: TestUser, id: string, name: unknown) => app.inject({ method: 'PATCH', url: `/api/presets/${id}`, headers: as(u), payload: { name } })
  const remove = (u: TestUser, id: string) => app.inject({ method: 'DELETE', url: `/api/presets/${id}`, headers: as(u) })
  const activate = (u: TestUser, id: string) => app.inject({ method: 'POST', url: `/api/presets/${id}/activate`, headers: as(u) })
  const activeId = async () => (await db.query.scenes.findFirst({ where: eq(scenes.id, scene.id) }))!.activePresetId

  it('creates a blank preset with a trimmed name', async () => {
    const res = await create(host, { name: '  Concert ' })
    expect(res.statusCode).toBe(201)
    expect(res.json().preset).toMatchObject({ name: 'Concert' })
    const els = await db.select().from(sceneElements).where(eq(sceneElements.presetId, res.json().preset.id))
    expect(els).toHaveLength(0)
    expect((await create(host, { name: '   ' })).statusCode).toBe(400)
    expect((await create(host, { name: 'x'.repeat(61) })).statusCode).toBe(400)
  })

  it('duplicates every element and instance into an independent copy', async () => {
    const screen = await createElement(preset.id, { type: 'video', name: 'Screen', properties: { liveSrc: 'https://a/live.m3u8' } })
    await db.update(sceneElements).set({ clickEvent: { type: 'link', url: 'https://a' } }).where(eq(sceneElements.id, screen.id))
    const parent = await createInstance(screen.id)
    const [child] = await db.insert(sceneElementInstances)
      .values({ elementId: screen.id, position: { x: 5, y: 0, z: 2 }, parentInstanceId: parent.id, clickEvent: { type: 'none' } }).returning()
    const model = await createElement(preset.id, { type: 'model', name: 'Room', properties: { modelSrc: 'https://cdn/x.glb' } })
    await createInstance(model.id)
    await db.insert(roomSets).values({
      userId: host.id, options: {}, storageKey: 'room-sets/x.glb', glbUrl: 'https://cdn/x.glb', triangles: 10, plot: {}, offset: {}, sceneElementId: model.id,
    })

    const res = await create(host, { name: 'Copy of Default', fromPresetId: preset.id })
    expect(res.statusCode).toBe(201)
    const copy = await db.query.scenePresets.findFirst({
      where: eq(scenePresets.id, res.json().preset.id), with: { elements: { with: { instances: true } } },
    })
    expect(copy!.elements).toHaveLength(2)
    const copiedScreen = copy!.elements.find((e) => e.name === 'Screen')!
    expect(copiedScreen.id).not.toBe(screen.id)
    expect(copiedScreen).toMatchObject({ type: 'video', properties: { liveSrc: 'https://a/live.m3u8' }, clickEvent: { type: 'link', url: 'https://a' }, clonedFromId: null })
    expect(copiedScreen.instances).toHaveLength(2)
    const copiedChild = copiedScreen.instances.find((i) => i.parentInstanceId)!
    expect(copiedChild.position).toEqual(child.position)
    expect(copiedScreen.instances.map((i) => i.id)).toContain(copiedChild.parentInstanceId)
    expect(copiedChild.parentInstanceId).not.toBe(parent.id)
    // The copied room set model is still a room set (its own row, same GLB)
    const copiedModel = copy!.elements.find((e) => e.name === 'Room')!
    const [set] = await db.select().from(roomSets).where(eq(roomSets.sceneElementId, copiedModel.id))
    expect(set.glbUrl).toBe('https://cdn/x.glb')

    // Independent: editing the copy leaves the original alone
    await app.inject({ method: 'PUT', url: `/api/elements/${copiedScreen.id}`, headers: as(host), payload: { name: 'Renamed' } })
    expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, screen.id) }))!.name).toBe('Screen')
  })

  it("refuses to copy another scene's preset", async () => {
    const other = await createScene(host, 'Other')
    expect((await create(host, { name: 'x', fromPresetId: other.preset.id })).statusCode).toBe(400)
  })

  it('renames, makes live, and deletes', async () => {
    const concert = (await create(host, { name: 'Concert' })).json().preset
    expect((await rename(host, concert.id, 'Big Concert')).json().preset.name).toBe('Big Concert')
    expect((await rename(host, concert.id, '')).statusCode).toBe(400)
    expect((await activate(host, concert.id)).json()).toEqual({ activePresetId: concert.id })
    expect(await activeId()).toBe(concert.id)
    expect((await remove(host, preset.id)).statusCode).toBe(204)
    expect(await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, preset.id) })).toBeUndefined()
  })

  it('deletes a copied room set row with its preset, keeping the shared GLB row of the original', async () => {
    const model = await createElement(preset.id, { type: 'model', name: 'Room', properties: { modelSrc: 'https://cdn/x.glb' } })
    await db.insert(roomSets).values({
      userId: host.id, options: {}, storageKey: 'room-sets/x.glb', glbUrl: 'https://cdn/x.glb', triangles: 10, plot: {}, offset: {}, sceneElementId: model.id,
    })
    const copy = (await create(host, { name: 'Copy', fromPresetId: preset.id })).json().preset
    expect(await db.select().from(roomSets)).toHaveLength(2)
    expect((await remove(host, copy.id)).statusCode).toBe(204)
    const left = await db.select().from(roomSets)
    expect(left.map((r) => r.sceneElementId)).toEqual([model.id])
  })

  describe('delete refusals (409, with the reason)', () => {
    it('the live preset', async () => {
      await create(host, { name: 'Other' })
      const res = await remove(host, preset.id)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'preset_live', message: expect.stringContaining('live') })
    })

    it("the scene's only preset", async () => {
      await db.update(scenes).set({ activePresetId: null }).where(eq(scenes.id, scene.id))
      const res = await remove(host, preset.id)
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('preset_only')
    })

    it("a venue's default preset, naming the venue", async () => {
      const other = (await create(host, { name: 'Other' })).json().preset
      await activate(host, other.id)
      await db.insert(venues).values({ sceneId: scene.id, name: 'Neon Arbor', slug: `a-${crypto.randomUUID()}`, defaultPresetId: preset.id, rules: DEFAULT_VENUE_RULES, rentableElementIds: [] })
      const res = await remove(host, preset.id)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'preset_venue_default', message: 'This is the default preset for venue Neon Arbor.' })
    })

    it('the preset of an upcoming or live booking, but not an ended one', async () => {
      const [venue] = await db.insert(venues).values({ sceneId: scene.id, name: 'V', slug: `v-${crypto.randomUUID()}`, defaultPresetId: preset.id, rules: DEFAULT_VENUE_RULES, rentableElementIds: [] }).returning()
      const bp = (await create(host, { name: 'booking copy' })).json().preset
      const book = async (status: 'confirmed' | 'live' | 'ended', startsInMs: number) => {
        const startsAt = new Date(Date.now() + startsInMs)
        const endsAt = new Date(startsAt.getTime() + 2 * H)
        await db.delete(bookings)
        await db.insert(bookings).values({ venueId: venue.id, renterUserId: host.id, title: 'Show', startsAt, endsAt, status, bookingPresetId: bp.id, blockedRange: `[${startsAt.toISOString()},${endsAt.toISOString()})` })
      }
      await book('confirmed', 24 * H)
      expect((await remove(host, bp.id)).json()).toEqual({ error: 'preset_booking', message: 'The booking "Show" uses this preset.' })
      await book('live', -H)
      expect((await remove(host, bp.id)).statusCode).toBe(409)
      await book('ended', -5 * H)
      expect((await remove(host, bp.id)).statusCode).toBe(204)
    })
  })

  describe('who can manage presets', () => {
    async function people() {
      const editor = await createUser()
      await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: editor.id, role: 'editor' })
      const viewer = await createUser()
      await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: viewer.id, role: 'viewer' })
      const cohost = await createUser({ wallet: randomWallet() })
      await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: cohost.wallet!, role: 'cohost', grantedBy: host.id })
      // Booking crew with every venue scope there is
      const crew = await createUser({ wallet: randomWallet() })
      const [venue] = await db.insert(venues).values({ sceneId: scene.id, name: 'V', slug: `v-${crypto.randomUUID()}`, defaultPresetId: preset.id, rules: DEFAULT_VENUE_RULES, rentableElementIds: [] }).returning()
      const startsAt = new Date(Date.now() - H)
      const endsAt = new Date(Date.now() + H)
      const [booking] = await db.insert(bookings).values({ venueId: venue.id, renterUserId: crew.id, title: 'Show', startsAt, endsAt, status: 'live', bookingPresetId: preset.id, blockedRange: `[${startsAt.toISOString()},${endsAt.toISOString()})` }).returning()
      const allScopes = [...new Set(Object.values(VENUE_ROLE_SCOPES).flat())]
      await db.insert(accessGrants).values({ bookingId: booking.id, sceneId: scene.id, userId: crew.id, role: 'vj', scopes: allScopes as any, validFrom: startsAt, validUntil: endsAt })
      return { editor, viewer, cohost, crew }
    }

    it('host, co-host and editor can; viewer and booking crew get 403 on every route', async () => {
      const { editor, viewer, cohost, crew } = await people()
      const other = (await create(host, { name: 'Other' })).json().preset
      for (const u of [cohost, editor]) {
        const made = await create(u, { name: 'Mine', fromPresetId: preset.id })
        expect(made.statusCode).toBe(201)
        expect((await rename(u, made.json().preset.id, 'Renamed')).statusCode).toBe(200)
        expect((await activate(u, other.id)).statusCode).toBe(200)
        expect((await remove(u, made.json().preset.id)).statusCode).toBe(204)
      }
      // The crew really are crew (grant access during the booking), so their 403s are about presets, not access
      expect((await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}`, headers: as(crew) })).statusCode).toBe(200)
      for (const u of [viewer, crew]) {
        expect((await create(u, { name: 'x' })).statusCode).toBe(403)
        expect((await rename(u, other.id, 'x')).statusCode).toBe(403)
        expect((await activate(u, preset.id)).statusCode).toBe(403)
        expect((await remove(u, other.id)).statusCode).toBe(403)
      }
      const stranger = await createUser()
      expect((await rename(stranger, other.id, 'x')).statusCode).toBe(403)
      expect((await rename(host, crypto.randomUUID(), 'x')).statusCode).toBe(404)
      expect((await rename(host, 'not-a-uuid', 'x')).statusCode).toBe(404)
    })
  })
})
