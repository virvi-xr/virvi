import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  notifications, studioCreditLedger, studioDesignInvites, studioDesignMembers, studioJobs, studioMessages, studioCredits, studioDesigns, studioEntitlements, studioFinalizeCredits, studioFlags, studioGiftRedemptions, studioIdeaUses,
  studioManaRefunds, studioMistakeReports, studioPauses, studioPayments, studioPromptCredits, studioScopeEvents, studioUsageDays,
} from '../db/schema.js'
import { addCredit, takeCredit } from './credit.js'
import { markInvitesRead } from '../notifications/notifications.js'
import type { Exec } from './quota.js'

/**
 * Moves everything the Design Studio holds for one account onto another, inside the caller's transaction: used when a
 * visitor's wallet joins an existing account. Records move, counters add up onto the target's row, credit moves with a
 * `merge` ledger row on each side (the source's ledger then moves too), and a pause follows the person.
 */
export async function moveStudioData(tx: Exec, fromUserId: string, toUserId: string, now: Date): Promise<void> {
  if (fromUserId === toUserId) return

  // Locks come in the one order every studio path takes them: payment, design, free-finalize credits, mistake report,
  // credit row (a grant, reopen or expiry locks its payment and then its design; a refund its payment and then its
  // report). Within a kind, rows are locked in id order so two merges can't wait on each other either.
  await tx.select({ id: studioPayments.id }).from(studioPayments).where(eq(studioPayments.userId, fromUserId))
    .orderBy(studioPayments.id).for('update')
  await tx.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.ownerId, fromUserId))
    .orderBy(studioDesigns.id).for('update')
  await tx.select({ userId: studioFinalizeCredits.userId }).from(studioFinalizeCredits)
    .where(inArray(studioFinalizeCredits.userId, [fromUserId, toUserId])).orderBy(studioFinalizeCredits.userId).for('update')
  await tx.select({ id: studioMistakeReports.id }).from(studioMistakeReports).where(eq(studioMistakeReports.userId, fromUserId))
    .orderBy(studioMistakeReports.id).for('update')

  // Records
  await tx.update(studioDesigns).set({ ownerId: toUserId }).where(eq(studioDesigns.ownerId, fromUserId))
  await tx.update(studioPayments).set({ userId: toUserId }).where(eq(studioPayments.userId, fromUserId))
  await tx.update(studioEntitlements).set({ userId: toUserId }).where(eq(studioEntitlements.userId, fromUserId))
  await tx.update(studioMistakeReports).set({ userId: toUserId }).where(eq(studioMistakeReports.userId, fromUserId))
  await tx.update(studioScopeEvents).set({ userId: toUserId }).where(eq(studioScopeEvents.userId, fromUserId))
  await tx.update(studioManaRefunds).set({ userId: toUserId }).where(eq(studioManaRefunds.userId, fromUserId))
  await tx.update(studioIdeaUses).set({ userId: toUserId }).where(eq(studioIdeaUses.userId, fromUserId))

  // Collaboration (LIV-159): one open membership per person and design. The target owning the design (theirs, or the
  // source's that just moved) needs none; both on it keep the one row, with the stronger role. Past ones move too.
  await tx.execute(sql`
    update ${studioDesignMembers} m set left_at = ${now.toISOString()}::timestamptz
    from ${studioDesigns} d
    where d.id = m.design_id and d.owner_id = ${toUserId} and m.user_id in (${fromUserId}, ${toUserId}) and m.left_at is null`)
  await tx.execute(sql`
    update ${studioDesignMembers} t set role = 'collaborator'
    from ${studioDesignMembers} f
    where f.design_id = t.design_id and f.user_id = ${fromUserId} and t.user_id = ${toUserId}
      and f.left_at is null and t.left_at is null and f.role = 'collaborator'`)
  await tx.execute(sql`
    update ${studioDesignMembers} f set left_at = ${now.toISOString()}::timestamptz
    from ${studioDesignMembers} t
    where t.design_id = f.design_id and f.user_id = ${fromUserId} and t.user_id = ${toUserId} and f.left_at is null and t.left_at is null`)
  await tx.update(studioDesignMembers).set({ userId: toUserId }).where(eq(studioDesignMembers.userId, fromUserId))
  await tx.update(studioDesignInvites).set({ userId: toUserId }).where(eq(studioDesignInvites.userId, fromUserId))
  await tx.update(studioDesignInvites).set({ invitedBy: toUserId }).where(eq(studioDesignInvites.invitedBy, fromUserId))
  // A moved invite to a design the target owns or is on can only fail: it is cancelled, and its bell item read
  const stale = await tx.update(studioDesignInvites).set({ cancelledAt: now }).where(and(
    eq(studioDesignInvites.userId, toUserId), isNull(studioDesignInvites.acceptedAt), isNull(studioDesignInvites.declinedAt),
    isNull(studioDesignInvites.cancelledAt),
    sql`(EXISTS (SELECT 1 FROM studio_designs WHERE id = ${studioDesignInvites.designId} AND owner_id = ${toUserId})
      OR EXISTS (SELECT 1 FROM studio_design_members WHERE design_id = ${studioDesignInvites.designId} AND user_id = ${toUserId} AND left_at IS NULL))`,
  )).returning({ id: studioDesignInvites.id })
  await markInvitesRead(stale.map((i) => i.id), now, tx)
  // Who sent a prompt or message
  await tx.update(studioJobs).set({ userId: toUserId }).where(eq(studioJobs.userId, fromUserId))
  await tx.update(studioMessages).set({ userId: toUserId }).where(eq(studioMessages.userId, fromUserId))
  // One unread notification per group: where the target has one, the source's is read
  await tx.execute(sql`
    update ${notifications} f set read_at = ${now.toISOString()}::timestamptz
    from ${notifications} t
    where t.user_id = ${toUserId} and f.user_id = ${fromUserId} and t.group_key = f.group_key and t.read_at is null and f.read_at is null`)
  await tx.update(notifications).set({ userId: toUserId }).where(eq(notifications.userId, fromUserId))

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
    insert into ${studioUsageDays} (user_id, day, prompts, cost_usd, prompt_helps)
    select ${toUserId}, day, prompts, cost_usd, prompt_helps from ${studioUsageDays} where user_id = ${fromUserId}
    on conflict (user_id, day) do update set
      prompts = ${studioUsageDays.prompts} + excluded.prompts, cost_usd = ${studioUsageDays.costUsd} + excluded.cost_usd,
      prompt_helps = ${studioUsageDays.promptHelps} + excluded.prompt_helps`)
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

  // Credit last, as a checkout does: both balance rows locked in user-id order, then moved with a ledger row on each side
  const locked = await tx.select({ userId: studioCredits.userId, balanceCents: studioCredits.balanceCents }).from(studioCredits)
    .where(inArray(studioCredits.userId, [fromUserId, toUserId])).orderBy(studioCredits.userId).for('update')
  const src = locked.find((r) => r.userId === fromUserId)
  if (src) {
    const taken = await takeCredit(tx, fromUserId, src.balanceCents, 'merge', toUserId, now)
    await addCredit(tx, toUserId, taken, 'merge', fromUserId, now)
    await tx.delete(studioCredits).where(eq(studioCredits.userId, fromUserId))
  }
  // The source's ledger (its side of this merge included) follows the person, so it adds up on the target and isn't
  // lost when the visitor shell is deleted: a MANA top-up reopened later reads its hold there
  await tx.update(studioCreditLedger).set({ userId: toUserId }).where(eq(studioCreditLedger.userId, fromUserId))
}
