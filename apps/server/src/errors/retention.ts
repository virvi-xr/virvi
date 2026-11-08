import { sql } from 'drizzle-orm'
import { db } from '../db/connection.js'

/** Raw error events and per-hour user hashes are kept this long. */
export const RAW_DAYS = 30
/** Per-signature hourly counts, breakdowns and user reports are kept this long. */
export const COUNT_DAYS = 400

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`
const n = (r: unknown) => (r as { count?: number }).count ?? (r as unknown[]).length ?? 0

/** Deletes what is past its retention. Idempotent, so any instance may run it (jobs.ts runs it under a lock). */
export async function purgeErrors(now = new Date()) {
  const raw = new Date(now.getTime() - RAW_DAYS * 86_400_000)
  const counts = new Date(now.getTime() - COUNT_DAYS * 86_400_000)
  const events = n(await db.execute(sql`DELETE FROM error_events WHERE received_at < ${ts(raw)}`))
  const users = n(await db.execute(sql`DELETE FROM error_hourly_users WHERE hour < ${ts(raw)}`))
  const hours = n(await db.execute(sql`DELETE FROM error_hourly WHERE hour < ${ts(counts)}`))
  await db.execute(sql`DELETE FROM error_hourly_dims WHERE hour < ${ts(counts)}`)
  await db.execute(sql`DELETE FROM error_reports WHERE created_at < ${ts(counts)}`)
  // A signature quiet for the whole count window goes too, unless a Linear issue points at it
  const signatures = n(await db.execute(sql`DELETE FROM error_signatures WHERE last_seen_at < ${ts(counts)} AND linear_issue_id IS NULL`))
  return { events, users, hours, signatures }
}
