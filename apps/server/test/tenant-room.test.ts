import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneElementInstances, sceneElements, sceneRoles } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

/** LIV-32: a tenant edits inside their area from the in-world HUD (the scene room), and nowhere else. */
const AREA = { minX: 0, maxX: 16, minZ: 0, maxZ: 16 }
const IN = { x: 8, y: 0, z: 8 }
const OUT = { x: 40, y: 0, z: 8 }

describe('tenants in the scene room (LIV-32)', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => { await resetDb(); gs = await startGameServer() })
  afterEach(() => gs.stop())

  async function setup() {
    const host = await createUser()
    const tenant = await createUser({ wallet: randomWallet() })
    const { scene, preset } = await createScene(host)
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: tenant.wallet!, userId: tenant.id, role: 'editor', area: AREA })
    const stall = await createElement(preset.id, { type: 'image', name: 'Stall sign' })
    const [inside] = await db.insert(sceneElementInstances).values({ elementId: stall.id, position: IN }).returning()
    const banner = await createElement(preset.id, { type: 'image', name: 'Host banner' })
    const [away] = await db.insert(sceneElementInstances).values({ elementId: banner.id, position: OUT }).returning()
    const t = await joinScene(gs.url, scene.id, tokenFor(tenant))
    await t.waitFor('scene_preset_update') // init
    return { scene, preset, stall, inside, banner, away, t }
  }
  const instanceRow = async (id: string) => db.query.sceneElementInstances.findFirst({ where: eq(sceneElementInstances.id, id) })
  const settle = async (c: any, n: number) => {
    for (let i = 0; i < 150 && c.inbox.filter((m: any) => m.type === 'virvi_error' || m.type === 'scene_preset_update_ack').length < n; i++) await new Promise((r) => setTimeout(r, 20))
  }

  it('moves and removes copies inside the area, and is told outside_area elsewhere', async () => {
    const s = await setup()
    s.t.room.send('scene_preset_update', { action: 'update', instance: true, element: 'image', instanceData: { sk: s.inside.id, position: { x: 12, y: 1, z: 3 } } })
    for (let i = 0; i < 150 && (await instanceRow(s.inside.id))!.position?.x !== 12; i++) await new Promise((r) => setTimeout(r, 20))
    expect((await instanceRow(s.inside.id))!.position).toEqual({ x: 12, y: 1, z: 3 })

    // Out of the area: refused, nothing saved
    s.t.room.send('scene_preset_update', { action: 'update', instance: true, element: 'image', instanceData: { sk: s.inside.id, position: OUT } })
    expect((await s.t.waitFor('virvi_error')).code).toBe('outside_area')
    expect((await instanceRow(s.inside.id))!.position).toEqual({ x: 12, y: 1, z: 3 })
    // The host's copy outside the area: can't move, drag or delete it
    s.t.room.send('scene_preset_update', { action: 'update', instance: true, element: 'image', instanceData: { sk: s.away.id, position: IN } })
    expect((await s.t.waitFor('virvi_error')).code).toBe('outside_area')
    s.t.room.send('transform_draft', { sk: s.away.id, position: IN })
    expect((await s.t.waitFor('virvi_error')).code).toBe('outside_area')
    s.t.room.send('scene_preset_update', { action: 'delete', instance: true, element: 'image', instanceData: { sk: s.away.id } })
    expect((await s.t.waitFor('virvi_error')).code).toBe('outside_area')
    expect(await instanceRow(s.away.id)).toBeTruthy()

    s.t.room.send('scene_preset_update', { action: 'delete', instance: true, element: 'image', instanceData: { sk: s.inside.id } })
    for (let i = 0; i < 150 && (await instanceRow(s.inside.id)); i++) await new Promise((r) => setTimeout(r, 20))
    expect(await instanceRow(s.inside.id)).toBeUndefined()
  })

  it('places copies only inside the area; items with a copy outside, and everything else, stay with the host', async () => {
    const s = await setup()
    s.t.room.send('scene_preset_update', { action: 'create', instance: true, element: 'image', instanceData: { elementId: s.stall.id, position: OUT } })
    expect((await s.t.waitFor('virvi_error')).code).toBe('outside_area')
    s.t.room.send('scene_preset_update', { action: 'create', instance: true, element: 'image', instanceData: { elementId: s.stall.id, position: { x: 2, y: 0, z: 2 } } })
    for (let i = 0; i < 150; i++) {
      if ((await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.elementId, s.stall.id))).length === 2) break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.elementId, s.stall.id))).toHaveLength(2)

    // The host's banner has its copy outside: no renaming it
    s.t.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { sk: s.banner.id, name: 'Mine' } })
    expect((await s.t.waitFor('virvi_error')).code).toBe('outside_area')
    expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, s.banner.id) }))!.name).toBe('Host banner')
    // Presets and settings are the host's
    s.t.room.send('scene_change_preset', { presetId: s.preset.id })
    s.t.room.send('scene_setting_update', { x: 1 })
    await settle(s.t, 2)
    expect(s.t.inbox.filter((m: any) => m.type === 'virvi_error').map((m: any) => m.message.code)).toEqual(['forbidden', 'forbidden'])
  })
})
