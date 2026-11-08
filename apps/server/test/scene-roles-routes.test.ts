import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneCollaborators, sceneRoles, scenes } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, randomWallet } from './helpers/factories.js'

describe('scene roles API', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } })

  it('host adds, lists, changes and removes roles', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(host)
    const w = randomWallet()
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(host), { wallet: w.toUpperCase().replace('0X', '0x'), role: 'editor' })).statusCode).toBe(201)
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(host), { wallet: w, role: 'cohost' })).statusCode).toBe(201)
    const list = (await call('GET', `/api/scenes/${scene.id}/roles`, tokenFor(host))).json()
    expect(list.host.wallets).toEqual([host.wallet])
    expect(list.roles).toMatchObject([{ wallet: w, role: 'cohost' }])
    expect((await call('DELETE', `/api/scenes/${scene.id}/roles/${w}`, tokenFor(host))).statusCode).toBe(204)
    expect((await call('GET', `/api/scenes/${scene.id}/roles`, tokenFor(host))).json().roles).toEqual([])
  })

  it('rejects bad input and the host wallet as a role target', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(host)
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(host), { wallet: 'nope', role: 'editor' })).statusCode).toBe(400)
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(host), { wallet: 123, role: 'editor' })).statusCode).toBe(400)
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(host), { wallet: randomWallet(), role: 'host' })).statusCode).toBe(400)
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(host), { wallet: host.wallet, role: 'viewer' })).statusCode).toBe(409)
  })

  it('a co-host manages roles but cannot remove the host or transfer host', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(host)
    const co = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: co.wallet!, userId: co.id, role: 'cohost' })
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(co), { wallet: randomWallet(), role: 'viewer' })).statusCode).toBe(201)
    expect((await call('DELETE', `/api/scenes/${scene.id}/roles/${host.wallet}`, tokenFor(co))).statusCode).toBe(403)
    expect((await call('POST', `/api/scenes/${scene.id}/transfer-host`, tokenFor(co), { wallet: co.wallet })).statusCode).toBe(403)
    expect((await db.query.scenes.findFirst({ where: eq(scenes.id, scene.id) }))!.ownerId).toBe(host.id)
  })

  it('editors and strangers cannot manage roles', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(host)
    const ed = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: ed.wallet!, userId: ed.id, role: 'editor' })
    const stranger = await createUser({ wallet: randomWallet() })
    for (const u of [ed, stranger]) {
      expect((await call('GET', `/api/scenes/${scene.id}/roles`, tokenFor(u))).statusCode).toBe(403)
      expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(u), { wallet: randomWallet(), role: 'viewer' })).statusCode).toBe(403)
    }
  })

  it('host transfers to a signed-in co-host; previous host becomes co-host', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(host)
    const co = await createUser({ wallet: randomWallet() })
    const pending = randomWallet()
    await db.insert(sceneRoles).values([
      { sceneId: scene.id, walletAddress: co.wallet!, userId: co.id, role: 'cohost' },
      { sceneId: scene.id, walletAddress: pending, role: 'cohost' },
    ])
    expect((await call('POST', `/api/scenes/${scene.id}/transfer-host`, tokenFor(host), { wallet: pending })).json()).toEqual({ error: 'not_a_signed_in_cohost' })
    const res = await call('POST', `/api/scenes/${scene.id}/transfer-host`, tokenFor(host), { wallet: co.wallet })
    expect(res.statusCode).toBe(200)
    expect((await db.query.scenes.findFirst({ where: eq(scenes.id, scene.id) }))!.ownerId).toBe(co.id)
    const rows = await db.select().from(sceneRoles).where(and(eq(sceneRoles.sceneId, scene.id), isNull(sceneRoles.revokedAt)))
    expect(rows.find((r) => r.walletAddress === co.wallet)).toBeUndefined()
    expect(rows.find((r) => r.walletAddress === host.wallet)).toMatchObject({ role: 'cohost', userId: host.id })
  })

  it('rejects transfer when the host has no verified wallet', async () => {
    const host = await createUser()
    const { scene } = await createScene(host)
    const co = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: co.wallet!, userId: co.id, role: 'cohost' })
    const res = await call('POST', `/api/scenes/${scene.id}/transfer-host`, tokenFor(host), { wallet: co.wallet })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'host_has_no_wallet' })
    expect((await db.query.scenes.findFirst({ where: eq(scenes.id, scene.id) }))!.ownerId).toBe(host.id)
  })
  it('a co-host cannot delete the scene; the host can', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(host)
    const co = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: co.wallet!, userId: co.id, role: 'cohost' })
    expect((await call('DELETE', `/api/scenes/${scene.id}`, tokenFor(co))).statusCode).toBe(403)
    expect(await db.query.scenes.findFirst({ where: eq(scenes.id, scene.id) })).toBeDefined()
    expect((await call('DELETE', `/api/scenes/${scene.id}`, tokenFor(host))).statusCode).toBe(200)
    // LIV-83: deleted, restorable
    expect((await db.query.scenes.findFirst({ where: eq(scenes.id, scene.id) }))?.deletedAt).toBeTruthy()
  })

  it('collaborator emails are shown only to full-access roles', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(host)
    const collab = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: collab.id, role: 'viewer' })
    for (const role of ['viewer', 'editor'] as const) {
      const u = await createUser({ wallet: randomWallet() })
      await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: u.wallet!, userId: u.id, role })
      const res = await call('GET', `/api/scenes/${scene.id}/collaborators`, tokenFor(u))
      expect(res.statusCode).toBe(200)
      const list = res.json().collaborators
      expect(list).toHaveLength(2)
      for (const c of list) expect(c).not.toHaveProperty('email')
    }
    const co = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: co.wallet!, userId: co.id, role: 'cohost' })
    for (const u of [host, co]) {
      const list = (await call('GET', `/api/scenes/${scene.id}/collaborators`, tokenFor(u))).json().collaborators
      expect(list.map((c: any) => c.email).sort()).toEqual([host.email, collab.email].sort())
    }
  })
})
