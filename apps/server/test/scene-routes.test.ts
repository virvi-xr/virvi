import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { eq } from 'drizzle-orm'
import { sceneCollaborators, sceneElements, sceneElementInstances } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'

describe('scene routes enforce collaborator roles', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function setup() {
    const owner = await createUser()
    const editor = await createUser()
    const viewer = await createUser()
    const stranger = await createUser()
    const { scene, preset } = await createScene(owner)
    const element = await createElement(preset.id)
    const instance = await createInstance(element.id)
    await db.insert(sceneCollaborators).values([
      { sceneId: scene.id, userId: editor.id, role: 'editor' },
      { sceneId: scene.id, userId: viewer.id, role: 'viewer' },
    ])
    return { owner, editor, viewer, stranger, scene, preset, element, instance }
  }

  const as = (u: any) => ({ authorization: `Bearer ${tokenFor(u)}` })

  it('editor can update an element and instance; viewer and stranger cannot', async () => {
    const s = await setup()
    const put = (u: any) =>
      app.inject({ method: 'PUT', url: `/api/elements/${s.element.id}`, headers: as(u), payload: { properties: { liveSrc: 'x' } } })
    expect((await put(s.editor)).statusCode).toBe(200)
    expect((await put(s.viewer)).statusCode).toBe(403)
    expect((await put(s.stranger)).statusCode).toBe(403)
    const putInst = await app.inject({
      method: 'PUT',
      url: `/api/instances/${s.instance.id}`,
      headers: as(s.editor),
      payload: { position: { x: 2, y: 2, z: 2 } },
    })
    expect(putInst.statusCode).toBe(200)
  })

  it('deleting all of an element\'s instances keeps the element and leaves other elements alone', async () => {
    const s = await setup()
    await createInstance(s.element.id)
    await createInstance(s.element.id)
    const other = await createElement(s.preset.id, { name: 'Other' })
    const kept = await createInstance(other.id)
    const res = await app.inject({ method: 'DELETE', url: `/api/elements/${s.element.id}/instances`, headers: as(s.editor) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ deleted: 3 })
    expect(await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.elementId, s.element.id))).toHaveLength(0)
    expect(await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, s.element.id) })).toBeTruthy()
    expect((await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.elementId, other.id))).map((i) => i.id)).toEqual([kept.id])
    // Nothing left to delete is not an error
    const again = await app.inject({ method: 'DELETE', url: `/api/elements/${s.element.id}/instances`, headers: as(s.editor) })
    expect(again.json()).toEqual({ deleted: 0 })
  })

  it('only editors and above can delete all instances; an unknown element is 404', async () => {
    const s = await setup()
    const del = (u: any, id = s.element.id) => app.inject({ method: 'DELETE', url: `/api/elements/${id}/instances`, headers: as(u) })
    expect((await del(s.viewer)).statusCode).toBe(403)
    expect((await del(s.stranger)).statusCode).toBe(403)
    expect(await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.elementId, s.element.id))).toHaveLength(1)
    expect((await del(s.owner, '00000000-0000-0000-0000-000000000000')).statusCode).toBe(404)
    expect((await del(s.owner)).json()).toEqual({ deleted: 1 })
  })

  it('editor can create presets and elements', async () => {
    const s = await setup()
    const res = await app.inject({
      method: 'POST',
      url: `/api/presets/${s.preset.id}/elements`,
      headers: as(s.editor),
      payload: { type: 'image', name: 'Poster' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('editor cannot delete the scene or manage collaborators', async () => {
    const s = await setup()
    expect((await app.inject({ method: 'DELETE', url: `/api/scenes/${s.scene.id}`, headers: as(s.editor) })).statusCode).toBe(403)
    const add = await app.inject({
      method: 'POST',
      url: `/api/scenes/${s.scene.id}/collaborators`,
      headers: as(s.editor),
      payload: { email: s.stranger.email, role: 'viewer' },
    })
    expect(add.statusCode).toBe(403)
  })

  it('viewer can read the scene; stranger cannot', async () => {
    const s = await setup()
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}`, headers: as(s.viewer) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}`, headers: as(s.stranger) })).statusCode).toBe(403)
  })

  it('GET /api/scenes lists owned and collaborated scenes with relationship', async () => {
    const s = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: as(s.editor) })
    expect(res.json().scenes).toEqual([expect.objectContaining({ id: s.scene.id, relationship: 'editor' })])
    const own = await app.inject({ method: 'GET', url: '/api/scenes', headers: as(s.owner) })
    expect(own.json().scenes[0].relationship).toBe('owner')
  })

  it('GET /api/scenes returns nothing for an unverified token', async () => {
    const s = await setup()
    for (const u of [s.owner, s.editor]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/scenes',
        headers: { authorization: `Bearer ${tokenFor(u, { verified: false })}` },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().scenes).toEqual([])
    }
  })

  it('owner keeps full access', async () => {
    const s = await setup()
    expect((await app.inject({ method: 'DELETE', url: `/api/scenes/${s.scene.id}`, headers: as(s.owner) })).statusCode).toBe(204)
  })

  it('renaming a scene trims the name; a viewer cannot; blank or over 120 characters is 400', async () => {
    const s = await setup()
    const put = (u: any, name: unknown) => app.inject({ method: 'PUT', url: `/api/scenes/${s.scene.id}`, headers: as(u), payload: { name } })
    const ok = await put(s.owner, '  Moon base  ')
    expect(ok.statusCode).toBe(200)
    expect(ok.json().scene.name).toBe('Moon base')
    expect((await put(s.editor, 'Moon base 2')).statusCode).toBe(200)
    expect((await put(s.viewer, 'Nope')).statusCode).toBe(403)
    for (const bad of ['   ', '', 'x'.repeat(121), 42, null]) {
      expect((await put(s.owner, bad)).statusCode, JSON.stringify(bad)).toBe(400)
    }
    expect((await put(s.owner, 'x'.repeat(120))).statusCode).toBe(200)
  })
})
