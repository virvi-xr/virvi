import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneCollaborators, sceneRoles } from '../src/db/schema.js'
import { getSceneAccess, isFullAccess, isHostAccess, hasScope } from '../src/auth/permissions.js'
import { linkWalletGrants } from '../src/auth/permissions.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, randomWallet } from './helpers/factories.js'

const actorOf = (u: { id: string; role: string; wallet: string | null }) => actorFromClaims({ id: u.id, role: u.role, wallet: u.wallet, verified: true } as any)

describe('getSceneAccess with scene roles', () => {
  beforeEach(resetDb)

  it('host / cohost / editor / viewer / none', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(host)
    const [co, ed, vi, none] = await Promise.all([1, 2, 3, 4].map(() => createUser({ wallet: randomWallet() })))
    await db.insert(sceneRoles).values([
      { sceneId: scene.id, walletAddress: co.wallet!, role: 'cohost' },
      { sceneId: scene.id, walletAddress: ed.wallet!, role: 'editor' },
      { sceneId: scene.id, walletAddress: vi.wallet!, role: 'viewer' },
    ])
    const h = await getSceneAccess(actorOf(host), scene.id)
    expect(isHostAccess(h)).toBe(true)
    const c = await getSceneAccess(actorOf(co), scene.id)
    expect(c.level).toBe('cohost')
    expect(isFullAccess(c)).toBe(true)
    expect(isHostAccess(c)).toBe(false)
    expect(hasScope(c, 'roles.manage')).toBe(true)
    const e = await getSceneAccess(actorOf(ed), scene.id)
    expect(e.level).toBe('editor')
    expect(hasScope(e, 'scene.edit')).toBe(true)
    expect(hasScope(e, 'analytics.view')).toBe(true)
    expect(hasScope(e, 'roles.manage')).toBe(false)
    const v = await getSceneAccess(actorOf(vi), scene.id)
    expect(v.level).toBe('viewer')
    expect([...v.scopes]).toEqual(['analytics.view'])
    expect((await getSceneAccess(actorOf(none), scene.id)).level).toBe('none')
  })

  it('a person with both a collaborator invite and a wallet role gets the stronger one', async () => {
    const host = await createUser()
    const { scene } = await createScene(host)
    const u = await createUser({ wallet: randomWallet() })
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: u.id, role: 'editor' })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: u.wallet!, userId: u.id, role: 'cohost' })
    expect((await getSceneAccess(actorOf(u), scene.id)).level).toBe('cohost')
    const v = await createUser({ wallet: randomWallet() })
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: v.id, role: 'viewer' })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: v.wallet!, userId: v.id, role: 'editor' })
    expect((await getSceneAccess(actorOf(v), scene.id)).level).toBe('editor')
  })

  it('a revoked role grants nothing', async () => {
    const host = await createUser()
    const { scene } = await createScene(host)
    const u = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: u.wallet!, role: 'cohost', revokedAt: new Date() })
    expect((await getSceneAccess(actorOf(u), scene.id)).level).toBe('none')
  })

  it('a role assigned to a wallet before it used Virvi attaches on first wallet sign-in', async () => {
    const host = await createUser()
    const { scene } = await createScene(host)
    const wallet = randomWallet()
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: wallet, role: 'editor' })
    const newcomer = await createUser({ wallet })
    await linkWalletGrants(newcomer.id, wallet)
    const row = await db.query.sceneRoles.findFirst({ where: eq(sceneRoles.walletAddress, wallet) })
    expect(row!.userId).toBe(newcomer.id)
    // access by user id alone (e.g. an email session after linking)
    const access = await getSceneAccess(actorFromClaims({ id: newcomer.id, role: 'creator', verified: true } as any), scene.id)
    expect(access.level).toBe('editor')
  })

  it('linkWalletGrants does not attach a revoked role, which stays inert after linking', async () => {
    const host = await createUser()
    const { scene } = await createScene(host)
    const wallet = randomWallet()
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: wallet, role: 'cohost', revokedAt: new Date() })
    const newcomer = await createUser({ wallet })
    await linkWalletGrants(newcomer.id, wallet)
    const row = await db.query.sceneRoles.findFirst({ where: eq(sceneRoles.walletAddress, wallet) })
    expect(row!.userId).toBeNull()
    expect((await getSceneAccess(actorOf(newcomer), scene.id)).level).toBe('none')
    expect((await getSceneAccess(actorFromClaims({ id: newcomer.id, role: 'creator', verified: true } as any), scene.id)).level).toBe('none')
  })
})
