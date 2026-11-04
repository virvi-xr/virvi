import { and, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { accessGrants, mediaAssets, sceneRoles, scenes, userAuthMethods, users } from '../db/schema.js'
import { moveStudioData } from '../studio/merge.js'
import { initialRoleForNewUser } from './roles.js'

const isVerified = (m: { metadata: unknown }) => (m.metadata as { verified?: unknown } | null)?.verified === true

async function findWalletMethod(wallet: string) {
  return db.query.userAuthMethods.findFirst({
    where: and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, wallet.toLowerCase())),
    with: { user: true },
  })
}

/**
 * The user that owns this proven wallet, created on first sight. A player seen in-world (`visitor`) gets a viewer
 * account, tracked for analytics; signing in to the dashboard (`account`) creates a creator or promotes that viewer.
 */
export async function resolveVerifiedWalletUser(wallet: string, displayName: string, as: 'visitor' | 'account') {
  const w = wallet.toLowerCase()
  const existing = await findWalletMethod(w)
  if (existing && isVerified(existing)) {
    if (as === 'visitor' || existing.user.role !== 'viewer') return existing.user
    const [promoted] = await db.update(users).set({ role: 'creator', updatedAt: new Date() }).where(eq(users.id, existing.user.id)).returning()
    return promoted
  }
  const initial = await initialRoleForNewUser()
  const role = as === 'visitor' && initial === 'creator' ? 'viewer' : initial
  const [user] = await db.insert(users).values({ displayName, email: null, role }).returning()
  await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: w, metadata: { verified: true } })
  return user
}

/** A viewer account made for an in-world visitor, never signed in to the dashboard. */
const isVisitorShell = (u: { role: string; email: string | null }) => u.role === 'viewer' && u.email === null

/** Move a visitor account's wallet, grants and roles to `userId`; drop the visitor account if it owns nothing. */
async function absorbVisitor(shellId: string, userId: string, methodId: string) {
  await db.transaction(async (tx) => {
    await tx.update(userAuthMethods).set({ userId }).where(eq(userAuthMethods.id, methodId))
    await tx.update(accessGrants).set({ userId }).where(eq(accessGrants.userId, shellId))
    await tx.update(sceneRoles).set({ userId }).where(eq(sceneRoles.userId, shellId))
    await moveStudioData(tx, shellId, userId, new Date())
    const owns = (await tx.query.scenes.findFirst({ where: eq(scenes.ownerId, shellId), columns: { id: true } }))
      || (await tx.query.mediaAssets.findFirst({ where: eq(mediaAssets.ownerId, shellId), columns: { id: true } }))
    const rest = await tx.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.userId, shellId), columns: { id: true } })
    if (!owns && !rest) await tx.delete(users).where(eq(users.id, shellId))
  })
}

/** Attach a proven wallet to an existing (e.g. email) user. */
export async function linkVerifiedWallet(userId: string, wallet: string): Promise<'linked' | 'already' | 'conflict'> {
  const w = wallet.toLowerCase()
  const existing = await findWalletMethod(w)
  if (existing && existing.userId === userId && isVerified(existing)) return 'already'
  if (existing && isVerified(existing) && existing.userId !== userId) {
    if (!isVisitorShell(existing.user)) return 'conflict'
    await absorbVisitor(existing.userId, userId, existing.id)
    return 'linked'
  }
  await db.insert(userAuthMethods).values({ userId, type: 'wallet', identifier: w, metadata: { verified: true } })
  return 'linked'
}
