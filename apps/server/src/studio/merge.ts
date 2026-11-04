import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  studioCredits, studioDesigns, studioEntitlements, studioFinalizeCredits, studioFlags, studioGiftRedemptions,
  studioManaRefunds, studioMistakeReports, studioPauses, studioPayments, studioPromptCredits, studioScopeEvents, studioUsageDays,
} from '../db/schema.js'
import { addCredit, takeCredit } from './credit.js'
import type { Exec } from './quota.js'

/**
 * Moves everything the Design Studio holds for one account onto another, inside the caller's transaction: used when a
 * visitor's wallet joins an existing account. Records move, counters add up onto the target's row, credit moves with a
 * `merge` ledger row on each side, and a pause follows the person.
 */
export async function moveStudioData(tx: Exec, fromUserId: string, toUserId: string, now: Date): Promise<void> {
  if (fromUserId === toUserId) return

  // Credit first. The source's balance row is locked (by takeCredit), then the target's (by addCredit's upsert); the
  // order is always source then target, and a checkout only ever locks one row, so no pair of transactions can deadlock.
  const [src] = await tx.select({ balanceCents: studioCredits.balanceCents }).from(studioCredits)
    .where(eq(studioCredits.userId, fromUserId)).for('update')
  if (src) {
    const taken = await takeCredit(tx, fromUserId, src.balanceCents, 'merge', toUserId, now)
    await addCredit(tx, toUserId, taken, 'merge', fromUserId, now)
    await tx.delete(studioCredits).where(eq(studioCredits.userId, fromUserId))
  }

  // Records
  await tx.update(studioDesigns).set({ ownerId: toUserId }).where(eq(studioDesigns.ownerId, fromUserId))
  await tx.update(studioPayments).set({ userId: toUserId }).where(eq(studioPayments.userId, fromUserId))
  await tx.update(studioEntitlements).set({ userId: toUserId }).where(eq(studioEntitlements.userId, fromUserId))
  await tx.update(studioMistakeReports).set({ userId: toUserId }).where(eq(studioMistakeReports.userId, fromUserId))
  await tx.update(studioScopeEvents).set({ userId: toUserId }).where(eq(studioScopeEvents.userId, fromUserId))
  await tx.update(studioManaRefunds).set({ userId: toUserId }).where(eq(studioManaRefunds.userId, fromUserId))

  // At most one flag is open per account: if the target already has one, the source's is dismissed instead of moved
  const [targetOpen] = await tx.select({ id: studioFlags.id }).from(studioFlags)
    .where(and(eq(studioFlags.userId, toUserId), eq(studioFlags.status, 'open'))).limit(1)
  if (targetOpen) {
    await tx.update(studioFlags).set({ status: 'dismissed', closedAt: now })
      .where(and(eq(studioFlags.userId, fromUserId), eq(studioFlags.status, 'open')))
  }
  await tx.update(studioFlags).set({ userId: toUserId }).where(eq(studioFlags.userId, fromUserId))

  // A paused account stays paused
  const [paused] = await tx.select().from(studioPauses).where(eq(studioPauses.userId, fromUserId))
  if (paused) {
    await tx.insert(studioPauses).values({ userId: toUserId, pausedAt: paused.pausedAt, pausedBy: paused.pausedBy }).onConflictDoNothing()
    await tx.delete(studioPauses).where(eq(studioPauses.userId, fromUserId))
  }

  // Counters, summed
  await tx.execute(sql`
    insert into ${studioUsageDays} (user_id, day, prompts, cost_usd)
    select ${toUserId}, day, prompts, cost_usd from ${studioUsageDays} where user_id = ${fromUserId}
    on conflict (user_id, day) do update set
      prompts = ${studioUsageDays.prompts} + excluded.prompts, cost_usd = ${studioUsageDays.costUsd} + excluded.cost_usd`)
  await tx.delete(studioUsageDays).where(eq(studioUsageDays.userId, fromUserId))

  await tx.execute(sql`
    insert into ${studioPromptCredits} (user_id, balance, gifted, updated_at)
    select ${toUserId}, balance, gifted, ${now.toISOString()}::timestamptz from ${studioPromptCredits} where user_id = ${fromUserId}
    on conflict (user_id) do update set
      balance = ${studioPromptCredits.balance} + excluded.balance, gifted = ${studioPromptCredits.gifted} + excluded.gifted,
      updated_at = excluded.updated_at`)
  await tx.delete(studioPromptCredits).where(eq(studioPromptCredits.userId, fromUserId))

  await tx.execute(sql`
    insert into ${studioFinalizeCredits} (user_id, balance, updated_at)
    select ${toUserId}, balance, ${now.toISOString()}::timestamptz from ${studioFinalizeCredits} where user_id = ${fromUserId}
    on conflict (user_id) do update set balance = ${studioFinalizeCredits.balance} + excluded.balance, updated_at = excluded.updated_at`)
  await tx.delete(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, fromUserId))

  // A code the target already redeemed stays redeemed once; the source's second redemption goes
  const has = await tx.select({ codeId: studioGiftRedemptions.codeId }).from(studioGiftRedemptions).where(eq(studioGiftRedemptions.userId, toUserId))
  if (has.length) {
    await tx.delete(studioGiftRedemptions).where(and(eq(studioGiftRedemptions.userId, fromUserId),
      inArray(studioGiftRedemptions.codeId, has.map((r) => r.codeId))))
  }
  await tx.update(studioGiftRedemptions).set({ userId: toUserId }).where(eq(studioGiftRedemptions.userId, fromUserId))
}
