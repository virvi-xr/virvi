import { eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioCreditLedger, studioCredits, users } from '../db/schema.js'
import type { Exec } from './quota.js'

/** Why a credit balance changed; one ledger row per change. */
export type LedgerReason = 'hold' | 'release' | 'spend' | 'refund' | 'merge' | 'mana_refund_request' | 'mana_refund_declined'

/** A user's USD credit in cents (0 when they have none). */
export async function creditBalance(userId: string, exec: Exec = db): Promise<number> {
  const [row] = await exec.select({ balanceCents: studioCredits.balanceCents }).from(studioCredits).where(eq(studioCredits.userId, userId))
  return row?.balanceCents ?? 0
}

/**
 * Adds credit and records it in the ledger. Does nothing when `cents` is zero or less, or the account is gone: null (a
 * payment's user was deleted), or an id with no user left (an entitlement's or report's user_id has no FK, LIV-159). The
 * user row is held (KEY SHARE) so the account can't go before the credit lands.
 */
export async function addCredit(
  tx: Exec, userId: string | null, cents: number, reason: LedgerReason, refId: string | null, now: Date,
): Promise<void> {
  if (!(cents > 0) || !userId) return // no payer account left (studio_payments.user_id is null): nobody to credit
  const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('key share')
  if (!u) return
  await tx.insert(studioCredits).values({ userId, balanceCents: cents, updatedAt: now })
    .onConflictDoUpdate({ target: studioCredits.userId, set: { balanceCents: sql`${studioCredits.balanceCents} + ${cents}`, updatedAt: now } })
  await tx.insert(studioCreditLedger).values({ userId, deltaCents: cents, reason, refId, createdAt: now })
}

/**
 * Takes up to `upTo` cents of a user's credit, never more than the balance, and records it in the ledger.
 * Locks the balance row, so two takes in separate transactions run one after the other. Returns what was taken.
 */
export async function takeCredit(
  tx: Exec, userId: string, upTo: number, reason: LedgerReason, refId: string | null, now: Date,
): Promise<number> {
  if (!(upTo > 0)) return 0
  const [row] = await tx.select({ balanceCents: studioCredits.balanceCents }).from(studioCredits)
    .where(eq(studioCredits.userId, userId)).for('update')
  const taken = Math.min(row?.balanceCents ?? 0, upTo)
  if (taken <= 0) return 0
  await tx.update(studioCredits).set({ balanceCents: sql`${studioCredits.balanceCents} - ${taken}`, updatedAt: now })
    .where(eq(studioCredits.userId, userId))
  await tx.insert(studioCreditLedger).values({ userId, deltaCents: -taken, reason, refId, createdAt: now })
  return taken
}
