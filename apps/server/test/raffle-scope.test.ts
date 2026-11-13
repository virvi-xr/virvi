import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { sceneCollaborators, sceneRoles } from '../src/db/schema.js'
import { getSceneAccess, hasScope } from '../src/auth/permissions.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, randomWallet, type TestUser } from './helpers/factories.js'

const actor = (u: TestUser) => actorFromClaims({ id: u.id, email: u.email, role: u.role, wallet: u.wallet, verified: true })

describe('raffle.run scope', () => {
  beforeEach(resetDb)

  it('goes to the owner, editors (collab and role) and cohosts, not viewers', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const collabEditor = await createUser()
    const roleEditor = await createUser({ wallet: randomWallet() })
    const cohost = await createUser({ wallet: randomWallet() })
    const viewer = await createUser()
    await db.insert(sceneCollaborators).values([
      { sceneId: scene.id, userId: collabEditor.id, role: 'editor' },
      { sceneId: scene.id, userId: viewer.id, role: 'viewer' },
    ])
    await db.insert(sceneRoles).values([
      { sceneId: scene.id, walletAddress: roleEditor.wallet!, userId: roleEditor.id, role: 'editor', grantedByUserId: owner.id },
      { sceneId: scene.id, walletAddress: cohost.wallet!, userId: cohost.id, role: 'cohost', grantedByUserId: owner.id },
    ])
    const has = async (u: TestUser) => hasScope(await getSceneAccess(actor(u), scene.id), 'raffle.run')
    expect(await has(owner)).toBe(true)
    expect(await has(collabEditor)).toBe(true)
    expect(await has(roleEditor)).toBe(true)
    expect(await has(cohost)).toBe(true)
    expect(await has(viewer)).toBe(false)
  })
})
