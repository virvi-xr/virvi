import { asc, desc, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { statusChecks, statusIncidents, statusIncidentUpdates } from '../db/schema.js'
import { config } from '../config.js'
import { withLock } from '../errors/jobs.js'

/**
 * The public status page (LIV-40). This server checks each component once a minute and writes what it found. Since the
 * server writes its own checks, a minute with no `api` row is a minute it wasn't running: gaps count as downtime.
 */

export type ComponentState = 'up' | 'degraded' | 'down'
export const STATUS_COMPONENTS = [
  { key: 'api', label: 'Website, dashboard and in-world sync', note: null },
  { key: 'decentraland', label: 'Deploying to Decentraland', note: "Decentraland's content servers, which Virvi deploys to. Run by Decentraland." },
] as const
export type ComponentKey = (typeof STATUS_COMPONENTS)[number]['key']

export const STATUS_DAYS = 90
export const CHECK_EVERY_MS = 60_000
/** Decentraland is asked every 5 minutes; its last answer stands for the minutes between. */
export const DCL_EVERY_MS = 5 * 60_000
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

const minuteOf = (d: Date) => new Date(Math.floor(d.getTime() / MINUTE) * MINUTE)

export async function recordCheck(component: ComponentKey, state: ComponentState, detail: string | null, at: Date): Promise<void> {
  await db.insert(statusChecks).values({ component, minute: minuteOf(at), state, detail })
    .onConflictDoUpdate({ target: [statusChecks.component, statusChecks.minute], set: { state, detail } })
}

type Fetch = typeof fetch
/** Reachable within 8 s and answering 2xx: one content server's state. */
async function probe(url: string, fetchImpl: Fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) })
    return res.ok
  } catch {
    return false
  }
}

/** Genesis City's catalyst and the Worlds content server: both up, one down (degraded), or both down. */
export async function checkDecentraland(fetchImpl: Fetch = fetch): Promise<{ state: ComponentState; detail: string | null }> {
  const [catalyst, worlds] = await Promise.all([
    probe(`${config.catalystUrl.replace(/\/$/, '')}/about`, fetchImpl),
    probe(`${config.worldsUrl.replace(/\/$/, '')}/status`, fetchImpl),
  ])
  if (catalyst && worlds) return { state: 'up', detail: null }
  if (!catalyst && !worlds) return { state: 'down', detail: 'Genesis City and Worlds content servers unreachable' }
  return { state: 'degraded', detail: catalyst ? 'Worlds content server unreachable' : 'Genesis City content server unreachable' }
}

let lastDcl: { at: number; state: ComponentState; detail: string | null } | null = null

/** One pass: the API (the database answers) every minute, Decentraland every 5. */
export async function runStatusChecks(now = new Date(), fetchImpl: Fetch = fetch): Promise<void> {
  await db.execute(sql`SELECT 1`)
  await recordCheck('api', 'up', null, now)
  if (!lastDcl || now.getTime() - lastDcl.at >= DCL_EVERY_MS - 5_000) lastDcl = { at: now.getTime(), ...(await checkDecentraland(fetchImpl)) }
  await recordCheck('decentraland', lastDcl.state, lastDcl.detail, now)
}

/** Tests: forget the last Decentraland answer. */
export function resetStatusChecks() { lastDcl = null }

export async function purgeStatus(now: Date): Promise<void> {
  await db.delete(statusChecks).where(lt(statusChecks.minute, new Date(now.getTime() - (STATUS_DAYS + 1) * DAY)))
}

/** Runs the checks every minute on one instance (advisory lock), and the purge hourly. */
export function startStatusJobs(): () => void {
  if (!config.statusChecksEnabled) return () => {}
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await withLock('status:checks', () => runStatusChecks())
    } catch (err) {
      console.error('[status] checks failed:', err instanceof Error ? err.message : err)
    } finally {
      running = false
    }
  }
  const timers = [setInterval(tick, CHECK_EVERY_MS), setInterval(() => { purgeStatus(new Date()).catch(() => {}) }, 60 * MINUTE), setTimeout(tick, 5_000)]
  for (const t of timers) t.unref()
  return () => { for (const t of timers) clearTimeout(t) }
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface StatusDay { day: string; uptime: number | null; worst: ComponentState | null }
export interface StatusComponent { key: string; label: string; note: string | null; state: ComponentState | 'unknown'; detail: string | null; uptime: number | null; days: StatusDay[] }
export interface StatusIncident {
  id: string; title: string; kind: string; status: string; components: string[]; createdAt: string; resolvedAt: string | null
  updates: { status: string; body: string; at: string }[]
}
export interface StatusPage { state: 'up' | 'degraded' | 'down' | 'unknown'; components: StatusComponent[]; incidents: StatusIncident[]; since: string | null; generatedAt: string }

