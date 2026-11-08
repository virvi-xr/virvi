import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  errorSignature, expectedReason, normalizeMessage, routeTemplate, redactText, ERROR_LIMITS,
  type Breadcrumb, type ClientErrorEvent, type ErrorKind,
} from '@virvixr/shared'
import { db } from '../db/connection.js'
import { config } from '../config.js'
import { ERROR_BUDGETS, takeNewSignature, takeStoredEvent } from './limits.js'

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

let signatureTotal = { n: 0, at: 0 }
/** How many signatures exist (cached a minute; bumped as this instance adds some). */
async function signatureCount(): Promise<number> {
  if (Date.now() - signatureTotal.at > 60_000) {
    const [row] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM error_signatures`))
    signatureTotal = { n: Number(row.n), at: Date.now() }
  }
  return signatureTotal.n
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

/** Distinct breakdown values seen per signature-hour by this instance (past the cap a value counts as "other"). */
const dimValues = new Map<string, Set<string>>()
let dimHour = 0
function dimValue(signatureId: string, hour: Date, dim: string, value: string): string {
  if (hour.getTime() !== dimHour) { dimHour = hour.getTime(); dimValues.clear() }
  const key = `${signatureId}\u0000${dim}`
  const seen = dimValues.get(key) ?? new Set<string>()
  dimValues.set(key, seen)
  if (seen.has(value)) return value
  if (seen.size >= ERROR_BUDGETS.maxDimValuesPerSignatureHour) return 'other'
  seen.add(value)
  return value
}

async function writeHour(signatureId: string, hour: Date, group: ErrorRecord[], isNew: boolean): Promise<void> {
  const count = group.reduce((n, r) => n + r.count, 0)
  await db.execute(sql`
    INSERT INTO error_hourly (signature_id, hour, count) VALUES (${signatureId}, ${ts(hour)}, ${count})
    ON CONFLICT (signature_id, hour) DO UPDATE SET count = error_hourly.count + excluded.count`)

  // Distinct users (hashed account ids) and distinct addresses (day-salted 'ip:' hashes) that hour
  const hashes = [...new Set(group.flatMap((r) => [r.userHash, r.ipHash]).filter((h): h is string => !!h))]
  if (hashes.length) {
    const added = rowsOf<{ user_hash: string }>(await db.execute(sql`
      INSERT INTO error_hourly_users (signature_id, hour, user_hash)
      VALUES ${sql.join(hashes.map((h) => sql`(${signatureId}, ${ts(hour)}, ${h})`), sql`, `)}
      ON CONFLICT DO NOTHING RETURNING user_hash`))
    const ips = added.filter((a) => a.user_hash.startsWith('ip:')).length
    const users = added.length - ips
    if (added.length) {
      await db.execute(sql`UPDATE error_hourly SET users = users + ${users}, ips = ips + ${ips} WHERE signature_id = ${signatureId} AND hour = ${ts(hour)}`)
    }
  }

  const dims = new Map<string, { dim: string; value: string; count: number }>()
  for (const r of group) {
    const route = r.source === 'web' && r.route ? routeTemplate(r.route) : r.route
    for (const [dim, raw] of [['release', r.release], ['route', route], ['browser', r.browser], ['os', r.os], ['org', r.orgId]] as const) {
      if (!raw) continue
      const value = dimValue(signatureId, hour, dim, raw.slice(0, 200))
      const key = `${dim}\u0000${value}`
      const d = dims.get(key) ?? { dim, value, count: 0 }
      d.count += r.count
      dims.set(key, d)
    }
  }
  for (const d of dims.values()) {
    if (!d.count) continue
    await db.execute(sql`
      INSERT INTO error_hourly_dims (signature_id, hour, dim, value, count) VALUES (${signatureId}, ${ts(hour)}, ${d.dim}, ${d.value}, ${d.count})
      ON CONFLICT (signature_id, hour, dim, value) DO UPDATE SET count = error_hourly_dims.count + excluded.count`)
  }

  // Full events: a new signature's first occurrence, then at most storedPerSignatureDay a day, within the address and instance budgets
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
    if (!takeStoredEvent(r.ipKey)) continue
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
 * Admits records to signatures: a known signature always; a new one only within the address and instance budgets and
 * under the cap on distinct signatures (server-side ones too, under the cap). The rest become overflow records.
 */
async function admit(records: ErrorRecord[]): Promise<{ records: ErrorRecord[]; fresh: Set<string> }> {
  const hashes = [...new Set(records.map((r) => r.hash))]
  const known = new Set(rowsOf<{ hash: string }>(await db.execute(sql`
    SELECT hash FROM error_signatures WHERE hash IN (${sql.join(hashes.map((h) => sql`${h}`), sql`, `)})`)).map((r) => r.hash))
  let total = await signatureCount()
  const fresh = new Set<string>()
  const out: ErrorRecord[] = []
  for (const r of records) {
    if (known.has(r.hash) || fresh.has(r.hash) || r.expected === 'overflow') { out.push(r); continue }
    const ok = total < ERROR_BUDGETS.maxSignatures && (r.source === 'server' || takeNewSignature(r.ipKey, r.receivedAt.getTime()))
    if (ok) {
      fresh.add(r.hash)
      total++
      signatureTotal.n++
      out.push(r)
    } else {
      out.push(overflowRecord(r))
    }
  }
  return { records: out, fresh }
}

/** Writes records now. Returns each written signature's id by hash. One failing signature or event is logged and skipped. */
export async function writeRecords(records: ErrorRecord[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  if (!records.length) return ids
  const { records: admitted, fresh } = await admit(records)
  const bySig = new Map<string, ErrorRecord[]>()
  for (const r of admitted) bySig.set(r.hash, [...(bySig.get(r.hash) ?? []), r])
  for (const [hash, group] of bySig) {
    try {
      const id = await writeSignature(group)
      ids.set(hash, id)
      const byHour = new Map<number, ErrorRecord[]>()
      for (const r of group) {
        const h = hourOf(r.receivedAt).getTime()
        byHour.set(h, [...(byHour.get(h) ?? []), r])
      }
      let first = fresh.has(hash)
      for (const [h, g] of byHour) {
        await writeHour(id, new Date(h), g, first)
        first = false
      }
    } catch (err) {
      console.error('[errors] writing an error signature failed:', err instanceof Error ? err.message : err)
    }
  }
  return ids
}

/**
 * The signature a crash report belongs to, without counting it: no new event, no last-seen, no regression, no
 * affected user. A new signature is made only within the same budgets (else the report joins the overflow one).
 */
export async function reportSignature(r: ErrorRecord): Promise<string | null> {
  const { records: [a] } = await admit([r])
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
export function resetErrorBuffer(): void { buffer = []; dropped = 0; signatureTotal = { n: 0, at: 0 }; dimValues.clear() }
export const bufferedErrorCount = () => buffer.length
export const droppedErrorCount = () => dropped

let flushTimer: NodeJS.Timeout | null = null
export function startErrorFlusher(ms = config.errorFlushMs): void {
  if (flushTimer || ms <= 0) return
  flushTimer = setInterval(() => { void flushErrors() }, ms)
  flushTimer.unref()
}
export function stopErrorFlusher(): void {
  if (flushTimer) clearInterval(flushTimer)
  flushTimer = null
}
