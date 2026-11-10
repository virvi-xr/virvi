import { randomBytes } from 'node:crypto'
import { and, asc, count, eq, gt, gte, isNull, ne, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesignInvites, studioDesignMembers, studioDesigns, users } from '../db/schema.js'
import { config } from '../config.js'
import { sendDesignInviteEmail } from '../services/email.js'
import { designRole, memberCount } from './members.js'
import { type Exec } from './quota.js'
import { markDesignInvitesRead, markInvitesRead, notifyInvite } from '../notifications/notifications.js'

/**
 * Inviting people to a design (LIV-159): by email, matched to an account when it is sent, or claimed through its link
 * by whoever signs in holding it. An invite is open until it is accepted, declined or cancelled; past its expiry it
 * can't be accepted, but the owner can resend it (same link, 14 more days). Members plus open, unexpired invites are
 * capped at STUDIO_MAX_MEMBERS per design, and an owner sends at most 50 invites per UTC day.
 */

export type Invite = typeof studioDesignInvites.$inferSelect
export type InviteRole = 'collaborator' | 'viewer'

export const INVITE_ROLES: readonly InviteRole[] = ['collaborator', 'viewer']
export const INVITE_DAYS = 14
export const INVITES_PER_DAY = 50
export const RESENDS_MAX = 3
const RESEND_GAP_MS = 3600_000
const DAY_MS = 24 * 3600_000
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class InviteError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}

/** The email as invites store it (trimmed, lower-cased), or null when it isn't one. */
export function normalEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  return e.length <= 254 && EMAIL.test(e) ? e : null
}

export const inviteLink = (token: string) => `${config.webAppUrl}/studio/invite/${token}`

/** Not accepted, declined or cancelled (it may have expired). */
const unanswered = and(isNull(studioDesignInvites.acceptedAt), isNull(studioDesignInvites.declinedAt), isNull(studioDesignInvites.cancelledAt))
/** Unanswered and not expired: the invites that can still be accepted, and count toward the cap. */
const openAt = (now: Date) => and(unanswered, gt(studioDesignInvites.expiresAt, now))

/** What the owner sees of an invite. */
export const publicInvite = (i: Invite) => ({ id: i.id, email: i.email, role: i.role as InviteRole, expiresAt: i.expiresAt, link: inviteLink(i.token) })

/** Members (the owner left out) plus open invites, leaving out one invite (the one being accepted or revived). */
async function seatsTaken(designId: string, now: Date, exec: Exec, exceptInviteId?: string): Promise<number> {
  const [{ n }] = await exec.select({ n: count() }).from(studioDesignInvites)
    .where(and(eq(studioDesignInvites.designId, designId), openAt(now), exceptInviteId ? ne(studioDesignInvites.id, exceptInviteId) : undefined))
  return (await memberCount(designId, exec)) + n
}

const lockDesign = (exec: Exec, designId: string) =>
  exec.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.id, designId)).for('update')

const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505'

async function nameOf(userId: string): Promise<string> {
  const [u] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId))
  return u?.displayName || 'Someone'
}

/** Mails the invite; a failure is logged, never thrown (the owner can still copy the link). */
async function mailInvite(i: Invite, designName: string) {
  try {
    await sendDesignInviteEmail(i.email, designName, await nameOf(i.invitedBy), inviteLink(i.token))
  } catch (err) {
    console.error('[virvi-studio] invite email failed:', err)
  }
}

