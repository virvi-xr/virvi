import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { studioDesignInvites, studioDesignMembers, studioDesigns, studioPayments } from '../db/schema.js'
import { notify } from '../notifications/notifications.js'
import type { Exec } from './quota.js'

/**
 * An owner's account is being deleted (LIV-159): each design they share passes to its longest-standing collaborator,
 * else its longest-standing viewer, instead of going with them. The heir's membership closes (they are the owner now),
 * the old owner's invites on it become the heir's to manage, and the heir hears of it. A design with no open members
 * is left for the user delete's cascade, as before. Runs inside the delete's transaction, before the delete; returns
 * how many designs were handed over.
 */
export async function handOverDesigns(tx: Exec, userId: string, now: Date): Promise<number> {
  // Locks in the order every studio path takes them: payment, then design (the delete then nulls the payments' user)
  await tx.select({ id: studioPayments.id }).from(studioPayments).where(eq(studioPayments.userId, userId))
    .orderBy(studioPayments.id).for('update')
  const designs = await tx.select({ id: studioDesigns.id, name: studioDesigns.name }).from(studioDesigns)
    .where(eq(studioDesigns.ownerId, userId)).orderBy(studioDesigns.id).for('update')
  let handed = 0
  for (const d of designs) {
    const [heir] = await tx.select({ id: studioDesignMembers.id, userId: studioDesignMembers.userId }).from(studioDesignMembers)
      .where(and(eq(studioDesignMembers.designId, d.id), isNull(studioDesignMembers.leftAt)))
      .orderBy(sql`(${studioDesignMembers.role} = 'collaborator') DESC`, asc(studioDesignMembers.joinedAt), asc(studioDesignMembers.id))
      .limit(1)
    if (!heir) continue
    await tx.update(studioDesignMembers).set({ leftAt: now }).where(eq(studioDesignMembers.id, heir.id))
    await tx.update(studioDesigns).set({ ownerId: heir.userId }).where(eq(studioDesigns.id, d.id))
    // invited_by cascades on the user delete: moved, the open ones stay valid
    await tx.update(studioDesignInvites).set({ invitedBy: heir.userId })
      .where(and(eq(studioDesignInvites.designId, d.id), eq(studioDesignInvites.invitedBy, userId)))
    // In a savepoint, so a failed notification never fails the account deletion
    await tx.transaction((sp) => notify(heir.userId, 'studio_owner', { designId: d.id, designName: d.name }, {}, sp))
      .catch((err) => console.error('[notifications] owner failed:', err instanceof Error ? err.message : err))
    handed++
  }
  return handed
}