const dayKey = (d: Date) => d.toISOString().slice(0, 10)
const round = (x: number) => Math.round(x * 10000) / 10000

/**
 * Uptime per UTC day. For `api`, the minutes counted are every minute from the first check ever (or the day's start)
 * to now (or the day's end): a minute with no row was down. For the others, only checked minutes count, a degraded one
 * as half up.
 */
export async function statusPage(now = new Date()): Promise<StatusPage> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (STATUS_DAYS - 1) * DAY)
  const rows = await db.execute<{ component: string; day: string; up: number; degraded: number; down: number; first: string }>(sql`
    SELECT component, to_char(date_trunc('day', minute AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      count(*) FILTER (WHERE state = 'up')::int AS up, count(*) FILTER (WHERE state = 'degraded')::int AS degraded,
      count(*) FILTER (WHERE state = 'down')::int AS down, min(minute) AS first
    FROM ${statusChecks} WHERE minute >= ${start.toISOString()}::timestamptz GROUP BY 1, 2`)
  const byKey = new Map<string, { up: number; degraded: number; down: number; first: Date }>()
  for (const r of rows as unknown as { component: string; day: string; up: number; degraded: number; down: number; first: string }[]) {
    byKey.set(`${r.component}:${r.day}`, { up: r.up, degraded: r.degraded, down: r.down, first: new Date(r.first) })
  }
  const [firstEver] = await db.select({ at: sql<string>`min(${statusChecks.minute})` }).from(statusChecks).where(sql`${statusChecks.component} = 'api'`)
  const since = firstEver?.at ? new Date(firstEver.at) : null
  const latest = await db.selectDistinctOn([statusChecks.component], { component: statusChecks.component, minute: statusChecks.minute, state: statusChecks.state, detail: statusChecks.detail })
    .from(statusChecks).orderBy(statusChecks.component, desc(statusChecks.minute))
  const latestOf = new Map(latest.map((l) => [l.component, l]))

  const components: StatusComponent[] = STATUS_COMPONENTS.map((c) => {
    let upTotal = 0
    let countTotal = 0
    const days: StatusDay[] = []
    for (let i = 0; i < STATUS_DAYS; i++) {
      const dayStart = new Date(start.getTime() + i * DAY)
      const key = dayKey(dayStart)
      const agg = byKey.get(`${c.key}:${key}`)
      let total: number
      if (c.key === 'api') {
        const from = Math.max(dayStart.getTime(), since?.getTime() ?? Infinity)
        const to = Math.min(dayStart.getTime() + DAY, minuteOf(now).getTime())
        total = to > from ? Math.round((to - from) / MINUTE) : 0
      } else {
        total = agg ? agg.up + agg.degraded + agg.down : 0
      }
      const up = agg ? agg.up + agg.degraded / 2 : 0
      if (!total) { days.push({ day: key, uptime: null, worst: null }); continue }
      const missing = c.key === 'api' ? Math.max(0, total - (agg ? agg.up + agg.degraded + agg.down : 0)) : 0
      const worst: ComponentState = (agg?.down ?? 0) + missing > 0 ? 'down' : (agg?.degraded ?? 0) > 0 ? 'degraded' : 'up'
      days.push({ day: key, uptime: round(Math.min(1, up / total)), worst })
      upTotal += Math.min(up, total)
      countTotal += total
    }
    const last = latestOf.get(c.key)
    const fresh = last && now.getTime() - new Date(last.minute).getTime() <= 3 * MINUTE
    // The page itself being served means the API is up; a stale row elsewhere means the checks stopped
    const state: StatusComponent['state'] = c.key === 'api' ? 'up' : fresh ? (last!.state as ComponentState) : 'unknown'
    return { key: c.key, label: c.label, note: c.note, state, detail: fresh ? last!.detail ?? null : null, uptime: countTotal ? round(upTotal / countTotal) : null, days }
  })

  const incidents = await listIncidents(now)
  // Overall: the worst of the components, and an open incident on top
  const order = { up: 0, unknown: 0, degraded: 1, down: 2 } as const
  let overall: StatusPage['state'] = components.reduce<StatusPage['state']>((w, c) => (order[c.state] > order[w] ? c.state : w), 'up')
  if (overall === 'up' && incidents.some((i) => !i.resolvedAt && i.kind === 'incident')) overall = 'degraded'
  return { state: overall, components, incidents, since: since?.toISOString() ?? null, generatedAt: now.toISOString() }
}

