import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { checkEditArea, insideEditArea, outsideAreaMessage } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { sceneElementInstances, sceneElements, sceneRoles } from '../src/db/schema.js'
import { getSceneAccess, hasScope } from '../src/auth/permissions.js'
import { sceneRoleFor } from '../src/auth/scene-roles.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, tokenFor, randomWallet, type TestUser } from './helpers/factories.js'

/** LIV-32: an editor limited to an area of the scene (a tenant). */
const AREA = { minX: 0, maxX: 16, minZ: 0, maxZ: 16 }
const IN = { x: 8, y: 0, z: 8 }
const OUT = { x: 40, y: 0, z: 8 }
const actorOf = (u: TestUser) => actorFromClaims({ id: u.id, role: u.role, wallet: u.wallet, verified: true } as any)

describe('edit areas (shared)', () => {
  it('checks and rounds an area, and tells inside from outside', () => {
    expect(checkEditArea({ minX: 0, maxX: 16.004, minZ: -8, maxZ: 8 })).toEqual({ ok: true, value: { minX: 0, maxX: 16, minZ: -8, maxZ: 8 } })
    expect(checkEditArea({ minX: 5, maxX: 5, minZ: 0, maxZ: 1 })).toEqual({ ok: false, error: 'Each minimum must be smaller than its maximum.' })
    expect(checkEditArea({ minX: 0, maxX: 'a', minZ: 0, maxZ: 1 }).ok).toBe(false)
    expect(checkEditArea({ minX: 0, maxX: 1e9, minZ: 0, maxZ: 1 }).ok).toBe(false)
    expect(insideEditArea(AREA, IN)).toBe(true)
    expect(insideEditArea(AREA, { x: 16, z: 0 })).toBe(true) // edges count
    expect(insideEditArea(AREA, OUT)).toBe(false)
    expect(insideEditArea(AREA, null)).toBe(false)
    expect(outsideAreaMessage([AREA])).toBe('You can only edit inside your area: x 0 to 16, z 0 to 16.')
  })
})

