import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  errorSignature, expectedReason, normalizeMessage, routeTemplate, redactText, ERROR_LIMITS,
  type Breadcrumb, type ClientErrorEvent, type ErrorKind,
} from '@virvixr/shared'
import { db } from '../db/connection.js'
import { config } from '../config.js'
import { resetIpKeys } from './user-hash.js'
import { DayBudget, ERROR_BUDGETS, anonLimit, knownReleases, takeNewSignature, takeStoredEvent, type Trust } from './limits.js'

/**
 * The error recorder (LIV-66). Requests and jobs only push into an in-memory buffer; a flusher writes it every
 * ERROR_FLUSH_MS as a few upserts per signature and hour (src/index.ts starts it). Writes are additive, so several
 * server instances can flush at once. Everything stored is bounded by limits.ts: new signatures per address and
 * instance (the rest fold into a counted-only overflow signature), a cap on distinct signatures, and full events only
 * for a signature's first occurrence plus a few a day. Nothing here throws to its caller, and one bad record or
 * signature never drops the rest of a batch.
 */

/** The most records waiting to be written; past it new ones are dropped (and counted in `dropped`). */
const MAX_BUFFER = 10_000
const HOUR_MS = 3_600_000

export interface ErrorRecord {
  hash: string
  signature: string
  source: 'web' | 'server'
  kind: ErrorKind
  status: number | null
  routeTemplate: string | null
  normalizedMessage: string | null
  expected: string | null
  occurredAt: Date
  receivedAt: Date
  release: string
  /** The page (web) or route template (server). */
  route: string | null
  method: string | null
  path: string | null
  requestId: string | null
  browser: string | null
  os: string | null
  userHash: string | null
  orgId: string | null
  sceneId: string | null
  /** The sender's address key (limits.ts ipKey) and its day-salted hash ('ip:…'), for budgets and distinct-address counts. */
  ipKey: string | null
  ipHash: string | null
  count: number
  repeat: boolean
  userFacing: boolean
  errorType: string | null
  message: string | null
  stack: string | null
  errorBody: unknown
  breadcrumbs: Breadcrumb[] | null
}

let buffer: ErrorRecord[] = []
let dropped = 0

export const signatureHash = (signature: string) => createHash('sha256').update(signature).digest('hex').slice(0, 32)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOrNull = (v: string | null | undefined) => (v && UUID.test(v) ? v : null)

function push(r: ErrorRecord) {
  if (!config.errorReportingEnabled) return
  if (buffer.length >= MAX_BUFFER) {
    dropped++
    return
  }
  buffer.push(r)
}

export interface ClientContext {
  release: string | null
  browser: string
  os: string
  userHash: string | null
  orgId: string | null
  ipKey: string | null
  ipHash: string | null
}

/** A validated browser event (checkErrorBatch) as a record. */
export function clientRecord(e: ClientErrorEvent, ctx: ClientContext, receivedAt = new Date()): ErrorRecord {
  const signature = errorSignature({ kind: e.kind, status: e.status, method: e.method, path: e.path, errorType: e.errorType, message: e.message, stack: e.stack })
  return {
    hash: signatureHash(signature),
    signature,
    source: 'web',
    kind: e.kind,
    status: e.status ?? null,
    routeTemplate: e.path ? routeTemplate(e.path) : null,
    normalizedMessage: e.message ? normalizeMessage(e.message) : null,
    expected: e.kind === 'api' && e.status !== undefined ? expectedReason(e.status, e.errorBody) : null,
    occurredAt: new Date(e.t),
    receivedAt,
    release: ctx.release ?? 'unknown',
    route: e.route ?? null,
    method: e.method ?? null,
    path: e.path ?? null,
    requestId: e.requestId ?? null,
    browser: ctx.browser,
    os: ctx.os,
    userHash: ctx.userHash,
    orgId: uuidOrNull(ctx.orgId),
    sceneId: uuidOrNull(e.sceneId),
    ipKey: ctx.ipKey,
    ipHash: ctx.ipHash,
    count: Math.min(e.count ?? 1, ERROR_LIMITS.maxCount),
    repeat: !!e.repeat,
    userFacing: !!e.userFacing,
    errorType: e.errorType ?? null,
    message: e.message ?? null,
    stack: e.stack ?? null,
    errorBody: e.errorBody ?? null,
    breadcrumbs: e.breadcrumbs ?? null,
  }
}

