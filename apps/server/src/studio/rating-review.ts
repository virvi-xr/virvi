import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDigestWeeks, studioMessages, studioPieces, studioRatings, studioRenders, studioRevisions, users } from '../db/schema.js'
import { config } from '../config.js'
import { sendEmail } from '../services/email.js'
import { frameUrlExpiry, signRenderFrame } from './render-urls.js'
import { decodeCursor, encodeCursor, DESIGN_KINDS } from './admin-designs.js'
import { RATING_TAGS, TAG_KEYS } from './ratings.js'

/**
 * What Virvi admins learn from ratings (LIV-142): the 👎 review queue, the weekly digest (on the Studio admin page, and
 * mailed to every admin once a week), and the 👍 rate per agent and model for each design kind.
 */

export const REVIEW_PAGE = 50
/** Ratings an agent/model needs for a kind before the digest names a leader. */
export const MIN_SAMPLE = 20
const WEEK_MS = 7 * 24 * 3600_000

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString())

// ── The 👎 queue ────────────────────────────────────────────────────────────────────────────────────────────────

export type ReviewFilters = { kind?: string | null; agent?: string | null; model?: string | null; tag?: string | null; handled?: boolean | null }

export { decodeCursor }

/** 👎 revisions, newest first, with what an admin needs to judge them: the note, renders, prompt, reply, agent, model, cost. */
export async function listDownRatings(filters: ReviewFilters, cursor: { at: string; id: string } | null, now: Date, limit = REVIEW_PAGE) {
  const where: SQL[] = [sql`r.rating = 'down'`]
  if (filters.kind) where.push(sql`r.kind = ${filters.kind}`)
  if (filters.agent) where.push(sql`r.agent = ${filters.agent}`)
  if (filters.model) where.push(sql`r.model = ${filters.model}`)
  if (filters.tag) where.push(sql`r.tags @> ${JSON.stringify([filters.tag])}::jsonb`)
  if (filters.handled === true) where.push(sql`r.handled_at IS NOT NULL`)
  if (filters.handled === false) where.push(sql`r.handled_at IS NULL`)
  if (cursor) where.push(sql`(r.created_at < ${cursor.at}::timestamptz OR (r.created_at = ${cursor.at}::timestamptz AND r.id < ${cursor.id}::uuid))`)
  const rows = await db.execute(sql`
    SELECT r.*, r.created_at::text AS created_key, d.name AS design_name, d.owner_id, u.display_name, u.email, u.is_trial
    FROM studio_ratings r JOIN studio_designs d ON d.id = r.design_id JOIN users u ON u.id = d.owner_id
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${limit + 1}`) as unknown as Record<string, unknown>[]
  const page = rows.slice(0, limit)
  const jobIds = page.map((r) => r.job_id as string)
  const revs = jobIds.length ? await db.select({
    id: studioRevisions.id, jobId: studioRevisions.jobId, number: studioRevisions.number, category: studioPieces.category, name: studioPieces.name,
    designId: studioPieces.designId,
  }).from(studioRevisions).innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId)).where(inArray(studioRevisions.jobId, jobIds)) : []
  const renders = revs.length ? await db.select().from(studioRenders)
    .where(and(inArray(studioRenders.revisionId, revs.map((r) => r.id)), eq(studioRenders.status, 'ready'))) : []
  const replies = jobIds.length ? await db.select({ jobId: studioMessages.jobId, text: studioMessages.text }).from(studioMessages)
    .where(and(inArray(studioMessages.jobId, jobIds), eq(studioMessages.role, 'agent'))) : []
  const expires = frameUrlExpiry(now)
  const last = page[page.length - 1]
  return {
    ratings: page.map((r) => ({
      id: r.id as string, jobId: r.job_id as string, tags: r.tags as string[], note: (r.note as string | null) ?? null,
      kind: r.kind as string, agent: (r.agent as string | null) ?? null, model: (r.model as string | null) ?? null,
      prompt: (r.prompt as string | null) ?? null, costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
      reply: replies.find((m) => m.jobId === r.job_id)?.text ?? null,
      handledAt: iso(r.handled_at), handledBy: (r.handled_by as string | null) ?? null, autoCheck: !!r.auto_check,
      createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
      design: { id: r.design_id as string, name: r.design_name as string },
      owner: { id: r.owner_id as string, name: (r.display_name as string | null) ?? null, email: (r.email as string | null) ?? null, trial: !!r.is_trial },
      // Each piece the revision changed, with the first frame of each of its views
      pieces: revs.filter((v) => v.jobId === r.job_id).map((v) => ({
        category: v.category, name: v.name, number: v.number,
        views: renders.filter((x) => x.revisionId === v.id).map((x) => ({
          viewKey: x.viewKey,
          url: signRenderFrame({ designId: v.designId, revisionId: v.id, viewKey: x.viewKey, category: v.category, frame: 0, jobId: x.jobId }, expires),
        })),
      })),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor({ at: last.created_key as string, id: last.id as string }) : null,
  }
}

/** Handled, and "could be checked automatically", on a 👎. Null when there is no such 👎. */
export async function markRating(id: string, adminId: string, change: { handled?: boolean; autoCheck?: boolean }, now: Date) {
  const set: Partial<typeof studioRatings.$inferInsert> = {}
  if (change.handled !== undefined) Object.assign(set, change.handled ? { handledAt: now, handledBy: adminId } : { handledAt: null, handledBy: null })
  if (change.autoCheck !== undefined) set.autoCheck = change.autoCheck
  const [r] = await db.update(studioRatings).set(set).where(and(eq(studioRatings.id, id), eq(studioRatings.rating, 'down')))
    .returning({ id: studioRatings.id, handledAt: studioRatings.handledAt, autoCheck: studioRatings.autoCheck })
  return r ?? null
}

// ── Weeks ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The Monday (UTC) of the week holding `d`, as YYYY-MM-DD. */
export function weekStartOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7 // Monday is 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10)
}

/** The last week that has ended by `now`. */
export const lastFullWeek = (now: Date) => weekStartOf(new Date(now.getTime() - WEEK_MS))

/** A week the page asks for: a Monday, as YYYY-MM-DD; null for anything else. */
export function parseWeek(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const d = new Date(`${raw}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw && d.getUTCDay() === 1 ? raw : null
}

const weekRange = (week: string) => {
  const from = new Date(`${week}T00:00:00Z`)
  return { from, to: new Date(from.getTime() + WEEK_MS) }
}

// ── The 👍 rate per agent and model ────────────────────────────────────────────────────────────────────────────

export type RateRow = { agent: string | null; model: string | null; up: number; down: number; total: number; rate: number; enough: boolean }
export type KindRates = { kind: string; rows: RateRow[]; leader: { agent: string | null; model: string | null; rate: number } | null }

/**
 * Per kind, each agent/model's 👍 share of its ratings in [from, to). A leader is named only among those with at least
 * MIN_SAMPLE ratings; below that a row says it hasn't enough yet.
 */
export async function ratesBetween(from: Date, to: Date): Promise<KindRates[]> {
  const rows = await db.select({
    kind: studioRatings.kind, agent: studioRatings.agent, model: studioRatings.model,
    up: sql<number>`count(*) FILTER (WHERE ${studioRatings.rating} = 'up')::int`,
    down: sql<number>`count(*) FILTER (WHERE ${studioRatings.rating} = 'down')::int`,
  }).from(studioRatings)
    .where(and(sql`${studioRatings.createdAt} >= ${from.toISOString()}::timestamptz`, sql`${studioRatings.createdAt} < ${to.toISOString()}::timestamptz`))
    .groupBy(studioRatings.kind, studioRatings.agent, studioRatings.model)
  return DESIGN_KINDS.map((kind) => {
    const mine = rows.filter((r) => r.kind === kind).map((r): RateRow => {
      const total = r.up + r.down
      return { agent: r.agent, model: r.model, up: r.up, down: r.down, total, rate: total ? r.up / total : 0, enough: total >= MIN_SAMPLE }
    }).sort((a, b) => b.total - a.total || String(a.agent).localeCompare(String(b.agent)))
    const best = mine.filter((r) => r.enough).sort((a, b) => b.rate - a.rate || b.total - a.total)[0]
    return { kind, rows: mine, leader: best ? { agent: best.agent, model: best.model, rate: best.rate } : null }
  })
}

// ── The weekly digest ───────────────────────────────────────────────────────────────────────────────────────────

export async function weekDigest(week: string) {
  const { from, to } = weekRange(week)
  const inWeek = and(sql`${studioRatings.createdAt} >= ${from.toISOString()}::timestamptz`, sql`${studioRatings.createdAt} < ${to.toISOString()}::timestamptz`)
  const all = await db.select({
    id: studioRatings.id, rating: studioRatings.rating, tags: studioRatings.tags, note: studioRatings.note, kind: studioRatings.kind,
    agent: studioRatings.agent, model: studioRatings.model, autoCheck: studioRatings.autoCheck, designId: studioRatings.designId,
    jobId: studioRatings.jobId, createdAt: studioRatings.createdAt,
  }).from(studioRatings).where(inWeek)
  const downs = all.filter((r) => r.rating === 'down')

  // 👍 / 👎 by kind × agent × model
  const counts = new Map<string, { kind: string; agent: string | null; model: string | null; up: number; down: number }>()
  for (const r of all) {
    const key = `${r.kind}\u0000${r.agent}\u0000${r.model}`
    const c = counts.get(key) ?? { kind: r.kind, agent: r.agent, model: r.model, up: 0, down: 0 }
    c[r.rating === 'up' ? 'up' : 'down']++
    counts.set(key, c)
  }
  const tagCount = (rows: typeof downs) => TAG_KEYS.map((tag) => ({ tag, label: RATING_TAGS[tag], count: rows.filter((r) => r.tags.includes(tag)).length }))
    .filter((t) => t.count > 0).sort((a, b) => b.count - a.count)

  // Designs with the most 👎s this week
  const byDesign = new Map<string, { up: number; down: number }>()
  for (const r of all) {
    const c = byDesign.get(r.designId) ?? { up: 0, down: 0 }
    c[r.rating === 'up' ? 'up' : 'down']++
    byDesign.set(r.designId, c)
  }
  const worstIds = [...byDesign.entries()].filter(([, c]) => c.down > 0)
    .sort(([, a], [, b]) => b.down - a.down || a.up - b.up).slice(0, 10).map(([id]) => id)
  const names = worstIds.length ? await db.execute(sql`SELECT id, name, kind FROM studio_designs WHERE id IN (${sql.join(worstIds.map((id) => sql`${id}::uuid`), sql`, `)})`) as unknown as { id: string; name: string; kind: string }[] : []

  // "Could be checked automatically", grouped by tag and kind (an untagged 👎 counts as untagged)
  const groups = new Map<string, { tag: string; label: string; kind: string; count: number; ratingIds: string[] }>()
  for (const r of downs.filter((d) => d.autoCheck)) {
    for (const tag of r.tags.length ? r.tags : ['untagged']) {
      const key = `${tag}\u0000${r.kind}`
      const g = groups.get(key) ?? { tag, label: RATING_TAGS[tag as keyof typeof RATING_TAGS] ?? 'No tag', kind: r.kind, count: 0, ratingIds: [] }
      g.count++
      g.ratingIds.push(r.id)
      groups.set(key, g)
    }
  }

  return {
    week, from: from.toISOString(), to: to.toISOString(), minSample: MIN_SAMPLE,
    totals: { up: all.length - downs.length, down: downs.length },
    counts: [...counts.values()].sort((a, b) => a.kind.localeCompare(b.kind) || (b.up + b.down) - (a.up + a.down)),
    topTags: tagCount(downs),
    worstDesigns: worstIds.map((id) => {
      const n = names.find((x) => x.id === id)
      return { id, name: n?.name ?? null, kind: n?.kind ?? null, ...byDesign.get(id)! }
    }),
    notes: downs.filter((r) => r.note).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ id: r.id, designId: r.designId, kind: r.kind, agent: r.agent, model: r.model, tags: r.tags, note: r.note! })),
    autoCheckGroups: [...groups.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    rates: await ratesBetween(from, to),
  }
}

type Mailer = (to: string, subject: string, html: string) => Promise<boolean>
let mailer: Mailer = sendEmail
/** Tests swap the digest's mail out; null puts the real one back. */
export function setDigestMailer(m: Mailer | null) {
  mailer = m ?? sendEmail
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const pct = (x: number) => `${Math.round(x * 100)}%`
const who = (agent: string | null, model: string | null) => `${agent ?? 'unknown'}${model ? ` (${model})` : ''}`

/** The digest as an admin's email: the numbers, the leaders, and a link to the page for the rest. */
export function digestEmail(d: Awaited<ReturnType<typeof weekDigest>>): { subject: string; html: string } {
  const total = d.totals.up + d.totals.down
  const rates = d.rates.filter((k) => k.rows.length).map((k) => `<li><b>${esc(k.kind)}</b>: ${k.leader
    ? `${esc(who(k.leader.agent, k.leader.model))} leads at ${pct(k.leader.rate)} 👍`
    : 'not enough ratings yet to name a leader'}<br>${k.rows.map((r) => `${esc(who(r.agent, r.model))}: ${r.up} 👍 / ${r.down} 👎${r.enough ? '' : ' (not enough ratings yet)'}`).join('<br>')}</li>`).join('')
  const tags = d.topTags.slice(0, 5).map((t) => `<li>${esc(t.label)}: ${t.count}</li>`).join('')
  const notes = d.notes.slice(0, 10).map((n) => `<li>${esc(n.kind)}, ${esc(who(n.agent, n.model))}: “${esc(n.note.slice(0, 300))}”</li>`).join('')
  const auto = d.autoCheckGroups.map((g) => `<li>${esc(g.label)} (${esc(g.kind)}): ${g.count}</li>`).join('')
  return {
    subject: `Design Studio ratings, week of ${d.week}: ${d.totals.up} 👍, ${d.totals.down} 👎`,
    html: `
    <h2>Design Studio ratings, week of ${esc(d.week)}</h2>
    <p>${total} ratings: ${d.totals.up} 👍 and ${d.totals.down} 👎.</p>
    <h3>👍 rate by agent and model</h3><ul>${rates}</ul>
    ${tags ? `<h3>Top complaints</h3><ul>${tags}</ul>` : ''}
    ${notes ? `<h3>What people said</h3><ul>${notes}</ul>` : ''}
    ${auto ? `<h3>Could be checked automatically</h3><ul>${auto}</ul>` : ''}
    <p><a href="${config.publicUrl}/admin/studio">Open the Studio admin page</a> for the review queue and the full digest.</p>`,
  }
}

/** A claim this old with nothing sent means the server that made it died mid-send: the week is claimed again. */
export const DIGEST_RECLAIM_MS = 3600_000

/**
 * Mails the last full week's digest to every admin, once: claim the week (an insert, or taking over a claim an hour
 * old that never sent), mail, then mark it sent. Restarts and other servers skip a week that is sent or freshly
 * claimed. A week with no ratings is recorded and not mailed.
 */
export async function sendWeeklyDigest(now: Date): Promise<'sent' | 'empty' | 'already'> {
  const week = lastFullWeek(now)
  const stale = new Date(now.getTime() - DIGEST_RECLAIM_MS)
  const [seen] = await db.select().from(studioDigestWeeks).where(eq(studioDigestWeeks.weekStart, week))
  if (seen && (seen.sentAt || seen.ratings === 0 || seen.claimedAt > stale)) return 'already'
  const digest = await weekDigest(week)
  const total = digest.totals.up + digest.totals.down
  const [claimed] = seen
    ? await db.update(studioDigestWeeks).set({ claimedAt: now, ratings: total })
      .where(and(eq(studioDigestWeeks.weekStart, week), sql`${studioDigestWeeks.sentAt} IS NULL`,
        sql`${studioDigestWeeks.claimedAt} < ${stale.toISOString()}::timestamptz`))
      .returning()
    : await db.insert(studioDigestWeeks).values({ weekStart: week, ratings: total, claimedAt: now }).onConflictDoNothing().returning()
  if (!claimed) return 'already'
  if (!total) return 'empty'
  const admins = await db.select({ email: users.email }).from(users).where(and(eq(users.role, 'admin'), sql`${users.email} IS NOT NULL`))
  const { subject, html } = digestEmail(digest)
  for (const a of admins) {
    try {
      await mailer(a.email!, subject, html)
    } catch (err) {
      console.error('[studio] digest email failed:', err instanceof Error ? err.message : err)
    }
  }
  await db.update(studioDigestWeeks).set({ sentAt: new Date() }).where(eq(studioDigestWeeks.weekStart, week))
  return 'sent'
}
