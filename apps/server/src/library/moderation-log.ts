import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { moderationActions, users } from '../db/schema.js'
import { config } from '../config.js'
import { sendEmail } from '../services/email.js'
import { notifyTakedown } from '../notifications/notifications.js'

/** The moderation log and owner emails (LIV-34), apart from appeals so sharing.ts can use them without a cycle. */

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
export const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ')

export async function logModeration(entry: { targetType: string; targetId: string; action: string; reason?: string | null; actorId?: string | null; ownerId?: string | null }, exec: Pick<typeof db, 'insert'> = db) {
  await exec.insert(moderationActions).values({ ...entry, reason: entry.reason ?? null, actorId: entry.actorId ?? null, ownerId: entry.ownerId ?? null })
}

/** Best effort and not waited for: production may have no SMTP. Only to a confirmed address. */
export async function emailOwner(ownerId: string | null, subject: string, html: string) {
  if (!ownerId) return
  const owner = await db.query.users.findFirst({ where: eq(users.id, ownerId), columns: { email: true, emailVerifiedAt: true } })
  if (!owner?.email || !owner.emailVerifiedAt) return
  void sendEmail(owner.email, subject, html).catch((err) => console.error('[moderation] owner email failed:', err instanceof Error ? err.message : err))
}

export const modelsLink = () => `${config.publicUrl}/assets/`

/** Tells the owner their model was taken down, why, and how to appeal. */
export async function noticeTakedown(asset: { id: string; name: string; uploadedBy: string | null }, reason: string) {
  await notifyTakedown(asset.uploadedBy, asset, reason)
  await emailOwner(asset.uploadedBy, `Virvi took down your model ${oneLine(asset.name)}`, `
    <p>Virvi took down your 3D model <b>${escapeHtml(asset.name)}</b>, so other people can no longer find or add it.</p>
    <p>Why: ${escapeHtml(reason)}</p>
    <p>It stays in your library, and in scenes that already use it. If you think this is a mistake, open it on your
    <a href="${modelsLink()}">3D Models page</a> and choose <b>Appeal</b> to tell us why.</p>`)
}