export function recordClientEvents(events: ClientErrorEvent[], ctx: ClientContext): void {
  const at = new Date()
  for (const e of events) push(clientRecord(e, ctx, at))
}

function errorParts(err: unknown): { errorType: string; message: string; stack: string | null } {
  if (err instanceof Error) {
    return {
      errorType: (err.name || 'Error').slice(0, 60),
      message: redactText(String(err.message ?? '').slice(0, ERROR_LIMITS.maxMessage)),
      stack: err.stack ? redactText(err.stack.slice(0, ERROR_LIMITS.maxStack)) : null,
    }
  }
  return { errorType: 'Error', message: redactText(String(err).slice(0, ERROR_LIMITS.maxMessage)), stack: null }
}

interface ServerFields {
  status?: number | null
  method?: string | null
  routeTemplate?: string | null
  requestId?: string | null
  userHash?: string | null
  orgId?: string | null
  sceneId?: string | null
  job?: string
}

function serverRecord(kind: 'server_5xx' | 'server_exception' | 'job', err: unknown, f: ServerFields): ErrorRecord {
  const parts = err === undefined ? null : errorParts(err)
  const signature = errorSignature({
    kind, status: f.status ?? undefined, method: f.method ?? undefined, path: f.routeTemplate ?? undefined,
    errorType: parts?.errorType, message: parts?.message, stack: parts?.stack ?? undefined, job: f.job,
  })
  const now = new Date()
  return {
    hash: signatureHash(signature), signature, source: 'server', kind,
    status: f.status ?? null,
    routeTemplate: f.routeTemplate ?? null,
    normalizedMessage: parts ? normalizeMessage(parts.message) : null,
    expected: null,
    occurredAt: now, receivedAt: now, release: config.release,
    route: f.routeTemplate ?? null, method: f.method ?? null, path: f.routeTemplate ?? null, requestId: f.requestId ?? null,
    browser: null, os: null, userHash: f.userHash ?? null, orgId: uuidOrNull(f.orgId), sceneId: uuidOrNull(f.sceneId),
    ipKey: null, ipHash: null,
    count: 1, repeat: false, userFacing: false,
    errorType: parts?.errorType ?? null, message: parts?.message ?? null, stack: parts?.stack ?? null,
    errorBody: null, breadcrumbs: null,
  }
}

/** A 5xx answer (with the exception behind it, if one was thrown), grouped by status, method and route. */
export function recordServerResponse(f: ServerFields & { status: number; method: string; routeTemplate: string }, err?: unknown): void {
  try { push(serverRecord('server_5xx', err, f)) } catch { /* never let reporting fail a request */ }
}

/** An exception nothing caught (unhandledRejection, uncaughtException). */
export function recordServerException(err: unknown): void {
  try { push(serverRecord('server_exception', err, {})) } catch { /* ignore */ }
}

/** A background job that failed: studio worker jobs, deploys, imports, payment webhooks. */
export function recordJobFailure(job: string, err: unknown, f: { sceneId?: string | null; orgId?: string | null } = {}): void {
  try { push(serverRecord('job', err instanceof Error ? err : new Error(String(err)), { ...f, job })) } catch { /* ignore */ }
}

// ── Bounding ───────────────────────────────────────────────────────────────

/** The counted-only signature a record folds into past a budget. */
export function overflowRecord(r: ErrorRecord): ErrorRecord {
  const signature = `overflow ${r.kind}`
  return {
    ...r, hash: signatureHash(signature), signature, status: null, routeTemplate: null, normalizedMessage: null, expected: 'overflow',
    route: null, method: null, path: null, requestId: null, errorType: null, message: null, stack: null, errorBody: null, breadcrumbs: null,
    repeat: true,
  }
}

