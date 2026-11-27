import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, moderationActions, moderationAppeals, users } from '../db/schema.js'
import { config } from '../config.js'
import { sendEmail } from '../services/email.js'
import { ShareError } from './sharing.js'
import { emailOwner, escapeHtml, logModeration, modelsLink, oneLine } from './moderation-log.js'
import { notifyAppealDecided } from '../notifications/notifications.js'
export { logModeration, noticeTakedown } from './moderation-log.js'

/**
 * Moderation (LIV-34): the log of every admin decision, telling an owner when their model is taken down and why, and
 * their appeal. A restored model can be shared again; it isn't shared again by itself.
 */

export const APPEAL_MAX = 2000
export const RESPONSE_MAX = 1000

export async function appealTakedown(assetId: string, userId: string, message: unknown) {
  if (typeof message !== 'string' || !message.trim() || message.length > APPEAL_MAX) {
    throw new ShareError(400, 'bad_message', `Say why it should come back, in at most ${APPEAL_MAX} characters`)
  }
  const asset = await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, assetId), columns: { id: true, name: true, uploadedBy: true, takenDownAt: true } })
  if (!asset || asset.uploadedBy !== userId) throw new ShareError(404, 'not_found', 'Model not found')
  if (!asset.takenDownAt) throw new ShareError(409, 'not_taken_down', "This model wasn't taken down")
  const [appeal] = await db.insert(moderationAppeals).values({ assetItemId: assetId, userId, message: message.trim() }).onConflictDoNothing().returning()
  if (!appeal) throw new ShareError(409, 'appeal_open', "You've already appealed. We'll email you when we've looked at it.")
  if (config.arReportsEmail) {
    void sendEmail(config.arReportsEmail, `Virvi takedown appeal — ${oneLine(asset.name)}`, `
      <h2>An owner appealed a takedown</h2>
      <p>Model: <b>${escapeHtml(asset.name)}</b><br>Model id: ${asset.id}</p>
      <p>${escapeHtml(appeal.message)}</p>
      <p><a href="${config.publicUrl}/admin">Open the admin page</a></p>`).catch((err) => console.error('[moderation] appeal email failed:', err instanceof Error ? err.message : err))
  }
  return appeal
}

/** The owner's open (or last) appeal of a model, for its page. */
export async function appealOf(assetId: string, userId: string) {
  const asset = await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, assetId), columns: { uploadedBy: true } })
  if (!asset || asset.uploadedBy !== userId) throw new ShareError(404, 'not_found', 'Model not found')
  const [row] = await db.select().from(moderationAppeals).where(and(eq(moderationAppeals.assetItemId, assetId), eq(moderationAppeals.userId, userId))).orderBy(desc(moderationAppeals.createdAt)).limit(1)
  return row ?? null
}

/** Restore (the model can be shared again) or reject an open appeal, telling the owner either way. */
export async function decideAppeal(appealId: string, decision: 'restored' | 'rejected', response: unknown, adminId: string) {
  if (response !== undefined && response !== null && (typeof response !== 'string' || response.length > RESPONSE_MAX)) {
    throw new ShareError(400, 'bad_response', `Keep the reply to ${RESPONSE_MAX} characters`)
  }
  const text = typeof response === 'string' && response.trim() ? response.trim() : null
  if (decision === 'rejected' && !text) throw new ShareError(400, 'bad_response', 'Say why the takedown stands')
  const now = new Date()
  const result = await db.transaction(async (tx) => {
    const [appeal] = await tx.update(moderationAppeals).set({ status: decision, response: text, resolvedAt: now })
      .where(and(eq(moderationAppeals.id, appealId), eq(moderationAppeals.status, 'open'))).returning()
    if (!appeal) return null
    const [asset] = decision === 'restored'
      ? await tx.update(assetLibraryItems).set({ takenDownAt: null, takedownReason: null }).where(eq(assetLibraryItems.id, appeal.assetItemId)).returning({ id: assetLibraryItems.id, name: assetLibraryItems.name, uploadedBy: assetLibraryItems.uploadedBy })
      : await tx.select({ id: assetLibraryItems.id, name: assetLibraryItems.name, uploadedBy: assetLibraryItems.uploadedBy }).from(assetLibraryItems).where(eq(assetLibraryItems.id, appeal.assetItemId))
    await logModeration({ targetType: 'asset', targetId: appeal.assetItemId, action: decision === 'restored' ? 'restored' : 'appeal_rejected', reason: text, actorId: adminId, ownerId: appeal.userId }, tx)
    return { appeal, asset }
  })
  if (!result) throw new ShareError(404, 'not_found', 'Appeal not found, or already decided')
  const name = result.asset?.name ?? 'your model'
  await notifyAppealDecided(result.appeal.userId, { id: result.appeal.assetItemId, name }, decision, text)
  await emailOwner(result.appeal.userId, decision === 'restored' ? `Your model ${oneLine(name)} is back` : `About your appeal for ${oneLine(name)}`,
    decision === 'restored'
      ? `<p>We looked again at <b>${escapeHtml(name)}</b> and lifted the takedown. You can share it again from your <a href="${modelsLink()}">3D Models page</a>.</p>${text ? `<p>${escapeHtml(text)}</p>` : ''}`
      : `<p>We looked again at <b>${escapeHtml(name)}</b>, and the takedown stays.</p><p>${escapeHtml(text!)}</p><p>Reply to support@virvi.io if you have more to add.</p>`)
  return result.appeal
}

/** Open appeals (oldest first, the queue) and the last 100 decisions, for the admin page. */
export async function moderationOverview() {
  const appeals = await db
    .select({ a: moderationAppeals, asset: { id: assetLibraryItems.id, name: assetLibraryItems.name, thumbnailUrl: assetLibraryItems.thumbnailUrl, takedownReason: assetLibraryItems.takedownReason }, owner: { id: users.id, displayName: users.displayName } })
    .from(moderationAppeals)
    .innerJoin(assetLibraryItems, eq(assetLibraryItems.id, moderationAppeals.assetItemId))
    .leftJoin(users, eq(users.id, moderationAppeals.userId))
    .where(eq(moderationAppeals.status, 'open'))
    .orderBy(moderationAppeals.createdAt)
    .limit(200)
  const log = await db.select().from(moderationActions).orderBy(desc(moderationActions.createdAt)).limit(100)
  const ids = [...new Set(log.flatMap((l) => [l.actorId, l.ownerId]).filter((x): x is string => !!x))]
  const names = new Map(ids.length ? (await db.query.users.findMany({ where: (u, { inArray }) => inArray(u.id, ids), columns: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]) : [])
  return {
    appeals: appeals.map(({ a, asset, owner }) => ({ id: a.id, message: a.message, createdAt: a.createdAt.toISOString(), asset, owner: owner?.id ? owner : null })),
    log: log.map((l) => ({
      id: l.id, targetType: l.targetType, targetId: l.targetId, action: l.action, reason: l.reason, createdAt: l.createdAt.toISOString(),
      actor: l.actorId ? names.get(l.actorId) ?? null : null, owner: l.ownerId ? names.get(l.ownerId) ?? null : null,
    })),
  }
}
