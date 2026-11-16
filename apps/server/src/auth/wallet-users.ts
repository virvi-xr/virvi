import { and, eq, notInArray, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { accessGrants, assetLibraryItems, beatClaims, mediaAssets, raffleEntries, sceneRoles, scenes, userAuthMethods, users, type LinkedBy } from '../db/schema.js'
import { moveStudioData } from '../studio/merge.js'
import { UNLINKED_CLAIM } from '../beats/retention.js'
import { claimWalletInvites } from '../studio/invites.js'
import { initialRoleForNewUser } from './roles.js'
import { WalletBlockedError, walletSignInBlocked } from './wallet-blocks.js'

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
 * Either way, design invites waiting on the wallet become theirs.
 */
export async function resolveVerifiedWalletUser(wallet: string, displayName: string, as: 'visitor' | 'account') {
  const w = wallet.toLowerCase()
  // A wallet still on the account that blocked it (LIV-11 reissue) never signs in to it, whichever path asks (signed
  // fetch, setup, ...); once off it, it signs up as a new account (it still can't earn BEATs)
  if (await walletSignInBlocked(w)) throw new WalletBlockedError()
  const existing = await findWalletMethod(w)
  if (existing && isVerified(existing)) {
    // updated_at marks the wallet the account last signed in with (the wall of fame names that one)
    await db.update(userAuthMethods).set({ updatedAt: new Date() }).where(eq(userAuthMethods.id, existing.id))
    await claimWalletInvites(existing.user.id, w)
    if (as === 'visitor' || existing.user.role !== 'viewer') return existing.user
    const [promoted] = await db.update(users).set({ role: 'creator', updatedAt: new Date() }).where(eq(users.id, existing.user.id)).returning()
    return promoted
  }
  const initial = await initialRoleForNewUser()
  const role = as === 'visitor' && initial === 'creator' ? 'viewer' : initial
  const [user] = await db.insert(users).values({ displayName, email: null, role }).returning()
  await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: w, metadata: { verified: true }, linkedBy: { method: 'wallet', how: 'sign_up', wallet: w } })
  await claimWalletInvites(user.id, w)
  return user
}

/** A viewer account made for an in-world visitor, never signed in to the dashboard. */
const isVisitorShell = (u: { role: string; email: string | null }) => u.role === 'viewer' && u.email === null

/** Move a visitor account's wallet, grants, roles, BEAT claims and raffle entries to `userId`; drop the visitor account if it owns nothing. */
async function absorbVisitor(shellId: string, userId: string, methodId: string, linkedBy: LinkedBy) {
  await db.transaction(async (tx) => {
    // Linked to this account now, by this session (reissue provenance)
    await tx.update(userAuthMethods).set({ userId, linkedAt: new Date(), linkedBy: { ...linkedBy, how: 'visitor' } }).where(eq(userAuthMethods.id, methodId))
    await tx.update(accessGrants).set({ userId }).where(eq(accessGrants.userId, shellId))
    await tx.update(sceneRoles).set({ userId }).where(eq(sceneRoles.userId, shellId))
    await moveStudioData(tx, shellId, userId, new Date())
    // BEAT claims follow the account, except on a BEAT it already claimed (one claim per user and BEAT). The visitor's
    // claim there is forgotten as delete-my-data would (privacy I3): deleted unless it is minting (flagged; the job
    // settles it) or minted (unlinked: only the wallet stays, as on chain). Else it would be left with no user to delete it
    const conflict = sql`${beatClaims.userId} = ${shellId}::uuid and exists (select 1 from beat_claims o where o.beat_id = ${beatClaims.beatId} and o.user_id = ${userId}::uuid)`
    await tx.update(beatClaims).set(UNLINKED_CLAIM).where(and(conflict, eq(beatClaims.status, 'minted')))
    await tx.update(beatClaims).set({ deleteRequested: true }).where(and(conflict, eq(beatClaims.status, 'minting')))
    await tx.delete(beatClaims).where(and(conflict, notInArray(beatClaims.status, ['minted', 'minting'])))
    await tx.execute(sql`update beat_claims c set user_id = ${userId}::uuid where c.user_id = ${shellId}::uuid
      and not exists (select 1 from beat_claims o where o.beat_id = c.beat_id and o.user_id = ${userId}::uuid)`)
    // Raffle entries too (else the visitor's deletion would cascade them away). Where both entered the same raffle (one
    // entry per user), the account's own entry stays and the visitor's goes, unless only the visitor's won a draw: then
    // the winning one is kept, so the draw's winner stays a live entry
    const won = (e: string) => sql.raw(`exists (select 1 from raffle_draws d where d.raffle_id = ${e}.raffle_id and ${e}.id = any(d.winner_entry_ids))`)
    await tx.execute(sql`delete from raffle_entries a where a.user_id = ${userId}::uuid and not ${won('a')}
      and exists (select 1 from raffle_entries v where v.raffle_id = a.raffle_id and v.user_id = ${shellId}::uuid and ${won('v')})`)
    await tx.execute(sql`update raffle_entries e set user_id = ${userId}::uuid where e.user_id = ${shellId}::uuid
      and not exists (select 1 from raffle_entries o where o.raffle_id = e.raffle_id and o.user_id = ${userId}::uuid)`)
    await tx.delete(raffleEntries).where(eq(raffleEntries.userId, shellId))
    const owns = (await tx.query.scenes.findFirst({ where: eq(scenes.ownerId, shellId), columns: { id: true } }))
      || (await tx.query.mediaAssets.findFirst({ where: eq(mediaAssets.ownerId, shellId), columns: { id: true } }))
      || (await tx.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.uploadedBy, shellId), columns: { id: true } }))
    const rest = await tx.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.userId, shellId), columns: { id: true } })
    if (!owns && !rest) await tx.delete(users).where(eq(users.id, shellId))
  })
}

/**
 * Attach a proven wallet to an existing (e.g. email) user; design invites waiting on it become theirs. `linkedBy` is the
 * linking session's sign-in (reissue provenance, LIV-11), recorded with the time.
 */
export async function linkVerifiedWallet(userId: string, wallet: string, linkedBy: LinkedBy = { method: 'unknown', how: 'link' }): Promise<'linked' | 'already' | 'conflict'> {
  const w = wallet.toLowerCase()
  const existing = await findWalletMethod(w)
  if (existing && existing.userId === userId && isVerified(existing)) return 'already'
  if (existing && isVerified(existing) && existing.userId !== userId) {
    if (!isVisitorShell(existing.user)) return 'conflict'
    await absorbVisitor(existing.userId, userId, existing.id, linkedBy)
    await claimWalletInvites(userId, w)
    return 'linked'
  }
  await db.insert(userAuthMethods).values({ userId, type: 'wallet', identifier: w, metadata: { verified: true }, linkedAt: new Date(), linkedBy: { ...linkedBy, how: 'link' } })
  await claimWalletInvites(userId, w)
  return 'linked'
}