/** A record cut to fit ERROR_BUDGETS.maxStoredEventBytes: the oldest breadcrumbs go first, then the stack, then the body. */
export function boundRecord(r: ErrorRecord): ErrorRecord {
  const size = (x: ErrorRecord) => {
    try { return JSON.stringify({ m: x.message, s: x.stack, b: x.errorBody, c: x.breadcrumbs, r: x.route, p: x.path }).length } catch { return Infinity }
  }
  const cap = ERROR_BUDGETS.maxStoredEventBytes
  if (size(r) <= cap) return r
  const out = { ...r, breadcrumbs: r.breadcrumbs ? [...r.breadcrumbs] : null }
  while (out.breadcrumbs && out.breadcrumbs.length > 5 && size(out) > cap) out.breadcrumbs.shift()
  if (size(out) > cap && out.stack) out.stack = out.stack.slice(0, 1500)
  if (size(out) > cap) out.errorBody = null
  while (out.breadcrumbs && out.breadcrumbs.length && size(out) > cap) out.breadcrumbs.shift()
  return out
}

// ── Flushing ───────────────────────────────────────────────────────────────

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`
const rowsOf = <T>(r: unknown) => r as unknown as T[]
const hourOf = (d: Date) => new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS)
const THIRTY_DAYS = 30 * 24 * HOUR_MS

const trustOf = (r: ErrorRecord): Trust => (r.source === 'server' ? 'server' : r.userHash ? 'user' : 'anon')
/** A group speaks for its most trusted record: one signed-in user's event makes its signature-hour theirs. */
const groupTrust = (g: ErrorRecord[]): Trust => (g.some((r) => r.source === 'server') ? 'server' : g.some((r) => r.userHash) ? 'user' : 'anon')

let signatureTotal = { n: 0, anon: 0, at: 0 }
/**
 * Browser signatures seen in the last 30 days, and how many of them only anonymous browsers hit (cached a minute;
 * bumped as this instance adds some). Server ones aren't capped.
 */
async function signatureCount(): Promise<{ n: number; anon: number }> {
  if (Date.now() - signatureTotal.at > 60_000) {
    const [row] = rowsOf<{ n: number; anon: number }>(await db.execute(sql`
      SELECT count(*)::int AS n, (count(*) FILTER (WHERE NOT seen_users))::int AS anon FROM error_signatures
      WHERE source = 'web' AND expected IS DISTINCT FROM 'overflow' AND last_seen_at >= ${ts(new Date(Date.now() - THIRTY_DAYS))}`))
    signatureTotal = { n: Number(row.n), anon: Number(row.anon), at: Date.now() }
  }
  return signatureTotal
}

/** A browser's claims clamped: a release the server hasn't run is "unknown"; a browser is family and a plausible major. */
function clampWeb(r: ErrorRecord, known: Set<string>): ErrorRecord {
  if (r.source !== 'web') return r
  const release = known.has(r.release) ? r.release : 'unknown'
  const m = /^(.+) (\d+)$/.exec(r.browser ?? '')
  const browser = m && Number(m[2]) > 200 ? `${m[1]} other` : r.browser
  return release === r.release && browser === r.browser ? r : { ...r, release, browser }
}

async function writeSignature(group: ErrorRecord[]): Promise<string> {
  const first = group[0]
  const last = group.reduce((a, b) => (b.receivedAt > a.receivedAt ? b : a))
  const firstSeen = group.reduce((a, b) => (b.receivedAt < a.receivedAt ? b : a)).receivedAt
  const count = group.reduce((n, r) => n + r.count, 0)
  const [row] = rowsOf<{ id: string }>(await db.execute(sql`
    INSERT INTO error_signatures (hash, signature, source, kind, status, route, error_type, message, expected,
      first_seen_at, last_seen_at, first_release, last_release, total_count)
    VALUES (${first.hash}, ${first.signature}, ${first.source}, ${first.kind}, ${first.status}, ${first.routeTemplate},
      ${first.errorType}, ${first.normalizedMessage}, ${first.expected}, ${ts(firstSeen)}, ${ts(last.receivedAt)},
      ${first.release}, ${last.release}, ${count})
    ON CONFLICT (hash) DO UPDATE SET
      last_seen_at = GREATEST(error_signatures.last_seen_at, excluded.last_seen_at),
      last_release = excluded.last_release,
      total_count = error_signatures.total_count + excluded.total_count,
      regressed_at = CASE WHEN error_signatures.resolved_at IS NOT NULL AND excluded.last_seen_at > error_signatures.resolved_at
        THEN excluded.last_seen_at ELSE error_signatures.regressed_at END,
      resolved_at = CASE WHEN error_signatures.resolved_at IS NOT NULL AND excluded.last_seen_at > error_signatures.resolved_at
        THEN NULL ELSE error_signatures.resolved_at END
    RETURNING id`))
  return row.id
}

/** Distinct breakdown values seen per signature-hour by this instance, bounded in all (past a cap a value is "other"). */
const dimValues = new Map<string, Set<string>>()
let dimHour = 0
let dimTotal = 0
function dimValue(signatureId: string, hour: Date, dim: string, value: string): string {
  if (hour.getTime() !== dimHour) { dimHour = hour.getTime(); dimValues.clear(); dimTotal = 0 }
  const key = `${signatureId}\u0000${dim}`
  const seen = dimValues.get(key)
  if (seen?.has(value)) return value
  if ((seen?.size ?? 0) >= ERROR_BUDGETS.maxDimValuesPerSignatureHour || dimTotal >= ERROR_BUDGETS.maxDimKeysInMemory) return 'other'
  if (seen) seen.add(value)
  else dimValues.set(key, new Set([value]))
  dimTotal++
  return value
}

/** Adds `n` to a counter row, making it only if the day's budget for `budgetKey` allows. False when it neither existed nor could be made. */
async function bump(budget: DayBudget, budgetKey: keyof typeof ERROR_BUDGETS.db, trust: Trust, update: ReturnType<typeof sql>, insert: ReturnType<typeof sql>): Promise<boolean> {
  if (rowsOf(await db.execute(update)).length) return true
  if (!budget.takeFor(budgetKey, 1, trust)) return false
  await db.execute(insert)
  return true
}

async function writeHour(signatureId: string, hour: Date, group: ErrorRecord[], isNew: boolean, budget: DayBudget): Promise<void> {
  const trust = groupTrust(group)
  const count = group.reduce((n, r) => n + r.count, 0)
  // The hourly row was checked (or budgeted) by the plan: here it is only made or added to
  await db.execute(sql`
    INSERT INTO error_hourly (signature_id, hour, count) VALUES (${signatureId}, ${ts(hour)}, ${count})
    ON CONFLICT (signature_id, hour) DO UPDATE SET count = error_hourly.count + excluded.count`)

  // Distinct users (hashed account ids) and distinct addresses (day-keyed 'ip:' hashes) that hour, within the day's row budget
  const hashes = [...new Set(group.flatMap((r) => [r.userHash, r.ipHash]).filter((h): h is string => !!h))]
  if (hashes.length) {
    const present = new Set(rowsOf<{ user_hash: string }>(await db.execute(sql`
      SELECT user_hash FROM error_hourly_users WHERE signature_id = ${signatureId} AND hour = ${ts(hour)}
        AND user_hash IN (${sql.join(hashes.map((h) => sql`${h}`), sql`, `)})`)).map((r) => r.user_hash))
    const fresh = hashes.filter((h) => !present.has(h))
    // A user's own row is theirs to make; an address row uses the group's share
    const allowed = fresh.filter((h) => budget.takeFor('users', 1, h.startsWith('ip:') ? trust : trust === 'server' ? 'server' : 'user') === 1)
    if (allowed.length) {
      const added = rowsOf<{ user_hash: string }>(await db.execute(sql`
        INSERT INTO error_hourly_users (signature_id, hour, user_hash)
        VALUES ${sql.join(allowed.map((h) => sql`(${signatureId}, ${ts(hour)}, ${h})`), sql`, `)}
        ON CONFLICT DO NOTHING RETURNING user_hash`))
      const ips = added.filter((a) => a.user_hash.startsWith('ip:')).length
      const users = added.length - ips
      if (added.length) {
        await db.execute(sql`UPDATE error_hourly SET users = users + ${users}, ips = ips + ${ips} WHERE signature_id = ${signatureId} AND hour = ${ts(hour)}`)
      }
      if (users) await db.execute(sql`UPDATE error_signatures SET seen_users = true WHERE id = ${signatureId} AND NOT seen_users`)
    }
  }

  const dims = new Map<string, { dim: string; value: string; count: number }>()
  for (const r of group) {
    const route = r.source === 'web' && r.route ? routeTemplate(r.route).slice(0, 100) : r.route
    for (const [dim, raw] of [['release', r.release], ['route', route], ['browser', r.browser], ['os', r.os], ['org', r.orgId]] as const) {
      if (!raw) continue
      const value = dimValue(signatureId, hour, dim, raw.slice(0, 100))
      const key = `${dim}\u0000${value}`
      const d = dims.get(key) ?? { dim, value, count: 0 }
      d.count += r.count
      dims.set(key, d)
    }
  }
  for (const d of dims.values()) {
    if (!d.count) continue
    await bump(budget, 'dims', trust,
      sql`UPDATE error_hourly_dims SET count = count + ${d.count} WHERE signature_id = ${signatureId} AND hour = ${ts(hour)} AND dim = ${d.dim} AND value = ${d.value} RETURNING 1`,
      sql`INSERT INTO error_hourly_dims (signature_id, hour, dim, value, count) VALUES (${signatureId}, ${ts(hour)}, ${d.dim}, ${d.value}, ${d.count})
        ON CONFLICT (signature_id, hour, dim, value) DO UPDATE SET count = error_hourly_dims.count + excluded.count`)
  }

  // Full events: a new signature's first occurrence, then at most storedPerSignatureDay a day, within every budget
  const candidates = group.filter((r) => !r.repeat && r.expected !== 'overflow').slice(0, ERROR_BUDGETS.storedPerSignatureDay)
  if (!candidates.length) return
  const day = hour.toISOString().slice(0, 10)
  const [slot] = rowsOf<{ before: number; after: number }>(await db.execute(sql`
    WITH old AS (SELECT CASE WHEN stored_day = ${day}::date THEN stored_today ELSE 0 END AS n FROM error_signatures WHERE id = ${signatureId} FOR UPDATE)
    UPDATE error_signatures s SET stored_day = ${day}::date, stored_today = LEAST(old.n + ${candidates.length}, ${ERROR_BUDGETS.storedPerSignatureDay})
    FROM old WHERE s.id = ${signatureId}
    RETURNING old.n AS before, s.stored_today AS after`))
  let keep = slot ? Number(slot.after) - Number(slot.before) : 0
  if (isNew && keep < 1) keep = 1
  for (const r of candidates.slice(0, keep)) {
    if (!takeStoredEvent(r.ipKey, r.receivedAt.getTime(), trustOf(r)) || !budget.takeFor('events', 1, trustOf(r))) continue
    const e = boundRecord(r)
    try {
      await db.execute(sql`
        INSERT INTO error_events (signature_id, occurred_at, received_at, source, kind, release, route, method, path, status, request_id,
          browser, os, user_hash, org_id, scene_id, count, user_facing, error_type, message, stack, error_body, breadcrumbs)
        VALUES (${signatureId}, ${ts(e.occurredAt)}, ${ts(e.receivedAt)}, ${e.source}, ${e.kind}, ${e.release}, ${e.route}, ${e.method},
          ${e.path}, ${e.status}, ${e.requestId}, ${e.browser}, ${e.os}, ${e.userHash}, ${e.orgId}, ${e.sceneId}, ${e.count},
          ${e.userFacing}, ${e.errorType}, ${e.message}, ${e.stack},
          ${e.errorBody == null ? null : JSON.stringify(e.errorBody)}::jsonb, ${e.breadcrumbs ? JSON.stringify(e.breadcrumbs) : null}::jsonb)`)
    } catch (err) {
      console.error('[errors] storing an error event failed:', err instanceof Error ? err.message : err)
    }
  }
}

/**
 * Admits records to signatures: a known signature always; a new browser one only within the address and instance
 * budgets and under the cap on recently seen browser signatures; a server one always. The rest become overflow
 * records. Returns the known signatures' ids by hash.
 */
async function admit(records: ErrorRecord[]): Promise<{ records: ErrorRecord[]; fresh: Set<string>; existing: Map<string, string> }> {
  const hashes = [...new Set(records.map((r) => r.hash))]
  const existing = new Map(rowsOf<{ hash: string; id: string }>(await db.execute(sql`
    SELECT hash, id FROM error_signatures WHERE hash IN (${sql.join(hashes.map((h) => sql`${h}`), sql`, `)})`)).map((r) => [r.hash, r.id]))
  const counts = await signatureCount()
  let total = counts.n
  let anon = counts.anon
  const fresh = new Set<string>()
  const out: ErrorRecord[] = []
  for (const r of records) {
    if (existing.has(r.hash) || fresh.has(r.hash) || r.expected === 'overflow' || r.source === 'server') {
      if (r.source === 'server' && !existing.has(r.hash)) fresh.add(r.hash)
      out.push(r)
      continue
    }
    // Anonymous browsers may fill only their share of the cap; signed-in users the rest
    const trust = trustOf(r)
    const room = total < ERROR_BUDGETS.maxSignatures && (trust !== 'anon' || anon < anonLimit(ERROR_BUDGETS.maxSignatures))
    if (room && takeNewSignature(r.ipKey, r.receivedAt.getTime(), trust)) {
      fresh.add(r.hash)
      total++
      signatureTotal.n++
      if (trust === 'anon') { anon++; signatureTotal.anon++ }
      out.push(r)
    } else {
      out.push(overflowRecord(r))
    }
  }
  return { records: out, fresh, existing }
}

const groupBy = <T>(xs: T[], key: (x: T) => string | number) => {
  const m = new Map<string | number, T[]>()
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x])
  return m
}

/** Counted-only records (overflow): the signature's total and its hourly count, nothing else. */
async function writeOverflow(records: ErrorRecord[], ids: Map<string, string>): Promise<void> {
  for (const [hash, group] of groupBy(records.map((r) => (r.expected === 'overflow' ? r : overflowRecord(r))), (r) => r.hash)) {
    try {
      const id = await writeSignature(group as ErrorRecord[])
      ids.set(hash as string, id)
      for (const [h, g] of groupBy(group as ErrorRecord[], (r) => hourOf(r.receivedAt).getTime())) {
        const n = g.reduce((a, r) => a + r.count, 0)
        await db.execute(sql`
          INSERT INTO error_hourly (signature_id, hour, count) VALUES (${id}, ${ts(new Date(h as number))}, ${n})
          ON CONFLICT (signature_id, hour) DO UPDATE SET count = error_hourly.count + excluded.count`)
      }
    } catch (err) {
      console.error('[errors] writing an overflow count failed:', err instanceof Error ? err.message : err)
    }
  }
}

/**
 * Writes records now. Returns each written signature's id by hash. One failing signature or event is logged and
 * skipped. Rows are made only within the day's budgets (DayBudget, shared by every instance); what doesn't fit is
 * counted in the overflow signature.
 */
export async function writeRecords(records: ErrorRecord[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  if (!records.length) return ids
  const known = await knownReleases()
  const { records: admitted, fresh, existing } = await admit(records.map((r) => clampWeb(r, known)))
  const shKeys = admitted.filter((r) => r.source === 'web' && r.ipHash && r.expected !== 'overflow').map((r) => `sh:${r.ipHash}`)
  const budget = await DayBudget.load([...(['events', 'hourly', 'dims', 'users'] as const).flatMap((k) => [k, `anon:${k}`, `server:${k}`]), ...shKeys])
  const folded: ErrorRecord[] = []
  const touched = new Set<string>()

  for (const [hash, group] of groupBy(admitted, (r) => r.hash)) {
    if (group[0].expected === 'overflow') { folded.push(...group); continue }
    try {
      const known = existing.get(hash as string) ?? null
      const plan: Array<[Date, ErrorRecord[]]> = []
      for (const [h, g] of groupBy(group, (r) => hourOf(r.receivedAt).getTime())) {
        const hour = new Date(h as number)
        const ipHashes = [...new Set(g.map((r) => r.ipHash).filter((x): x is string => !!x))]
        const present = known && ipHashes.length ? new Set(rowsOf<{ user_hash: string }>(await db.execute(sql`
          SELECT user_hash FROM error_hourly_users WHERE signature_id = ${known} AND hour = ${ts(hour)}
            AND user_hash IN (${sql.join(ipHashes.map((x) => sql`${x}`), sql`, `)})`)).map((r) => r.user_hash)) : new Set<string>()
        // An address touching a signature-hour it hasn't yet today uses one of its signature-hours for the day
        const keep: ErrorRecord[] = []
        for (const r of g) {
          const t = r.ipHash ? `${hash}|${h}|${r.ipHash}` : ''
          // Signed-in users and server records aren't held to an address's signature-hours
          if (r.source !== 'web' || r.userHash || !r.ipHash || present.has(r.ipHash) || touched.has(t)) { keep.push(r); continue }
          if (budget.take(`sh:${r.ipHash}`, 1, ERROR_BUDGETS.signatureHoursPerIpDay)) { touched.add(t); keep.push(r) } else folded.push(r)
        }
        if (!keep.length) continue
        const hourExists = known ? rowsOf(await db.execute(sql`SELECT 1 FROM error_hourly WHERE signature_id = ${known} AND hour = ${ts(hour)}`)).length > 0 : false
        if (!hourExists && !budget.takeFor('hourly', 1, groupTrust(keep))) { folded.push(...keep); continue }
        plan.push([hour, keep])
      }
      if (!plan.length) continue
      const id = await writeSignature(plan.flatMap(([, k]) => k))
      ids.set(hash as string, id)
      let first = fresh.has(hash as string)
      for (const [hour, keep] of plan) {
        await writeHour(id, hour, keep, first, budget)
        first = false
      }
    } catch (err) {
      console.error('[errors] writing an error signature failed:', err instanceof Error ? err.message : err)
    }
  }
  await writeOverflow(folded, ids)
  await budget.save().catch((err) => console.error('[errors] saving the error budget failed:', err instanceof Error ? err.message : err))
  return ids
}

/**
 * The signature a crash report belongs to, without counting it: no new event, no last-seen, no regression, no
 * affected user. A new signature is made only within the same budgets (else the report joins the overflow one).
 */
export async function reportSignature(r: ErrorRecord): Promise<string | null> {
  const { records: [a] } = await admit([clampWeb(r, await knownReleases())])
  await db.execute(sql`
    INSERT INTO error_signatures (hash, signature, source, kind, status, route, error_type, message, expected, first_release, last_release, total_count)
    VALUES (${a.hash}, ${a.signature}, ${a.source}, ${a.kind}, ${a.status}, ${a.routeTemplate}, ${a.errorType}, ${a.normalizedMessage}, ${a.expected},
      ${a.release}, ${a.release}, 0)
    ON CONFLICT (hash) DO NOTHING`)
  const [row] = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM error_signatures WHERE hash = ${a.hash}`))
  return row?.id ?? null
}

