import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { CREDIT_MAX, shareLicense } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assetLibraryItems, assetReports, roomSets, sceneLibrary, scenes, users } from '../db/schema.js'
import { config } from '../config.js'
import { sendEmail } from '../services/email.js'
import { withoutUploadCode } from './model-uploads.js'

/**
 * Sharing 3D models with other Virvi users (LIV-20). The owner shares a model under a license from SHARE_LICENSES, having
 * confirmed they have the rights; it then shows in the Asset Library's Community view and anyone can add it to a scene.
 *
 * Unsharing (or deleting) never breaks a scene that already has it: scene-library links stay, and a deleted model that
 * another account's scene uses is kept, private and ownerless, the way account deletion keeps public models. Creative
 * Commons licenses can't be withdrawn from copies people already have, and this matches that.
 */

type Asset = typeof assetLibraryItems.$inferSelect

export class ShareError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

/** What someone can report a shared model for. */
export const REPORT_REASONS = ['copyright', 'offensive', 'private_info', 'broken', 'spam', 'other'] as const
export const REPORT_DETAILS_MAX = 1000
export const TAKEDOWN_REASON_MAX = 500

/** Made from a room scan: category `room`, or backed by a room set. A room set is the layout of someone's home. */
export async function isRoomAsset(asset: { id: string; category: string | null }): Promise<boolean> {
  if (asset.category === 'room') return true
  const [set] = await db.select({ id: roomSets.id }).from(roomSets).where(eq(roomSets.assetItemId, asset.id)).limit(1)
  return !!set
}

/** A model as someone sees it: who uploaded it stays private unless it's theirs (`mine`). */
export function forViewer(asset: Asset, callerId: string | null) {
  const { uploadedBy, ...rest } = withoutUploadCode(asset)
  const mine = !!callerId && uploadedBy === callerId
  return mine ? { ...rest, uploadedBy, mine } : { ...rest, mine }
}

async function ownModel(assetId: string, userId: string): Promise<Asset> {
  const asset = await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, assetId) })
  if (!asset) throw new ShareError(404, 'not_found', 'Model not found')
  if (asset.uploadedBy !== userId || asset.packId) throw new ShareError(403, 'forbidden', 'Only the person who added a model can share it')
  return asset
}

/** Share the owner's model (or change the license or credit it's shared with). */
export async function shareModel(
  assetId: string,
  user: { id: string; displayName: string | null },
  body: { license?: unknown; rightsConfirmed?: unknown; credit?: unknown },
): Promise<Asset> {
  const asset = await ownModel(assetId, user.id)
  if (asset.takenDownAt) throw new ShareError(409, 'taken_down', 'Virvi took this model down, so it can’t be shared again. Contact support@virvi.io if you think that’s a mistake.')
  if (asset.status !== 'ready') throw new ShareError(409, 'not_ready', 'This model is still uploading')
  if (await isRoomAsset(asset)) throw new ShareError(400, 'room_assets_private', 'Models made from a room scan stay private')
  if (body.rightsConfirmed !== true) throw new ShareError(400, 'rights_not_confirmed', 'Confirm you made this model or have the right to share it')
  const license = typeof body.license === 'string' ? shareLicense(body.license) : null
  if (!license) throw new ShareError(400, 'unknown_license', 'Pick one of the licenses offered')
  if (body.credit !== undefined && body.credit !== null && typeof body.credit !== 'string') throw new ShareError(400, 'bad_credit', 'credit must be text')
  const credit = (typeof body.credit === 'string' ? body.credit.trim() : '') || asset.author?.trim() || user.displayName?.trim() || null
  if (credit && credit.length > CREDIT_MAX) throw new ShareError(400, 'bad_credit', `Keep the credit to ${CREDIT_MAX} characters`)
  const [updated] = await db
    .update(assetLibraryItems)
    .set({ isPublic: true, license: license.id, author: credit, sharedAt: new Date() })
    .where(eq(assetLibraryItems.id, assetId))
    .returning()
  return updated
}

/** Make the owner's model private again. Scenes that already have it keep it. */
export async function unshareModel(assetId: string, userId: string): Promise<Asset> {
  await ownModel(assetId, userId)
  const [updated] = await db.update(assetLibraryItems).set({ isPublic: false }).where(eq(assetLibraryItems.id, assetId)).returning()
  return updated
}

/** A scene that isn't the owner's has this model in its library. */
export async function usedByOthers(assetId: string, ownerId: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: sceneLibrary.id })
    .from(sceneLibrary)
    .innerJoin(scenes, eq(scenes.id, sceneLibrary.sceneId))
    .where(and(eq(sceneLibrary.assetItemId, assetId), ne(scenes.ownerId, ownerId)))
    .limit(1)
  return !!hit
}