describe('tenants (LIV-32)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let tenant: TestUser
  let sceneId: string
  let presetId: string
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    tenant = await createUser({ wallet: randomWallet() })
    const { scene, preset } = await createScene(host)
    sceneId = scene.id
    presetId = preset.id
    await db.insert(sceneRoles).values({ sceneId, walletAddress: tenant.wallet!, userId: tenant.id, role: 'editor', area: AREA })
  })
  afterEach(() => app.close())

  const call = (u: TestUser, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: { authorization: `Bearer ${tokenFor(u)}` }, payload: payload as any })
  const copy = async (elementId: string, position: unknown, parentInstanceId: string | null = null) =>
    (await db.insert(sceneElementInstances).values({ elementId, position: position as any, parentInstanceId }).returning())[0]

  it('is its own access level with no scopes; code that predates areas sees a viewer', async () => {
    const a = await getSceneAccess(actorOf(tenant), sceneId)
    expect(a.level).toBe('tenant')
    expect(a.areas).toEqual([AREA])
    expect(hasScope(a, 'scene.edit')).toBe(false)
    expect(hasScope(a, 'analytics.view')).toBe(false)
    expect(await sceneRoleFor(sceneId, actorOf(tenant))).toBe('viewer')
    // The scene page says where they can edit; others get null
    expect((await call(tenant, 'GET', `/api/scenes/${sceneId}`)).json().scene.editAreas).toEqual([AREA])
    expect((await call(host, 'GET', `/api/scenes/${sceneId}`)).json().scene.editAreas).toBeNull()
  })

  it('adds plain media and places, moves and removes copies inside the area only', async () => {
    const made = await call(tenant, 'POST', `/api/presets/${presetId}/elements`, { type: 'model', name: 'Stall', properties: { modelSrc: 'https://x/a.glb' } })
    expect(made.statusCode, made.body).toBe(201)
    const id = made.json().element.id
    const widget = await call(tenant, 'POST', `/api/presets/${presetId}/elements`, { type: 'ad_space', name: 'Ad', properties: {} })
    expect(widget.statusCode).toBe(403)
    expect(widget.json().error).toBe('tenant_type')

    const outside = await call(tenant, 'POST', `/api/elements/${id}/instances`, { position: OUT })
    expect(outside.statusCode).toBe(403)
    expect(outside.json()).toEqual({ error: 'outside_area', message: 'You can only edit inside your area: x 0 to 16, z 0 to 16.' })
    expect((await call(tenant, 'POST', `/api/elements/${id}/instances`, {})).statusCode).toBe(403) // no position: not known to be inside
    const placed = await call(tenant, 'POST', `/api/elements/${id}/instances`, { position: IN })
    expect(placed.statusCode).toBe(201)
    const instanceId = placed.json().instance.id

    expect((await call(tenant, 'PUT', `/api/instances/${instanceId}`, { position: { x: 15, y: 2, z: 1 } })).statusCode).toBe(200)
    expect((await call(tenant, 'PUT', `/api/instances/${instanceId}`, { position: OUT })).statusCode).toBe(403)
    expect((await call(tenant, 'PUT', `/api/instances/${instanceId}`, { rotation: { x: 0, y: 90, z: 0 } })).statusCode).toBe(200)
    // The item itself: every copy is inside, so it can be changed; its kind can't
    expect((await call(tenant, 'PUT', `/api/elements/${id}`, { name: 'My stall' })).statusCode).toBe(200)
    expect((await call(tenant, 'PUT', `/api/elements/${id}`, { type: 'video' })).statusCode).toBe(403)
    expect((await call(tenant, 'DELETE', `/api/instances/${instanceId}`)).statusCode).toBe(204)
  })

  it("can't touch the host's items outside the area, or any item with a copy outside it", async () => {
    const shared = await createElement(presetId, { type: 'image', name: 'Banner' })
    const inside = await copy(shared.id, IN)
    const away = await copy(shared.id, OUT)
    expect((await call(tenant, 'PUT', `/api/instances/${away.id}`, { position: IN })).statusCode).toBe(403) // can't pull one in
    expect((await call(tenant, 'DELETE', `/api/instances/${away.id}`)).statusCode).toBe(403)
    expect((await call(tenant, 'PUT', `/api/instances/${inside.id}`, { position: { x: 1, y: 0, z: 1 } })).statusCode).toBe(200)
    // One copy outside: the item, its copies as a whole and deleting it stay with the host
    expect((await call(tenant, 'PUT', `/api/elements/${shared.id}`, { name: 'Mine now' })).json().error).toBe('outside_area')
    expect((await call(tenant, 'DELETE', `/api/elements/${shared.id}/instances`)).statusCode).toBe(403)
    expect((await call(tenant, 'DELETE', `/api/elements/${shared.id}`)).statusCode).toBe(403)
    expect(await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, shared.id) })).toBeTruthy()
    // An item with no copies is nobody's in particular: refused
    const bare = await createElement(presetId, { type: 'image', name: 'Unplaced' })
    expect((await call(tenant, 'PUT', `/api/elements/${bare.id}`, { name: 'x' })).statusCode).toBe(403)
    // A child copy's position is relative to its parent, so tenants can't parent or edit parented copies
    const child = await copy(shared.id, IN, inside.id)
    expect((await call(tenant, 'PUT', `/api/instances/${child.id}`, { rotation: { x: 0, y: 0, z: 0 } })).statusCode).toBe(403)
    expect((await call(tenant, 'PUT', `/api/instances/${inside.id}`, { parentInstanceId: away.id })).statusCode).toBe(403)
    const own = await createElement(presetId, { type: 'image', name: 'Own' })
    expect((await call(tenant, 'POST', `/api/elements/${own.id}/instances`, { position: IN, parentInstanceId: inside.id })).statusCode).toBe(403)
  })

  it('every other edit stays with the host: presets, settings, roles', async () => {
    expect((await call(tenant, 'PUT', `/api/scenes/${sceneId}`, { name: 'Renamed' })).statusCode).toBe(403)
    expect((await call(tenant, 'POST', `/api/scenes/${sceneId}/presets`, { name: 'Night' })).statusCode).toBe(403)
    expect((await call(tenant, 'POST', `/api/scenes/${sceneId}/roles`, { wallet: randomWallet(), role: 'editor' })).statusCode).toBe(403)
  })

  it('the host sets, keeps and clears an area through the roles API', async () => {
    const roles = async () => (await call(host, 'GET', `/api/scenes/${sceneId}/roles`)).json().roles.find((r: any) => r.wallet === tenant.wallet)
    expect((await roles()).area).toEqual(AREA)
    // Bad areas and areas on other roles are refused
    expect((await call(host, 'POST', `/api/scenes/${sceneId}/roles`, { wallet: tenant.wallet, role: 'editor', area: { minX: 4, maxX: 1, minZ: 0, maxZ: 1 } })).json().error).toBe('bad_area')
    expect((await call(host, 'POST', `/api/scenes/${sceneId}/roles`, { wallet: tenant.wallet, role: 'viewer', area: AREA })).json().error).toBe('area_editor_only')
    // Left out (as the HUDs send it), the area stays
    expect((await call(host, 'POST', `/api/scenes/${sceneId}/roles`, { wallet: tenant.wallet, role: 'editor' })).json().role.area).toEqual(AREA)
    const moved = { minX: 16, maxX: 32, minZ: 0, maxZ: 16 }
    expect((await call(host, 'POST', `/api/scenes/${sceneId}/roles`, { wallet: tenant.wallet, role: 'editor', area: moved })).json().role.area).toEqual(moved)
    // null: an editor everywhere
    expect((await call(host, 'POST', `/api/scenes/${sceneId}/roles`, { wallet: tenant.wallet, role: 'editor', area: null })).json().role.area).toBeNull()
    expect((await getSceneAccess(actorOf(tenant), sceneId)).level).toBe('editor')
    // Another role drops the area
    await call(host, 'POST', `/api/scenes/${sceneId}/roles`, { wallet: tenant.wallet, role: 'editor', area: AREA })
    expect((await call(host, 'POST', `/api/scenes/${sceneId}/roles`, { wallet: tenant.wallet, role: 'cohost' })).json().role.area).toBeNull()
  })

  it('an unlimited editor role through another wallet or an account invite wins over an area', async () => {
    const second = randomWallet()
    await db.insert(sceneRoles).values({ sceneId, walletAddress: second, userId: tenant.id, role: 'editor' })
    expect((await getSceneAccess(actorOf(tenant), sceneId)).level).toBe('editor')
  })

  it('a stored area that no longer checks out limits the tenant to nothing', async () => {
    await db.update(sceneRoles).set({ area: { minX: 'x' } as any }).where(eq(sceneRoles.walletAddress, tenant.wallet!))
    const a = await getSceneAccess(actorOf(tenant), sceneId)
    expect(a.level).toBe('tenant')
    expect(a.areas).toEqual([])
    const el = await createElement(presetId, { type: 'image', name: 'Any' })
    expect((await call(tenant, 'POST', `/api/elements/${el.id}/instances`, { position: IN })).statusCode).toBe(403)
  })
})