let flushing: Promise<void> | null = null

/** Writes everything buffered. A failed write is logged and its records dropped (no retry loop, no self-report). */
export function flushErrors(): Promise<void> {
  if (flushing) return flushing.then(() => flushErrors())
  const batch = buffer
  buffer = []
  if (!batch.length) return Promise.resolve()
  flushing = writeRecords(batch)
    .then(() => {})
    .catch((err) => console.error('[errors] writing error events failed:', err instanceof Error ? err.message : err))
    .finally(() => { flushing = null })
  return flushing
}

/** Test hooks. */
export function resetErrorBuffer(): void { buffer = []; dropped = 0; signatureTotal = { n: 0, anon: 0, at: 0 }; dimValues.clear(); dimTotal = 0; resetIpKeys() }
export const bufferedErrorCount = () => buffer.length
export const droppedErrorCount = () => dropped

/** The interval's tick: skipped while a flush is still running (nothing queues behind it). True when it started one. */
export function flushTick(): boolean {
  if (flushing) return false
  void flushErrors()
  return true
}

let flushTimer: NodeJS.Timeout | null = null
export function startErrorFlusher(ms = config.errorFlushMs): void {
  if (flushTimer || ms <= 0) return
  flushTimer = setInterval(flushTick, ms)
  flushTimer.unref()
}
export function stopErrorFlusher(): void {
  if (flushTimer) clearInterval(flushTimer)
  flushTimer = null
}
