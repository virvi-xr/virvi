import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { notifications, studioDesigns, studioHelpRequests, studioMessages, users } from '../db/schema.js'
import { config } from '../config.js'
import { inBackground, notify } from '../notifications/notifications.js'
import { publishStudio } from './events.js'

/**
 * Help requests: someone on a design presses Help and Virvi support is asked to step in, with a design or with a
 * question the agent can't answer. The request shows in the design's conversation (role 'help'), rings every admin's
 * bell, posts to the support Discord channel (when its webhook is set) and waits in the admin queue. It is free, and
 * works while the account is out of prompts or paused. Support's reply on the design (a note or a prompt) resolves it,
 * or support marks it resolved in the queue.
 */

export const HELP_MAX = 2000
/** Requests one account may make in a day, across all its designs (one open per design is held by the database). */
export const HELP_PER_DAY = 5
const DAY_MS = 24 * 3600_000

type Design = { id: string; name: string; kind: string; ownerId: string }
export type HelpRefusal = { status: number; code: string; error: string }

/** The design's open request, for its page. */
export async function openHelp(designId: string): Promise<{ id: string; createdAt: Date } | null> {
  const [r] = await db.select({ id: studioHelpRequests.id, createdAt: studioHelpRequests.createdAt }).from(studioHelpRequests)
    .where(and(eq(studioHelpRequests.designId, designId), isNull(studioHelpRequests.resolvedAt)))
  return r ?? null
}

export async function requestHelp(d: Design, userId: string, text: string, now: Date): Promise<{ ok: true; id: string } | ({ ok: false } & HelpRefusal)> {
  const [{ n }] = await db.select({ n: count() }).from(studioHelpRequests)
    .where(and(eq(studioHelpRequests.userId, userId), gt(studioHelpRequests.createdAt, new Date(now.getTime() - DAY_MS))))
  if (n >= HELP_PER_DAY) {
    return { ok: false, status: 429, code: 'help_limit', error: `You can ask Virvi support for help ${HELP_PER_DAY} times a day. Try again tomorrow.` }
  }
  let id: string
  try {
    id = await db.transaction(async (tx) => {
      const [r] = await tx.insert(studioHelpRequests).values({ designId: d.id, userId, text, createdAt: now }).returning({ id: studioHelpRequests.id })
      await tx.insert(studioMessages).values({ designId: d.id, role: 'help', text, userId, createdAt: now })
      return r.id
    })
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return { ok: false, status: 409, code: 'help_open', error: 'Virvi support has already been asked about this design and will reply here.' }
    }
    throw err
  }
  await publishStudio(d.id, { type: 'message' })
  inBackground(alertSupport(d, userId, id))
  return { ok: true, id }
}

/** Resolves the design's open request (support replied, or marked it): every admin's notification of it is read. */
export async function resolveHelp(where: { designId: string } | { id: string }, adminId: string, now: Date): Promise<boolean> {
  const rows = await db.update(studioHelpRequests).set({ resolvedAt: now, resolvedBy: adminId })
    .where(and('id' in where ? eq(studioHelpRequests.id, where.id) : eq(studioHelpRequests.designId, where.designId), isNull(studioHelpRequests.resolvedAt)))
    .returning({ id: studioHelpRequests.id, designId: studioHelpRequests.designId })
  if (!rows.length) return false
  await db.update(notifications).set({ readAt: now })
    .where(and(eq(notifications.kind, 'studio_help'), isNull(notifications.readAt), sql`${notifications.data}->>'requestId' = ${rows[0].id}`))
  await publishStudio(rows[0].designId, { type: 'message' })
  return true
}

/** The open requests, oldest first: what was asked, on which design, by whom. */
export async function listOpenHelp() {
  return db.select({
    id: studioHelpRequests.id, text: studioHelpRequests.text, createdAt: studioHelpRequests.createdAt,
    designId: studioDesigns.id, designName: studioDesigns.name, kind: studioDesigns.kind,
    userId: users.id, displayName: users.displayName,
  }).from(studioHelpRequests)
    .innerJoin(studioDesigns, eq(studioDesigns.id, studioHelpRequests.designId))
    .innerJoin(users, eq(users.id, studioHelpRequests.userId))
    .where(isNull(studioHelpRequests.resolvedAt))
    .orderBy(asc(studioHelpRequests.createdAt))
}

/** The Discord message: who asked, on which design, and the link. Their words stay on Virvi. */
export function discordMessage(a: { name: string; kind: string; who: string; link: string }) {
  const clean = (s: string) => s.replace(/[*_~`|>@\\[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Untitled'
  return {
    username: 'Virvi support',
    allowed_mentions: { parse: [] as string[] },
    content: `**Help requested** on the ${a.kind} design **${clean(a.name)}** by ${clean(a.who)}.\n${a.link}`,
  }
}

type Post = (url: string, body: unknown) => Promise<void>
const discordPost: Post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`Discord answered ${res.status}`)
}
let post: Post = discordPost
/** Tests: swap the Discord post (null restores it). */
export function setHelpPost(p: Post | null) { post = p ?? discordPost }

/** Every admin's bell, and the Discord channel. Never throws: an alert must not fail the request. */
async function alertSupport(d: Design, userId: string, requestId: string): Promise<void> {
  try {
    const [u] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId))
    const who = u?.displayName || 'Someone'
    const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'))
    for (const a of admins) await notify(a.id, 'studio_help', { designId: d.id, designName: d.name, requestId, requesterName: who })
    const url = config.studioHelpDiscordWebhookUrl
    if (url) {
      const link = `${config.webAppUrl.replace(/\/$/, '')}/studio/${d.id}`
      await post(url, discordMessage({ name: d.name, kind: d.kind, who, link })).catch((err) => {
        // The URL is a secret: only the error's message, never the request
        console.error('[studio-help] Discord post failed:', err instanceof Error ? err.message : err)
      })
    }
  } catch (err) {
    console.error('[studio-help] alert failed:', err instanceof Error ? err.message : err)
  }
}
