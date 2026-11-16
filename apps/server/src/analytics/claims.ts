import { and, asc, eq, lt, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { userAuthMethods, walletChallenges } from '../db/schema.js'
import { getDclDirectory, type DclDirectory } from './dcl-directory.js'
import type { AnalyticsSceneRow } from './registry.js'

/**
 * The account's verified wallets, oldest link first. A blocked wallet (LIV-11 reissue: a compromised wallet from its
 * approval on, or one an admin unlinked) is left out at once, so no pass, host check or MANA refund uses it.
 */
export async function verifiedWalletsOf(userId: string): Promise<string[]> {
  const rows = await db.query.userAuthMethods.findMany({
    where: and(
      eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'wallet'), sql`${userAuthMethods.metadata}->>'verified' = 'true'`,
      sql`not exists (select 1 from wallet_blocks b where b.wallet = ${userAuthMethods.identifier})`,
    ),
    orderBy: [asc(userAuthMethods.createdAt), asc(userAuthMethods.id)],
  })
  return rows.map((r) => r.identifier).filter((id) => /^0x[0-9a-f]{40}$/.test(id))
}

/** Does this wallet control the scene's location? Throws DirectoryUnavailableError if Decentraland can't answer. */
export async function controls(scene: AnalyticsSceneRow, wallet: string, dir: DclDirectory = getDclDirectory()): Promise<boolean> {
  const w = wallet.toLowerCase()
  if (scene.kind === 'preview') return scene.locationKey.startsWith(`preview:${w}:`)
  if (scene.kind === 'world') {
    if ((await dir.getWorldOwner(scene.worldName!)) === w) return true
    return (await dir.getWorldDeployers(scene.worldName!)).includes(w)
  }
  const parcels = scene.parcels.length ? scene.parcels : scene.baseParcel ? [scene.baseParcel] : []
  if (!parcels.length) return false
  let viaRights = true
  for (const p of parcels) {
    const r = await dir.getParcelRights(p)
    const ok = !!r && [r.owner, r.operator, r.updateOperator, ...r.updateManagers, ...r.approvedForAll].includes(w)
    if (!ok) {
      viaRights = false
      break
    }
  }
  if (viaRights) return true
  for (const p of parcels) if ((await dir.getActiveDeployer(p)) !== w) return false
  return true
}

/** Delete expired wallet sign-in challenges. */
export async function purgeWalletChallenges(now = new Date()): Promise<number> {
  const rows = await db.delete(walletChallenges).where(lt(walletChallenges.expiresAt, now)).returning({ nonce: walletChallenges.nonce })
  return rows.length
}
