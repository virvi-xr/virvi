import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { giveawayClaims, giveaways } from '../db/schema.js'

/**
 * Giveaways and account deletion (LIV-194). A giveaway's row holds its wallet's sealed key, so it must never cascade
 * away with its owner: that would strand the host's POL and Virvi's float for good. And a visitor's unfinished
 * check-ins go with them.
 */

type Exec = Pick<typeof db, 'select' | 'delete'>

/** For the routes that delete a user: null when they own no giveaway that isn't deleted yet, else the 409 body. */
export async function giveawaysBlockingDelete(userId: string, exec: Pick<typeof db, 'select'> = db): Promise<{ error: string; message: string } | null> {
  const [owned] = await exec.select({ id: giveaways.id }).from(giveaways)
    .where(and(eq(giveaways.ownerId, userId), isNull(giveaways.deletedAt))).limit(1)
  if (!owned) return null
  return { error: 'giveaways_first', message: 'Delete your giveaways in Drops first (send back your POL there), then delete your account.' }
}

/**
 * A visitor's own giveaway data, in the deletion's transaction: `present` check-ins go (with no account they can never
 * be claimed or stopped, and would hold the wallet's one claim). Queued claims stay so they still mint; they and settled
 * ones lose the account link when the user row goes (ON DELETE SET NULL).
 */
export async function deleteMyGiveawayData(userId: string, exec: Exec = db): Promise<{ deleted: number }> {
  const gone = await exec.delete(giveawayClaims).where(and(eq(giveawayClaims.userId, userId), eq(giveawayClaims.status, 'present')))
    .returning({ id: giveawayClaims.id })
  return { deleted: gone.length }
}
