import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { notifications, studioDesignInvites, studioDesignMembers, studioDesigns, users } from '../db/schema.js'
import { memberIds } from '../studio/members.js'
import type { Exec } from '../studio/quota.js'

/**
 * In-app notifications (LIV-159). A row carries names and design titles only, never prompt or chat text. With a
 * groupKey, an unread row for the same key is updated in place (its data merged, updatedAt moved) instead of adding
 * another; once it is read, the next one starts a new row. Kept 90 days from their last update.
 */
export type NotificationKind = 'studio_invite' | 'studio_prompts' | 'studio_package_ready' | 'studio_owner'
type Data = Record<string, unknown>

export const NOTIFICATION_DAYS = 90
const PAGE = 20
const MAX_PAGE = 50
// Each lost race means another writer made progress, so this only has to outlast the writers that can meet at once
const TRIES = 10

/**
 * Adds a notification, or merges into the user's unread one with the same groupKey. The merge is a compare-and-set on
 * the row's data, and the insert leans on the partial unique index, so two at once end as one unread row.
 */
export async function notify(
  userId: string, kind: NotificationKind, data: Data,
  opts: { groupKey?: string; merge?: (old: Data, next: Data) => Data } = {}, exec: Exec = db,
): Promise<void> {
  const { groupKey, merge } = opts
  if (!groupKey) {
    await exec.insert(notifications).values({ userId, kind, data })
    return
  }
  for (let i = 0; i < TRIES; i++) {
    const [row] = await exec.select({ id: notifications.id, data: notifications.data }).from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.groupKey, groupKey), isNull(notifications.readAt)))
    if (!row) {
      const made = await exec.insert(notifications).values({ userId, kind, data, groupKey }).onConflictDoNothing().returning({ id: notifications.id })
      if (made.length) return
      continue // another one landed first: merge into it
    }
    const merged = merge ? merge(row.data as Data, data) : data
    const done = await exec.update(notifications).set({ data: merged, updatedAt: sql`now()` })
      .where(and(eq(notifications.id, row.id), isNull(notifications.readAt), sql`${notifications.data} = ${JSON.stringify(row.data)}::jsonb`))
      .returning({ id: notifications.id })
    if (done.length) return
  }
  throw new Error('notification kept changing under us')
}

/** The notifications of invites that were answered (accepted, declined, cancelled) are read. */
export async function markInvitesRead(inviteIds: string[], now: Date, exec: Exec = db): Promise<void> {
  if (!inviteIds.length) return
  await exec.update(notifications).set({ readAt: now })
    .where(and(eq(notifications.kind, 'studio_invite'), isNull(notifications.readAt), inArray(sql`${notifications.data}->>'inviteId'`, inviteIds)))
}

/** Every unanswered invite of the design was cancelled (archiving it): their notifications are read. */
export async function markDesignInvitesRead(designId: string, now: Date, exec: Exec = db): Promise<void> {
  await exec.update(notifications).set({ readAt: now })
    .where(and(eq(notifications.kind, 'studio_invite'), isNull(notifications.readAt), sql`${notifications.data}->>'designId' = ${designId}`))
}

/** Invites that expired unanswered: their notifications are read (a resend makes a fresh one). Run by the sweep. */
export async function markExpiredInvitesRead(now: Date): Promise<void> {
  await db.update(notifications).set({ readAt: now }).where(and(
    eq(notifications.kind, 'studio_invite'), isNull(notifications.readAt),
    sql`${notifications.data}->>'inviteId' IN (SELECT id::text FROM studio_design_invites
      WHERE accepted_at IS NULL AND declined_at IS NULL AND cancelled_at IS NULL AND expires_at <= ${now.toISOString()}::timestamptz)`,
  ))
}

/** Drops notifications not updated for 90 days. */
export async function pruneNotifications(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - NOTIFICATION_DAYS * 24 * 3600_000)
  const rows = await db.delete(notifications).where(lt(notifications.updatedAt, cutoff)).returning({ id: notifications.id })
  return rows.length
}

// ── Studio hooks ──

const inflight = new Set<Promise<void>>()
/** Runs a notify without holding up the caller; `flushNotifications` waits for the ones started (tests). */
export function inBackground(p: Promise<void>): void {
  inflight.add(p)
  void p.finally(() => inflight.delete(p))
}
export async function flushNotifications(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight])
}

/** Never throws: a notification must not fail what it reports. */
async function quietly(what: string, fn: () => Promise<void>) {
  try { await fn() } catch (err) { console.error(`[notifications] ${what} failed:`, err instanceof Error ? err.message : err) }
}

const nameOf = async (userId: string): Promise<string> =>
  (await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)))[0]?.displayName || 'Someone'

/** An invite to an existing account: it goes to that account until it is answered. */
export async function notifyInvite(i: { id: string; designId: string; userId: string | null; invitedBy: string; role: string }): Promise<void> {
  if (!i.userId) return
  await quietly('invite', async () => {
    // A resend shows it again: the earlier one (if still unread) gives way
    await markInvitesRead([i.id], new Date())
    const [d] = await db.select({ name: studioDesigns.name }).from(studioDesigns).where(eq(studioDesigns.id, i.designId))
    await notify(i.userId!, 'studio_invite', {
      inviteId: i.id, designId: i.designId, designName: d?.name ?? '', inviterName: await nameOf(i.invitedBy), role: i.role,
    })
  })
}

