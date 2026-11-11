import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneRoles, sceneElements, sceneElementInstances, sceneCollaborators, scenePresets, scenes, users } from '../src/db/schema.js'
import { createVenue, createBooking, addGrant, revokeGrant } from '../src/venues/service.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, createInstance, tokenFor, expiredTokenFor, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene, serverRoom } from './helpers/game-server.js'

const H = 3600_000
const update = (id: string, props: Record<string, unknown>) => ({
  action: 'update',
  element: 'video',
  elementData: { sk: id, ...props },
})
const propsOf = async (id: string) =>
  (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!.properties as Record<string, unknown>

describe('VirviSceneRoom auth', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  async function scene() {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const screen = await createElement(preset.id)
    return { owner, scene, preset, screen }
  }

  it('anonymous visitor receives init but cannot mutate', async () => {
    const s = await scene()
    const watcher = await joinScene(gs.url, s.scene.id, tokenFor(s.owner))
    await watcher.waitFor('scene_preset_update') // consume init
    const anon = await joinScene(gs.url, s.scene.id)
    expect((await anon.waitFor('auth_status')).authenticated).toBe(false)
    expect((await anon.waitFor('scene_preset_update')).action).toBe('init')

    anon.room.send('scene_preset_update', update(s.screen.id, { liveSrc: 'https://evil/x.m3u8' }))
    expect((await anon.waitFor('virvi_error')).code).toBe('forbidden')
    await watcher.expectNone('scene_preset_update')
    expect((await propsOf(s.screen.id)).liveSrc).toBe('https://old.example/live.m3u8')
  })

  it('owner can mutate; others in the room see the broadcast', async () => {
    const s = await scene()
    const owner = await joinScene(gs.url, s.scene.id, tokenFor(s.owner))
    const visitor = await joinScene(gs.url, s.scene.id)
    await visitor.waitFor('scene_preset_update') // init
    owner.room.send('scene_preset_update', update(s.screen.id, { liveSrc: 'https://new/live.m3u8', playlist: [] }))
    expect((await visitor.waitFor('scene_preset_update')).elementData.liveSrc).toBe('https://new/live.m3u8')
    expect((await propsOf(s.screen.id)).liveSrc).toBe('https://new/live.m3u8')
  })

  it('admin power in a room is the database’s: a demoted admin’s token can’t edit a stranger’s scene', async () => {
    const s = await scene()
    const admin = await createUser({ role: 'admin' })
    const token = tokenFor(admin) // minted while admin
    const ok = await joinScene(gs.url, s.scene.id, token)
    await ok.waitFor('scene_preset_update') // init
    ok.room.send('scene_preset_update', update(s.screen.id, { liveSrc: 'https://admin/live.m3u8', playlist: [] }))
    await ok.waitFor('scene_preset_update_ack')
    expect((await propsOf(s.screen.id)).liveSrc).toBe('https://admin/live.m3u8')
    await ok.room.leave()
    await db.update(users).set({ role: 'creator' }).where(eq(users.id, admin.id))
    const demoted = await joinScene(gs.url, s.scene.id, token)
    await demoted.waitFor('scene_preset_update') // init
    demoted.room.send('scene_preset_update', update(s.screen.id, { liveSrc: 'https://demoted/x.m3u8' }))
    expect((await demoted.waitFor('virvi_error')).code).toBe('forbidden')
    expect((await propsOf(s.screen.id)).liveSrc).toBe('https://admin/live.m3u8')
  })

  it('expired token joins as anonymous and is told so', async () => {
    const s = await scene()
    const c = await joinScene(gs.url, s.scene.id, expiredTokenFor(s.owner))
    expect((await c.waitFor('auth_status')).authenticated).toBe(false)
    c.room.send('scene_change_preset', { presetId: s.preset.id })
    expect((await c.waitFor('virvi_error')).code).toBe('forbidden')
  })

  it('owner of scene A cannot edit scene B elements through room A', async () => {
    const a = await scene()
    const b = await scene()
    await db.insert(sceneCollaborators).values({ sceneId: a.scene.id, userId: b.owner.id, role: 'editor' })
    const c = await joinScene(gs.url, a.scene.id, tokenFor(b.owner))
    c.room.send('scene_preset_update', update(b.screen.id, { liveSrc: 'x' }))
    expect((await c.waitFor('virvi_error')).code).toBe('not_found')
  })

  it('instance create cannot be redirected to another scene element', async () => {
    const a = await scene()
    const b = await scene()
    const c = await joinScene(gs.url, a.scene.id, tokenFor(a.owner))
    await c.waitFor('scene_preset_update') // init
    c.room.send('scene_preset_update', {
      action: 'create',
      element: 'video',
      instance: true,
      instanceData: { elementId: a.screen.id, position: { x: 2, y: 2, z: 2 } },
      elementData: { sk: b.screen.id },
    })
    for (let i = 0; i < 150 && !c.inbox.some((m) => m.type === 'scene_preset_update_ack' || m.type === 'virvi_error'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const underB = await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.elementId, b.screen.id))
    expect(underB).toHaveLength(0)
  })

  it('dashboard delete messages sent after the REST delete still broadcast', async () => {
    const s = await scene()
    const widget = await createElement(s.preset.id, { type: 'widget', name: 'Toggle' })
    const inst = await createInstance(s.screen.id)
    const owner = await joinScene(gs.url, s.scene.id, tokenFor(s.owner))
    const visitor = await joinScene(gs.url, s.scene.id)
    await visitor.waitFor('scene_preset_update') // init

    // apps/web handleDeleteInstance: REST delete, then this message
    await db.delete(sceneElementInstances).where(eq(sceneElementInstances.id, inst.id))
    owner.room.send('scene_preset_update', { action: 'delete_instance', instanceData: { id: inst.id } })
    expect((await visitor.waitFor('scene_preset_update')).action).toBe('delete_instance')

    // apps/web handleDeleteWidget: REST delete, then this message
    await db.delete(sceneElements).where(eq(sceneElements.id, widget.id))
    owner.room.send('scene_preset_update', { action: 'delete_element', element: 'widget', elementData: { id: widget.id } })
    expect((await visitor.waitFor('scene_preset_update')).action).toBe('delete_element')

    // non-editors still can't send them
    const stranger = await joinScene(gs.url, s.scene.id, tokenFor(await createUser()))
    stranger.room.send('scene_preset_update', { action: 'delete_element', element: 'widget', elementData: { id: widget.id } })
    expect((await stranger.waitFor('virvi_error')).code).toBe('forbidden')
    await visitor.expectNone('scene_preset_update')
  })

  it('different scenes get different rooms', async () => {
    const a = await scene()
    const b = await scene()
    const ca = await joinScene(gs.url, a.scene.id)
    const cb = await joinScene(gs.url, b.scene.id)
    expect(ca.room.roomId).not.toBe(cb.room.roomId)
  })

  describe('venue grants', () => {
    async function venueWithCrew(startInMs = 24 * H, role: 'vj' | 'cohost' = 'vj') {
      const admin = await createUser({ role: 'admin' })
      const { scene, preset } = await createScene(admin)
      const screen = await createElement(preset.id)
      const sideScreen = await createElement(preset.id, { name: 'Side Screen' })
      const venue = await createVenue({ sceneId: scene.id, name: 'Aurora', slug: `aurora-${crypto.randomUUID()}`, rentableElementIds: [screen.id] })
      const hostWallet = randomWallet()
      const host = await createUser({ wallet: hostWallet })
      const startsAt = new Date(Date.now() + startInMs)
      const { booking } = await createBooking({
        venueId: venue.id,
        renterWallet: hostWallet,
        title: 'Set',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 2 * H),
        createdByUserId: admin.id,
      })
      const crewWallet = randomWallet()
      const crew = await createUser({ wallet: crewWallet })
      const grant = await addGrant({ bookingId: booking.id, walletAddress: crewWallet, role, grantedByUserId: host.id })
      const clones = await db.select().from(sceneElements).where(eq(sceneElements.presetId, booking.bookingPresetId!))
      const clone = clones.find((c) => c.clonedFromId === screen.id)!
      const sideClone = clones.find((c) => c.clonedFromId === sideScreen.id)!
      return { admin, scene, preset, screen, sideScreen, venue, booking, host, crew, grant, clone, sideClone }
    }

    it('crew gets venue_access on join', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      const access = await c.waitFor('venue_access')
      expect(access).toMatchObject({ bookingId: v.booking.id, role: 'vj', window: 'setup' })
      expect(access.scopes.sort()).toEqual(['playlist', 'schedule', 'screens'])
    })

    it('in setup, crew edits the booking clone without broadcasting to the live scene', async () => {
      const v = await venueWithCrew()
      const visitor = await joinScene(gs.url, v.scene.id)
      await visitor.waitFor('scene_preset_update') // init
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      c.room.send('scene_preset_update', update(v.clone.id, { ...(v.clone.properties as object), liveSrc: 'https://dj/live.m3u8' }))
      await c.waitFor('scene_preset_update_ack')
      await visitor.expectNone('scene_preset_update')
      expect((await propsOf(v.clone.id)).liveSrc).toBe('https://dj/live.m3u8')
      expect((await propsOf(v.screen.id)).liveSrc).toBe('https://old.example/live.m3u8')
    })

    it('partial updates are diffed against only the keys sent (merge semantics)', async () => {
      const v = await venueWithCrew()
      // screens scope only: may toggle and edit non-playlist props, but not the playlist
      await db.update((await import('../src/db/schema.js')).accessGrants).set({ scopes: ['screens'] }).where(eq((await import('../src/db/schema.js')).accessGrants.id, v.grant.id))
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      await c.waitFor('venue_access')

      c.room.send('scene_preset_update', { action: 'update', element: 'video', elementData: { sk: v.clone.id, enabled: false } })
      await c.waitFor('scene_preset_update_ack')
      expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, v.clone.id) }))!.enabled).toBe(false)

      c.room.send('scene_preset_update', { action: 'update', element: 'video', elementData: { sk: v.clone.id, properties: { playlist: [{ url: 'x' }] } } })
      expect((await c.waitFor('virvi_error')).code).toBe('forbidden')
      expect((await propsOf(v.clone.id)).playlist).toEqual([])
    })

    it('crew cannot edit the live default preset element', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      c.room.send('scene_preset_update', update(v.screen.id, { liveSrc: 'x' }))
      expect((await c.waitFor('virvi_error')).code).toBe('forbidden')
    })

    it('crew without moderation cannot send moderator messages', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      c.room.send('scene_moderator_message', { message: 'hi' })
      expect((await c.waitFor('virvi_error')).code).toBe('forbidden')
    })

    it('live crew can switch only to the booking preset or the venue default', async () => {
      const v = await venueWithCrew(30 * 60_000, 'cohost')
      const [privatePreset] = await db.insert(scenePresets).values({ sceneId: v.scene.id, name: 'Owner Private' }).returning()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      expect((await c.waitFor('venue_access')).window).toBe('live')

      c.room.send('scene_change_preset', { presetId: privatePreset.id })
      expect((await c.waitFor('virvi_error')).code).toBe('forbidden')
      expect((await db.query.scenes.findFirst({ where: eq(scenes.id, v.scene.id) }))!.activePresetId).toBe(v.preset.id)

      c.room.send('scene_change_preset', { presetId: v.booking.bookingPresetId })
      await c.waitFor('scene_change_preset')
      expect((await db.query.scenes.findFirst({ where: eq(scenes.id, v.scene.id) }))!.activePresetId).toBe(v.booking.bookingPresetId)

      c.room.send('scene_change_preset', { presetId: v.preset.id })
      await c.waitFor('scene_change_preset')
      expect((await db.query.scenes.findFirst({ where: eq(scenes.id, v.scene.id) }))!.activePresetId).toBe(v.preset.id)
    })

    it('live crew video updates are limited to rentable screens in the booking preset', async () => {
      const v = await venueWithCrew(30 * 60_000)
      const visitor = await joinScene(gs.url, v.scene.id)
      await visitor.waitFor('scene_preset_update') // init
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      expect((await c.waitFor('venue_access')).window).toBe('live')

      for (const sk of [v.sideClone.id, v.screen.id, v.sideScreen.id]) {
        c.room.send('scene_video_update', { sk, url: 'https://evil/x.m3u8', isLive: true })
        expect((await c.waitFor('virvi_error')).code).toBe('forbidden')
      }
      c.room.send('scene_video_update', { sk: crypto.randomUUID(), url: 'https://evil/x.m3u8' })
      expect((await c.waitFor('virvi_error')).code).toBe('not_found')
      await visitor.expectNone('scene_video_status')

      c.room.send('scene_video_update', { sk: v.clone.id, url: 'https://dj/live.m3u8', isLive: true })
      expect((await visitor.waitFor('scene_video_status')).url).toBe('https://dj/live.m3u8')
    })

    it('revoking a grant takes effect on the very next message and notifies the client', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      await c.waitFor('venue_access')
      // warm the 10-second cache
      c.room.send('scene_preset_update', update(v.clone.id, { ...(v.clone.properties as object), liveSrc: 'a' }))
      await c.waitFor('scene_preset_update_ack')
      await revokeGrant(v.grant.id)
      expect((await c.waitFor('access_revoked')).reason).toBe('revoked')
      c.room.send('scene_preset_update', update(v.clone.id, { liveSrc: 'b' }))
      expect((await c.waitFor('virvi_error')).code).toBe('forbidden')
    })

    it('an access lookup in flight during a revoke does not repopulate the cache', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      await c.waitFor('venue_access')
      const room = serverRoom(c.room.roomId)
      room.accessCache.clear() // cold cache

      // Gate the next lookup: it reads pre-revoke access, then stalls until released.
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let lookedUp!: () => void
      const looked = new Promise<void>((r) => (lookedUp = r))
      const original = room.lookupAccess.bind(room)
      let first = true
      room.lookupAccess = async (actor: unknown) => {
        const result = await original(actor)
        if (first) {
          first = false
          lookedUp()
          await gate
        }
        return result
      }

      c.room.send('scene_preset_update', update(v.clone.id, { ...(v.clone.properties as object), liveSrc: 'a' }))
      await looked
      await revokeGrant(v.grant.id)
      expect((await c.waitFor('access_revoked')).reason).toBe('revoked')
      release()
      await c.waitFor('scene_preset_update_ack') // the in-flight call may use its (stale) result once

      c.room.send('scene_preset_update', update(v.clone.id, { liveSrc: 'b' }))
      expect((await c.waitFor('virvi_error')).code).toBe('forbidden')
    })
  })
  it('host_joined is broadcast only when a client with edit access joins as host', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const { Client } = await import('colyseus.js')
    const watcher = await joinScene(gs.url, scene.id)
    const stranger = await createUser()
    const c1 = new Client(gs.url)
    const r1 = await c1.joinOrCreate('virvi_scene', { sceneId: scene.id, sessionToken: tokenFor(stranger), clientType: 'host' })
    await watcher.expectNone('host_joined')
    const c2 = new Client(gs.url)
    const r2 = await c2.joinOrCreate('virvi_scene', { sceneId: scene.id, sessionToken: tokenFor(owner), clientType: 'host' })
    await watcher.waitFor('host_joined')
    r1.leave()
    r2.leave()
  })

  it('a co-host joining as host is treated as a host client', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const wallet = randomWallet()
    const cohost = await createUser({ wallet })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: wallet, role: 'cohost' })
    const { Client } = await import('colyseus.js')
    const watcher = await joinScene(gs.url, scene.id)
    const c = new Client(gs.url)
    const r = await c.joinOrCreate('virvi_scene', { sceneId: scene.id, sessionToken: tokenFor(cohost), clientType: 'host' })
    await watcher.waitFor('host_joined')
    r.leave()
  })
})