/** Open incidents, and those resolved in the last 14 days, newest first, each with its timeline (newest first). */
export async function listIncidents(now = new Date()): Promise<StatusIncident[]> {
  const rows = await db.select().from(statusIncidents)
    .where(or(isNull(statusIncidents.resolvedAt), gte(statusIncidents.resolvedAt, new Date(now.getTime() - 14 * DAY))))
    .orderBy(desc(statusIncidents.createdAt)).limit(50)
  if (!rows.length) return []
  const updates = await db.select().from(statusIncidentUpdates)
    .where(inArray(statusIncidentUpdates.incidentId, rows.map((r) => r.id)))
    .orderBy(desc(statusIncidentUpdates.createdAt), asc(statusIncidentUpdates.id))
  return rows.map((r) => ({
    id: r.id, title: r.title, kind: r.kind, status: r.status, components: r.components,
    createdAt: r.createdAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null,
    updates: updates.filter((u) => u.incidentId === r.id).map((u) => ({ status: u.status, body: u.body, at: u.createdAt.toISOString() })),
  }))
}

// ── Incidents (site admins) ─────────────────────────────────────────────────

export class StatusInputError extends Error {}

const clean = (v: unknown, max: number, what: string) => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s || s.length > max) throw new StatusInputError(`${what} is required (up to ${max} characters)`)
  return s
}
const statusOf = (v: unknown): IncidentStatus => {
  if (!INCIDENT_STATUSES.includes(v as IncidentStatus)) throw new StatusInputError(`status must be one of ${INCIDENT_STATUSES.join(', ')}`)
  return v as IncidentStatus
}

export async function createIncident(input: { title?: unknown; status?: unknown; body?: unknown; components?: unknown; kind?: unknown }, by: string, now = new Date()) {
  const title = clean(input.title, 120, 'A title')
  const status = statusOf(input.status ?? 'investigating')
  const body = clean(input.body, 2000, 'An update')
  const kind = input.kind === undefined ? 'incident' : input.kind
  if (kind !== 'incident' && kind !== 'maintenance') throw new StatusInputError('kind must be incident or maintenance')
  const keys = STATUS_COMPONENTS.map((c) => c.key as string)
  const components = input.components === undefined ? [] : input.components
  if (!Array.isArray(components) || !components.every((c) => keys.includes(c))) throw new StatusInputError(`components must be from ${keys.join(', ')}`)
  return db.transaction(async (tx) => {
    const [incident] = await tx.insert(statusIncidents).values({ title, status, kind, components: [...new Set(components as string[])], createdBy: by, createdAt: now, resolvedAt: status === 'resolved' ? now : null }).returning()
    await tx.insert(statusIncidentUpdates).values({ incidentId: incident.id, status, body, createdBy: by, createdAt: now })
    return incident
  })
}

export async function addIncidentUpdate(incidentId: string, input: { status?: unknown; body?: unknown }, by: string, now = new Date()) {
  const status = statusOf(input.status)
  const body = clean(input.body, 2000, 'An update')
  return db.transaction(async (tx) => {
    const [incident] = await tx.update(statusIncidents)
      .set({ status, resolvedAt: status === 'resolved' ? now : null })
      .where(sql`${statusIncidents.id} = ${incidentId}`).returning()
    if (!incident) return null
    await tx.insert(statusIncidentUpdates).values({ incidentId, status, body, createdBy: by, createdAt: now })
    return incident
  })
}

export async function deleteIncident(incidentId: string): Promise<boolean> {
  const gone = await db.delete(statusIncidents).where(sql`${statusIncidents.id} = ${incidentId}`).returning({ id: statusIncidents.id })
  return gone.length > 0
}