/** The owner invites `email` to the design. */
export async function createInvite(
  design: { id: string; name: string; ownerId: string; archivedAt: Date | null }, email: string, role: InviteRole, now: Date,
): Promise<Invite> {
  if (design.archivedAt) throw new InviteError(409, 'archived')
  const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, design.ownerId))
  if (owner?.email && owner.email.trim().toLowerCase() === email) throw new InviteError(400, 'self')
  const [match] = await db.select({ id: users.id }).from(users)
    .where(and(sql`lower(trim(${users.email})) = ${email}`, eq(users.isTrial, false))).orderBy(asc(users.createdAt)).limit(1)
  let invite: Invite
  try {
    invite = await db.transaction(async (tx) => {
      await lockDesign(tx, design.id)
      if (match && await designRole(design.id, match.id, tx)) throw new InviteError(409, 'already_member')
      const [prior] = await tx.select().from(studioDesignInvites)
        .where(and(eq(studioDesignInvites.designId, design.id), eq(studioDesignInvites.email, email), unanswered))
      if (prior && prior.expiresAt > now) throw new InviteError(409, 'already_invited')
      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      const [{ sent }] = await tx.select({ sent: count() }).from(studioDesignInvites)
        .where(and(eq(studioDesignInvites.invitedBy, design.ownerId), gte(studioDesignInvites.createdAt, dayStart)))
      if (sent >= INVITES_PER_DAY) throw new InviteError(429, 'invite_limit')
      if (await seatsTaken(design.id, now, tx) >= config.studioMaxMembers) throw new InviteError(409, 'members_full')
      // An expired, unanswered invite to the same email gives way to the new one
      if (prior) {
        await tx.update(studioDesignInvites).set({ cancelledAt: now }).where(eq(studioDesignInvites.id, prior.id))
        await markInvitesRead([prior.id], now, tx)
      }
      const [row] = await tx.insert(studioDesignInvites).values({
        designId: design.id, email, role, token: randomBytes(32).toString('base64url'), invitedBy: design.ownerId,
        userId: match?.id ?? null, createdAt: now, lastSentAt: now, expiresAt: new Date(now.getTime() + INVITE_DAYS * DAY_MS),
      }).returning()
      return row
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw new InviteError(409, 'already_invited')
    throw err
  }
  if (invite.userId) await notifyInvite(invite)
  await mailInvite(invite, design.name)
  return invite
}

/** One of the design's unanswered invites, or null. */
export async function findDesignInvite(designId: string, inviteId: string): Promise<Invite | null> {
  const [i] = await db.select().from(studioDesignInvites)
    .where(and(eq(studioDesignInvites.id, inviteId), eq(studioDesignInvites.designId, designId), unanswered))
  return i ?? null
}

export async function cancelInvite(i: Invite, now: Date): Promise<void> {
  await db.update(studioDesignInvites).set({ cancelledAt: now }).where(and(eq(studioDesignInvites.id, i.id), unanswered))
  await markInvitesRead([i.id], now)
}

/**
 * The same link, 14 more days from now, mailed again: at most once an hour and 3 times in all. Reviving an expired
 * invite needs a free seat.
 */
export async function resendInvite(i: Invite, designName: string, now: Date): Promise<Invite> {
  const updated = await db.transaction(async (tx) => {
    await lockDesign(tx, i.designId)
    const [cur] = await tx.select().from(studioDesignInvites).where(and(eq(studioDesignInvites.id, i.id), unanswered))
    if (!cur) throw new InviteError(404, 'invite_not_found')
    if (cur.resendCount >= RESENDS_MAX) throw new InviteError(429, 'resend_limit')
    if (cur.lastSentAt && now.getTime() - cur.lastSentAt.getTime() < RESEND_GAP_MS) throw new InviteError(429, 'resend_too_soon')
    if (cur.expiresAt <= now && await seatsTaken(cur.designId, now, tx, cur.id) >= config.studioMaxMembers) throw new InviteError(409, 'members_full')
    const [row] = await tx.update(studioDesignInvites)
      .set({ expiresAt: new Date(now.getTime() + INVITE_DAYS * DAY_MS), resendCount: cur.resendCount + 1, lastSentAt: now })
      .where(eq(studioDesignInvites.id, cur.id)).returning()
    return row
  })
  if (updated.userId) await notifyInvite(updated)
  await mailInvite(updated, designName)
  return updated
}

/** Archiving a design cancels its unanswered invites. */
export async function cancelDesignInvites(designId: string, now: Date, exec: Exec = db): Promise<void> {
  await exec.update(studioDesignInvites).set({ cancelledAt: now }).where(and(eq(studioDesignInvites.designId, designId), unanswered))
  await markDesignInvitesRead(designId, now, exec)
}

/** The open, unexpired invites matched to the user's account, newest first. */
export async function myInvites(userId: string, now: Date) {
  const inviter = sql<string>`(SELECT display_name FROM users WHERE id = ${studioDesignInvites.invitedBy})`
  return db.select({
    id: studioDesignInvites.id, designId: studioDesignInvites.designId, designName: studioDesigns.name,
    inviterName: inviter, role: studioDesignInvites.role, expiresAt: studioDesignInvites.expiresAt,
  }).from(studioDesignInvites).innerJoin(studioDesigns, eq(studioDesigns.id, studioDesignInvites.designId))
    .where(and(eq(studioDesignInvites.userId, userId), openAt(now), isNull(studioDesigns.archivedAt)))
    .orderBy(sql`${studioDesignInvites.createdAt} DESC`)
}

/** An invite matched to the user, still unanswered (it may have expired), or null. */
export async function findMyInvite(userId: string, inviteId: string): Promise<Invite | null> {
  const [i] = await db.select().from(studioDesignInvites)
    .where(and(eq(studioDesignInvites.id, inviteId), eq(studioDesignInvites.userId, userId), unanswered))
  return i ?? null
}

export async function findInviteByToken(token: string): Promise<Invite | null> {
  const [i] = await db.select().from(studioDesignInvites).where(eq(studioDesignInvites.token, token))
  return i ?? null
}

/** What a link's page shows before it is accepted. */
export async function linkView(i: Invite, now: Date) {
  const [d] = await db.select({ name: studioDesigns.name }).from(studioDesigns).where(eq(studioDesigns.id, i.designId))
  const status = i.acceptedAt || i.declinedAt || i.cancelledAt ? 'used' as const : i.expiresAt <= now ? 'expired' as const : 'open' as const
  return { designName: d?.name ?? '', inviterName: await nameOf(i.invitedBy), role: i.role as InviteRole, status }
}

/**
 * The user joins the design through the invite: a new open membership (re-joining after leaving makes a new row), the
 * invite accepted and now theirs.
 */
export async function acceptInvite(i: Invite, userId: string, now: Date): Promise<{ designId: string; role: InviteRole }> {
  return db.transaction(async (tx) => {
    await lockDesign(tx, i.designId)
    const [cur] = await tx.select().from(studioDesignInvites).where(eq(studioDesignInvites.id, i.id))
    if (!cur || cur.acceptedAt || cur.declinedAt || cur.cancelledAt) throw new InviteError(409, 'used')
    if (cur.expiresAt <= now) throw new InviteError(409, 'expired')
    if (await designRole(cur.designId, userId, tx)) throw new InviteError(409, 'already_member')
    if (await seatsTaken(cur.designId, now, tx, cur.id) >= config.studioMaxMembers) throw new InviteError(409, 'members_full')
    await tx.insert(studioDesignMembers).values({ designId: cur.designId, userId, role: cur.role, joinedAt: now })
    await tx.update(studioDesignInvites).set({ acceptedAt: now, userId }).where(eq(studioDesignInvites.id, cur.id))
    await markInvitesRead([cur.id], now, tx)
    return { designId: cur.designId, role: cur.role as InviteRole }
  })
}

export async function declineInvite(i: Invite, now: Date): Promise<void> {
  await db.update(studioDesignInvites).set({ declinedAt: now }).where(and(eq(studioDesignInvites.id, i.id), unanswered))
  await markInvitesRead([i.id], now)
}

/** The owner's view of the design's unanswered invites (expired ones too, so they can be resent), oldest first. */
export async function designInvites(designId: string): Promise<ReturnType<typeof publicInvite>[]> {
  const rows = await db.select().from(studioDesignInvites)
    .where(and(eq(studioDesignInvites.designId, designId), unanswered)).orderBy(asc(studioDesignInvites.createdAt), asc(studioDesignInvites.id))
  return rows.map(publicInvite)
}

/** Sets a member's role; false when they aren't an open member. */
export async function setMemberRole(designId: string, userId: string, role: InviteRole): Promise<boolean> {
  const rows = await db.update(studioDesignMembers).set({ role })
    .where(and(eq(studioDesignMembers.designId, designId), eq(studioDesignMembers.userId, userId), isNull(studioDesignMembers.leftAt))).returning({ id: studioDesignMembers.id })
  return rows.length > 0
}

/** Ends a member's open membership; false when there was none. */
export async function endMembership(designId: string, userId: string, now: Date): Promise<boolean> {
  const rows = await db.update(studioDesignMembers).set({ leftAt: now })
    .where(and(eq(studioDesignMembers.designId, designId), eq(studioDesignMembers.userId, userId), isNull(studioDesignMembers.leftAt))).returning({ id: studioDesignMembers.id })
  return rows.length > 0
}
