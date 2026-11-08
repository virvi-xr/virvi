import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  errorSignature, expectedReason, normalizeMessage, routeTemplate, redactText, ERROR_LIMITS,
  type Breadcrumb, type ClientErrorEvent, type ErrorKind,
} from '@virvixr/shared'
import { db } from '../db/connection.js'
import { config } from '../config.js'

/**
 * The error recorder (LIV-66). Requests and jobs only push into an in-memory buffer; a flusher writes it every
 * ERROR_FLUSH_MS as a few upserts per signature and hour (src/index.ts starts it). Every first occurrence is stored in
 * full; after SAMPLE_PER_HOUR stored events a signature's hour is only counted. Writes are additive, so several server
 * instances can flush at once. Nothing here throws to its caller: a reporting failure is logged and dropped.
 */

/** Raw events stored per signature per hour; the rest of that hour is counted only. */
export const SAMPLE_PER_HOUR = 5
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
    count: e.count ?? 1,
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
      errorType: err.name || 'Error',
      message: redactText(err.message ?? '').slice(0, ERROR_LIMITS.maxMessage),
      stack: err.stack ? redactText(err.stack).slice(0, ERROR_LIMITS.maxStack) : null,
    }
  }
  return { errorType: 'Error', message: redactText(String(err)).slice(0, ERROR_LIMITS.maxMessage), stack: null }
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

// ── Flushing ───────────────────────────────────────────────────────────────

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`
const rowsOf = <T>(r: unknown) => r as unknown as T[]
const hourOf = (d: Date) => new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS)

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

async function writeHour(signatureId: string, hour: Date, group: ErrorRecord[]): Promise<void> {
  const count = group.reduce((n, r) => n + r.count, 0)
  await db.execute(sql`
    INSERT INTO error_hourly (signature_id, hour, count) VALUES (${signatureId}, ${ts(hour)}, ${count})
    ON CONFLICT (signature_id, hour) DO UPDATE SET count = error_hourly.count + excluded.count`)

  const hashes = [...new Set(group.map((r) => r.userHash).filter((h): h is string => !!h))]
  if (hashes.length) {
    const added = rowsOf<{ user_hash: string }>(await db.execute(sql`
      INSERT INTO error_hourly_users (signature_id, hour, user_hash)
      VALUES ${sql.join(hashes.map((h) => sql`(${signatureId}, ${ts(hour)}, ${h})`), sql`, `)}
      ON CONFLICT DO NOTHING RETURNING user_hash`))
    if (added.length) {
      await db.execute(sql`UPDATE error_hourly SET users = users + ${added.length} WHERE signature_id = ${signatureId} AND hour = ${ts(hour)}`)
    }
  }

  const dims = new Map<string, { dim: string; value: string; count: number }>()
  for (const r of group) {
    for (const [dim, value] of [['release', r.release], ['route', r.route], ['browser', r.browser], ['os', r.os], ['org', r.orgId]] as const) {
      if (!value) continue
      const key = `${dim}\u0000${value}`
      const d = dims.get(key) ?? { dim, value: value.slice(0, 200), count: 0 }
      d.count += r.count
      dims.set(key, d)
    }
  }
  for (const d of dims.values()) {
    if (!d.count) continue // a report's own event counts nothing
    await db.execute(sql`
      INSERT INTO error_hourly_dims (signature_id, hour, dim, value, count) VALUES (${signatureId}, ${ts(hour)}, ${d.dim}, ${d.value}, ${d.count})
      ON CONFLICT (signature_id, hour, dim, value) DO UPDATE SET count = error_hourly_dims.count + excluded.count`)
  }

  // Sampling: reserve up to SAMPLE_PER_HOUR stored slots for this hour, then store that many full events
  const candidates = group.filter((r) => !r.repeat).slice(0, SAMPLE_PER_HOUR)
  if (!candidates.length) return
  const [slot] = rowsOf<{ before: number; after: number }>(await db.execute(sql`
    WITH old AS (SELECT stored FROM error_hourly WHERE signature_id = ${signatureId} AND hour = ${ts(hour)} FOR UPDATE)
    UPDATE error_hourly h SET stored = LEAST(h.stored + ${candidates.length}, ${SAMPLE_PER_HOUR})
    FROM old WHERE h.signature_id = ${signatureId} AND h.hour = ${ts(hour)}
    RETURNING old.stored AS before, h.stored AS after`))
  const keep = slot ? Number(slot.after) - Number(slot.before) : 0
  for (const r of candidates.slice(0, keep)) {
    await db.execute(sql`
      INSERT INTO error_events (signature_id, occurred_at, received_at, source, kind, release, route, method, path, status, request_id,
        browser, os, user_hash, org_id, scene_id, count, user_facing, error_type, message, stack, error_body, breadcrumbs)
      VALUES (${signatureId}, ${ts(r.occurredAt)}, ${ts(r.receivedAt)}, ${r.source}, ${r.kind}, ${r.release}, ${r.route}, ${r.method},
        ${r.path}, ${r.status}, ${r.requestId}, ${r.browser}, ${r.os}, ${r.userHash}, ${r.orgId}, ${r.sceneId}, ${r.count},
        ${r.userFacing}, ${r.errorType}, ${r.message}, ${r.stack},
        ${r.errorBody == null ? null : JSON.stringify(r.errorBody)}::jsonb, ${r.breadcrumbs ? JSON.stringify(r.breadcrumbs) : null}::jsonb)`)
  }
}

/** Writes one signature's records now (the report endpoint uses this so a description finds its signature). */
export async function writeRecords(records: ErrorRecord[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  const bySig = new Map<string, ErrorRecord[]>()
  for (const r of records) bySig.set(r.hash, [...(bySig.get(r.hash) ?? []), r])
  for (const [hash, group] of bySig) {
    const id = await writeSignature(group)
    ids.set(hash, id)
    const byHour = new Map<number, ErrorRecord[]>()
    for (const r of group) {
      const h = hourOf(r.receivedAt).getTime()
      byHour.set(h, [...(byHour.get(h) ?? []), r])
    }
    for (const [h, g] of byHour) await writeHour(id, new Date(h), g)
  }
  return ids
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
export function resetErrorBuffer(): void { buffer = []; dropped = 0 }
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