export const SUPPORT_NAME = 'Virvi support'

/**
 * A prompt was queued: everyone on the design but its sender hears of it, as one unread item per design (the count
 * and the names of who asked grow). Support's prompt (`support`) goes to the owner and the members.
 */
export async function notifyPrompt(design: { id: string; name: string }, senderId: string, senderName: string | null, support: boolean): Promise<void> {
  await quietly('prompt', async () => {
    const sender = support ? SUPPORT_NAME : senderName || 'Someone'
    const ids = (await memberIds(design.id)).filter((id) => support || id !== senderId)
    for (const id of ids) {
      await notify(id, 'studio_prompts', { designId: design.id, designName: design.name, senders: [sender], count: 1 }, {
        groupKey: `studio_prompts:${design.id}`,
        merge: (old, next) => {
          const senders = Array.isArray(old.senders) ? old.senders as string[] : []
          return { ...next, senders: senders.includes(sender) ? senders : [...senders, sender], count: (Number(old.count) || 0) + 1 }
        },
      })
    }
  })
}

/** A piece's package is ready: the owner and every current member hear of it. */
export async function notifyPackageReady(designId: string, categories: string[]): Promise<void> {
  if (!categories.length) return
  await quietly('package ready', async () => {
    const [d] = await db.select({ name: studioDesigns.name }).from(studioDesigns).where(eq(studioDesigns.id, designId))
    if (!d) return
    for (const id of await memberIds(designId)) {
      for (const category of categories) await notify(id, 'studio_package_ready', { designId, designName: d.name, category })
    }
  })
}

// ── Reading ──

/** The designs, out of these, the user has a role on. */
async function designsWithRole(userId: string, designIds: string[]): Promise<Set<string>> {
  if (!designIds.length) return new Set()
  const owned = await db.select({ id: studioDesigns.id }).from(studioDesigns)
    .where(and(inArray(studioDesigns.id, designIds), eq(studioDesigns.ownerId, userId)))
  const member = await db.select({ id: studioDesignMembers.designId }).from(studioDesignMembers)
    .where(and(inArray(studioDesignMembers.designId, designIds), eq(studioDesignMembers.userId, userId), isNull(studioDesignMembers.leftAt)))
  return new Set([...owned.map((r) => r.id), ...member.map((r) => r.id)])
}

/** The ids of the invites still open (unanswered, unexpired). */
async function openInvites(inviteIds: string[], now: Date): Promise<Set<string>> {
  if (!inviteIds.length) return new Set()
  const rows = await db.select({ id: studioDesignInvites.id }).from(studioDesignInvites).where(and(
    inArray(studioDesignInvites.id, inviteIds), isNull(studioDesignInvites.acceptedAt), isNull(studioDesignInvites.declinedAt),
    isNull(studioDesignInvites.cancelledAt), sql`${studioDesignInvites.expiresAt} > ${now.toISOString()}::timestamptz`,
  ))
  return new Set(rows.map((r) => r.id))
}

/** The user's notifications, newest update first, a page before `before`; `gone` marks ones that point at nothing they can reach now. */
export async function listNotifications(userId: string, before: Date | null, limit: number, now: Date) {
  const take = Math.min(Math.max(Math.floor(limit) || PAGE, 1), MAX_PAGE)
  const rows = await db.select().from(notifications)
    .where(and(eq(notifications.userId, userId), before ? lt(notifications.updatedAt, before) : undefined))
    .orderBy(desc(notifications.updatedAt), desc(notifications.id)).limit(take + 1)
  const page = rows.slice(0, take)
  const dataOf = (n: typeof page[number]) => n.data as Data
  const roles = await designsWithRole(userId, [...new Set(page.filter((n) => n.kind !== 'studio_invite').map((n) => String(dataOf(n).designId)))])
  const open = await openInvites(page.filter((n) => n.kind === 'studio_invite').map((n) => String(dataOf(n).inviteId)), now)
  return {
    items: page.map((n) => ({
      id: n.id, kind: n.kind, data: n.data, createdAt: n.createdAt, updatedAt: n.updatedAt, readAt: n.readAt,
      gone: n.kind === 'studio_invite' ? !open.has(String(dataOf(n).inviteId)) : !roles.has(String(dataOf(n).designId)),
    })),
    more: rows.length > take,
  }
}

export async function unreadCount(userId: string): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
  return n
}

/** Marks one of the user's notifications read; false when it isn't theirs. */
export async function markRead(userId: string, id: string, now: Date): Promise<boolean> {
  const [row] = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
  if (!row) return false
  await db.update(notifications).set({ readAt: now }).where(and(eq(notifications.id, id), isNull(notifications.readAt)))
  return true
}

export async function markAllRead(userId: string, now: Date): Promise<void> {
  await db.update(notifications).set({ readAt: now }).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
}