/** The owner deletes a model other scenes use: it leaves their library and stays, private and ownerless, for those scenes. */
export async function releaseToUsers(assetId: string): Promise<void> {
  await db.update(assetLibraryItems).set({ isPublic: false, uploadedBy: null }).where(eq(assetLibraryItems.id, assetId))
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Report a shared model. `created` is false when this person already has an open report on it. */
export async function reportModel(assetId: string, reporterId: string, reason: unknown, details: unknown): Promise<{ created: boolean }> {
  if (typeof reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(reason)) {
    throw new ShareError(400, 'bad_reason', `reason must be one of ${REPORT_REASONS.join(', ')}`)
  }
  if (details !== undefined && details !== null && (typeof details !== 'string' || details.length > REPORT_DETAILS_MAX)) {
    throw new ShareError(400, 'bad_details', `Keep the details to ${REPORT_DETAILS_MAX} characters`)
  }
  const asset = await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, assetId) })
  // Only what's shared can be reported: a private model is no one else's to see
  if (!asset || !asset.isPublic || asset.packId) throw new ShareError(404, 'not_found', 'Model not found')
  const text = typeof details === 'string' && details.trim() ? details.trim() : null
  const [row] = await db.insert(assetReports).values({ assetItemId: assetId, reporterId, reason, details: text }).onConflictDoNothing().returning()
  if (!row) return { created: false }
  // Best effort, not waited for: the admin page is where reports are read
  if (config.arReportsEmail) {
    void sendEmail(
      config.arReportsEmail,
      `Virvi model report: ${reason} — ${asset.name.replace(/[\r\n]+/g, ' ')}`,
      `<h2>Someone reported a shared 3D model</h2>
      <p>Model: <b>${escapeHtml(asset.name)}</b><br>Model id: ${asset.id}<br>Reason: ${reason}<br>Time: ${row.createdAt.toISOString()}</p>
      ${text ? `<p>${escapeHtml(text)}</p>` : ''}
      <p><a href="${config.publicUrl}/admin">Open the admin page</a></p>`,
    ).catch((err) => console.error('[asset-reports] report email failed:', err instanceof Error ? err.message : err))
  }
  return { created: true }
}

/** Open reports, newest first, with the model they're about. */
export async function listOpenReports() {
  const rows = await db
    .select({
      r: assetReports,
      asset: { id: assetLibraryItems.id, name: assetLibraryItems.name, thumbnailUrl: assetLibraryItems.thumbnailUrl, author: assetLibraryItems.author, license: assetLibraryItems.license },
      owner: { id: users.id, displayName: users.displayName, email: users.email },
    })
    .from(assetReports)
    .innerJoin(assetLibraryItems, eq(assetLibraryItems.id, assetReports.assetItemId))
    .leftJoin(users, eq(users.id, assetLibraryItems.uploadedBy))
    .where(eq(assetReports.status, 'open'))
    .orderBy(desc(assetReports.createdAt))
    .limit(200)
  return rows.map(({ r, asset, owner }) => ({
    id: r.id, reason: r.reason, details: r.details, createdAt: r.createdAt.toISOString(), asset, owner: owner?.id ? owner : null,
  }))
}

/** Virvi takes a model down: it stops being public, its open reports close, and its owner can't share it again. */
export async function takeDownModel(assetId: string, reason: unknown): Promise<void> {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > TAKEDOWN_REASON_MAX) {
    throw new ShareError(400, 'bad_reason', `Say why, in at most ${TAKEDOWN_REASON_MAX} characters`)
  }
  const now = new Date()
  const [hit] = await db
    .update(assetLibraryItems)
    .set({ isPublic: false, takenDownAt: now, takedownReason: reason.trim() })
    .where(and(eq(assetLibraryItems.id, assetId), sql`${assetLibraryItems.packId} IS NULL`))
    .returning({ id: assetLibraryItems.id })
  if (!hit) throw new ShareError(404, 'not_found', 'Model not found')
  await db.update(assetReports).set({ status: 'taken_down', resolvedAt: now }).where(and(eq(assetReports.assetItemId, assetId), eq(assetReports.status, 'open')))
}

/** Close a report, leaving the model as it is. */
export async function dismissReport(reportId: string): Promise<void> {
  const [hit] = await db
    .update(assetReports)
    .set({ status: 'dismissed', resolvedAt: new Date() })
    .where(and(eq(assetReports.id, reportId), eq(assetReports.status, 'open')))
    .returning({ id: assetReports.id })
  if (!hit) throw new ShareError(404, 'not_found', 'Report not found')
}
