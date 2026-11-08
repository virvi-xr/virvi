import { sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { config } from '../config.js'
import { findSpikes } from './spikes.js'
import type { Thresholds } from './settings.js'

/** What the admin Errors page and the Linear issues read (LIV-66). */

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`
const rowsOf = <T>(r: unknown) => r as unknown as T[]
/** error_hourly_users rows that are users, not day-salted address markers ('ip:…'). */
export const USER_ROW = sql`user_hash NOT LIKE 'ip:%'`
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString())

export interface SignatureSummary {
  id: string
  signature: string
  source: string
  kind: string
  status: number | null
  expected: string | null
  firstSeenAt: string
  lastSeenAt: string
  firstRelease: string | null
  lastRelease: string | null
  totalCount: number
  resolvedAt: string | null
  regressedAt: string | null
  userReports: number
  linearIssueKey: string | null
  linearIssueUrl: string | null
  /** In the window asked for. */
  count: number
  users: number
}

type SigRow = Record<string, unknown>
const summary = (r: SigRow): SignatureSummary => ({
  id: r.id as string,
  signature: r.signature as string,
  source: r.source as string,
  kind: r.kind as string,
  status: (r.status as number | null) ?? null,
  expected: (r.expected as string | null) ?? null,
  firstSeenAt: iso(r.first_seen_at)!,
  lastSeenAt: iso(r.last_seen_at)!,
  firstRelease: (r.first_release as string | null) ?? null,
  lastRelease: (r.last_release as string | null) ?? null,
  totalCount: Number(r.total_count ?? 0),
  resolvedAt: iso(r.resolved_at),
  regressedAt: iso(r.regressed_at),
  userReports: Number(r.user_reports ?? 0),
  linearIssueKey: (r.linear_issue_key as string | null) ?? null,
  linearIssueUrl: (r.linear_issue_url as string | null) ?? null,
  count: Number(r.count ?? 0),
  users: Number(r.users ?? 0),
})

/** Every signature with events since `from`, with its count and distinct users there. */
async function windowed(from: Date, where = sql`TRUE`): Promise<SignatureSummary[]> {
  return rowsOf<SigRow>(await db.execute(sql`
    WITH c AS (SELECT signature_id, sum(count)::bigint AS count FROM error_hourly WHERE hour >= ${ts(from)} GROUP BY 1),
         u AS (SELECT signature_id, count(DISTINCT user_hash)::int AS users FROM error_hourly_users WHERE hour >= ${ts(from)} AND ${USER_ROW} GROUP BY 1)
    SELECT s.*, c.count, coalesce(u.users, 0) AS users
    FROM c JOIN error_signatures s ON s.id = c.signature_id LEFT JOIN u ON u.signature_id = c.signature_id
    WHERE ${where}
    ORDER BY c.count DESC LIMIT 500`)).map(summary)
}

const top = (rows: SignatureSummary[]) => ({
  byUsers: [...rows].sort((a, b) => b.users - a.users || b.count - a.count).slice(0, 20),
  byCount: [...rows].sort((a, b) => b.count - a.count || b.users - a.users).slice(0, 20),
})

/** An hourly series of `hours` buckets ending with the current hour, for each signature id. */
async function series(ids: string[], now: Date, hours: number): Promise<Record<string, number[]>> {
  if (!ids.length) return {}
  const h0 = Math.floor(now.getTime() / HOUR) * HOUR
  const from = new Date(h0 - (hours - 1) * HOUR)
  const rows = rowsOf<{ signature_id: string; hour: string; count: number }>(await db.execute(sql`
    SELECT signature_id, hour, count FROM error_hourly
    WHERE hour >= ${ts(from)} AND signature_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`))
  const out: Record<string, number[]> = Object.fromEntries(ids.map((id) => [id, Array(hours).fill(0)]))
  for (const r of rows) {
    const i = Math.round((new Date(r.hour).getTime() - from.getTime()) / HOUR)
    if (i >= 0 && i < hours) out[r.signature_id][i] += Number(r.count)
  }
  return out
}

export async function errorsOverview(now: Date, t: Thresholds) {
  const notExpected = sql`s.expected IS NULL`
  const [day, week] = await Promise.all([windowed(new Date(now.getTime() - DAY), notExpected), windowed(new Date(now.getTime() - 7 * DAY), notExpected)])

  const newRows = rowsOf<SigRow>(await db.execute(sql`
    SELECT s.*, s.total_count AS count,
      (SELECT count(DISTINCT user_hash) FROM error_hourly_users u WHERE u.signature_id = s.id AND ${USER_ROW})::int AS users
    FROM error_signatures s WHERE s.first_seen_at >= ${ts(new Date(now.getTime() - 7 * DAY))} AND s.expected IS NULL
    ORDER BY s.first_seen_at DESC LIMIT 50`)).map((r) => ({ ...summary(r), sinceDeploy: r.first_release === config.release }))

  const spikes = await findSpikes(now, t)
  const spikeRows = spikes.length ? rowsOf<SigRow>(await db.execute(sql`
    SELECT s.* FROM error_signatures s WHERE s.id IN (${sql.join(spikes.map((x) => sql`${x.signatureId}::uuid`), sql`, `)})`)).map(summary) : []
  const spiking = spikes.map((x) => ({ ...spikeRows.find((s) => s.id === x.signatureId)!, count: x.count, usual: x.usual, hour: x.hour.toISOString() }))
    .filter((s) => s.id)

  const regressions = rowsOf<SigRow>(await db.execute(sql`
    SELECT s.*, s.total_count AS count FROM error_signatures s
    WHERE s.regressed_at IS NOT NULL AND s.resolved_at IS NULL AND s.expected IS NULL
    ORDER BY s.regressed_at DESC LIMIT 50`)).map(summary)

  const expectedRows = await windowed(new Date(now.getTime() - 7 * DAY), sql`s.expected IS NOT NULL`)
  const expectedSeries = await series(expectedRows.slice(0, 30).map((r) => r.id), now, 7 * 24)
  const expected = expectedRows.slice(0, 30).map((r) => ({ ...r, hourly: expectedSeries[r.id] }))

  return {
    release: config.release,
    top: { day: top(day), week: top(week) },
    new: newRows,
    spiking,
    regressions,
    expected,
  }
}

const DIMS = ['release', 'route', 'browser', 'os', 'org'] as const

export async function signatureDetail(id: string, now: Date, days = 7) {
  const [sig] = rowsOf<SigRow>(await db.execute(sql`SELECT * FROM error_signatures WHERE id = ${id}::uuid`))
  if (!sig) return null
  const from = new Date(Math.floor((now.getTime() - days * DAY) / HOUR) * HOUR)
  const hourly = rowsOf<{ hour: string; count: number; users: number }>(await db.execute(sql`
    SELECT hour, count, users FROM error_hourly WHERE signature_id = ${id}::uuid AND hour >= ${ts(from)} ORDER BY hour`))
  const dimRows = rowsOf<{ dim: string; value: string; count: number }>(await db.execute(sql`
    SELECT dim, value, sum(count)::bigint AS count FROM error_hourly_dims WHERE signature_id = ${id}::uuid AND hour >= ${ts(from)}
    GROUP BY dim, value ORDER BY count DESC`))
  const breakdowns = Object.fromEntries(DIMS.map((d) => [d, dimRows.filter((r) => r.dim === d).slice(0, 20).map((r) => ({ value: r.value, count: Number(r.count) }))]))
  const hourOfDay = Array(24).fill(0) as number[]
  for (const h of hourly) hourOfDay[new Date(h.hour).getUTCHours()] += Number(h.count)
  const [totals] = rowsOf<{ day: number; week: number; users_week: number }>(await db.execute(sql`
    SELECT
      (SELECT coalesce(sum(count), 0) FROM error_hourly WHERE signature_id = ${id}::uuid AND hour >= ${ts(new Date(now.getTime() - DAY))})::bigint AS day,
      (SELECT coalesce(sum(count), 0) FROM error_hourly WHERE signature_id = ${id}::uuid AND hour >= ${ts(new Date(now.getTime() - 7 * DAY))})::bigint AS week,
      (SELECT count(DISTINCT user_hash) FROM error_hourly_users WHERE signature_id = ${id}::uuid AND hour >= ${ts(new Date(now.getTime() - 7 * DAY))} AND ${USER_ROW})::int AS users_week`))
  const events = rowsOf<SigRow>(await db.execute(sql`
    SELECT id, occurred_at, received_at, source, kind, release, route, method, path, status, request_id, browser, os, org_id, scene_id,
      count, user_facing, error_type, message, stack, error_body, breadcrumbs
    FROM error_events WHERE signature_id = ${id}::uuid ORDER BY occurred_at DESC LIMIT 20`)).map((e) => ({
    id: e.id as string, occurredAt: iso(e.occurred_at)!, source: e.source as string, kind: e.kind as string, release: e.release as string | null,
    route: e.route as string | null, method: e.method as string | null, path: e.path as string | null, status: e.status as number | null,
    requestId: e.request_id as string | null, browser: e.browser as string | null, os: e.os as string | null, orgId: e.org_id as string | null,
    sceneId: e.scene_id as string | null, count: Number(e.count), userFacing: !!e.user_facing, errorType: e.error_type as string | null,
    message: e.message as string | null, stack: e.stack as string | null, errorBody: e.error_body ?? null, breadcrumbs: (e.breadcrumbs as unknown[] | null) ?? [],
  }))
  const requestIds = [...new Set(events.map((e) => e.requestId).filter((r): r is string => !!r))]
  // The other side of each request: a browser API error and the server's 5xx for the same call
  const joined = requestIds.length ? rowsOf<SigRow>(await db.execute(sql`
    SELECT e.request_id, e.source, e.kind, e.occurred_at, s.id AS signature_id, s.signature FROM error_events e JOIN error_signatures s ON s.id = e.signature_id
    WHERE e.request_id IN (${sql.join(requestIds.map((r) => sql`${r}`), sql`, `)}) AND e.signature_id <> ${id}::uuid
    ORDER BY e.occurred_at DESC LIMIT 50`)).map((j) => ({
    requestId: j.request_id as string, source: j.source as string, kind: j.kind as string, occurredAt: iso(j.occurred_at)!, signatureId: j.signature_id as string, signature: j.signature as string,
  })) : []
  const reports = rowsOf<SigRow>(await db.execute(sql`
    SELECT r.id, r.description, r.release, r.created_at, r.payload, u.email, u.display_name FROM error_reports r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.signature_id = ${id}::uuid ORDER BY r.created_at DESC LIMIT 20`)).map((r) => ({
    id: r.id as string, description: r.description as string, release: r.release as string | null, createdAt: iso(r.created_at)!,
    payload: r.payload, from: (r.email as string | null) ?? (r.display_name as string | null) ?? null,
  }))
  return {
    signature: { ...summary({ ...sig, count: totals.week, users: totals.users_week }), message: sig.message as string | null, route: sig.route as string | null },
    totals: { day: Number(totals.day), week: Number(totals.week), usersWeek: Number(totals.users_week) },
    days,
    timeline: hourly.map((h) => ({ hour: iso(h.hour)!, count: Number(h.count), users: Number(h.users) })),
    hourOfDay,
    breakdowns,
    events,
    requestIds,
    joined,
    reports,
  }
}

export type SignatureDetail = NonNullable<Awaited<ReturnType<typeof signatureDetail>>>
