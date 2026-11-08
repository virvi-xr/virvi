import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneElements, sceneElementInstances } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

describe('persistPresetUpdate merges properties', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  const row = async (id: string) => (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!
  const settle = () => new Promise((r) => setTimeout(r, 300))

  async function setup(properties: Record<string, unknown>) {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const el = await createElement(preset.id, { type: 'image', name: 'Pic', properties })
    const c = await joinScene(gs.url, scene.id, tokenFor(owner))
    await c.waitFor('scene_preset_update')
    return { c, el }
  }

  it('toggle keeps properties', async () => {
    const { c, el } = await setup({ textureSrc: 'https://x/a.png' })
    c.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { sk: el.id, enabled: false } })
    await settle()
    const r = await row(el.id)
    expect(r.enabled).toBe(false)
    expect((r.properties as any).textureSrc).toBe('https://x/a.png')
  })

  it('property edit merges and keeps other keys', async () => {
    const { c, el } = await setup({ textureSrc: 'https://x/a.png', keep: 1 })
    c.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { sk: el.id, textureSrc: 'https://x/b.png' } })
    await settle()
    expect((await row(el.id)).properties).toEqual({ textureSrc: 'https://x/b.png', keep: 1 })
  })

  it('unwraps nested properties from dashboard relays', async () => {
    const { c, el } = await setup({ textureSrc: 'https://x/a.png' })
    c.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { id: el.id, properties: { textureSrc: 'https://x/c.png' } } })
    await settle()
    expect((await row(el.id)).properties).toEqual({ textureSrc: 'https://x/c.png' })
  })

  it('a frame sent through the room is stored tidied, and one it could not draw is dropped (LIV-129)', async () => {
    const { c, el } = await setup({ textureSrc: 'https://x/a.png' })
    c.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { sk: el.id, frame: { enabled: true, style: 'classic', color: '#ABCDEF' } } })
    await settle()
    expect((await row(el.id)).properties).toEqual({ textureSrc: 'https://x/a.png', frame: { enabled: true, style: 'classic', color: '#abcdef', thickness: 6 } })
    c.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { sk: el.id, frame: { enabled: true, style: 'ornate' }, textureSrc: 'https://x/b.png' } })
    await settle()
    expect((await row(el.id)).properties).toEqual({ textureSrc: 'https://x/b.png', frame: { enabled: true, style: 'classic', color: '#abcdef', thickness: 6 } })
    c.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { sk: el.id, frame: null } })
    await settle()
    expect((await row(el.id)).properties).toEqual({ textureSrc: 'https://x/b.png', frame: null })
  })

  it('instance update keeps existing properties when only position is sent', async () => {
    const { c, el } = await setup({ textureSrc: 'https://x/a.png' })
    const inst = await createInstance(el.id)
    await db.update(sceneElementInstances).set({ properties: { tint: 'red' } }).where(eq(sceneElementInstances.id, inst.id))
    c.room.send('scene_preset_update', {
      action: 'update', element: 'image', instance: true,
      elementData: { sk: el.id }, instanceData: { sk: inst.id, position: { x: 5, y: 5, z: 5 } },
    })
    await settle()
    const r = (await db.query.sceneElementInstances.findFirst({ where: eq(sceneElementInstances.id, inst.id) }))!
    expect(r.position).toEqual({ x: 5, y: 5, z: 5 })
    expect(r.properties).toEqual({ tint: 'red' })
  })

  it('instance create keeps a parent in the same preset and drops any other (LIV-138)', async () => {
    const { c, el } = await setup({ textureSrc: 'https://x/a.png' })
    const parent = await createInstance(el.id)
    const stranger = await createUser()
    const foreign = await createScene(stranger)
    const foreignInst = await createInstance((await createElement(foreign.preset.id)).id)
    const make = (id: string, p: string) =>
      c.room.send('scene_preset_update', {
        action: 'create', element: 'image', instance: true,
        elementData: { sk: el.id }, instanceData: { sk: id, elementId: el.id, parent: p, position: { x: 1, y: 1, z: 1 } },
      })
    const good = '11111111-1111-4111-8111-111111111111'
    const bad = '22222222-2222-4222-8222-222222222222'
    make(good, parent.id)
    make(bad, foreignInst.id)
    await settle()
    const inst = async (id: string) => (await db.query.sceneElementInstances.findFirst({ where: eq(sceneElementInstances.id, id) }))!
    expect((await inst(good)).parentInstanceId).toBe(parent.id)
    expect((await inst(bad)).parentInstanceId).toBeNull()
  })
})
