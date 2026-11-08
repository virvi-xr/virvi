import { sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { purgeScreenshots } from './reports.js'

/** Raw error events, per-hour user hashes and breakdowns are kept this long. */
export const RAW_DAYS = 30
/** Per-signature hourly counts and user reports are kept this long. */
export const COUNT_DAYS = 400
/** Address markers ('ip:…'), their day keys and the daily budgets are kept this long. */
export const ADDRESS_DAYS = 2

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`
const n = (r: unknown) => (r as { count?: number }).count ?? (r as unknown[]).length ?? 0

/** Deletes what is past its retention. Idempotent, so any instance may run it (jobs.ts runs it under a lock). */
export async function purgeErrors(now = new Date()) {
  const raw = new Date(now.getTime() - RAW_DAYS * 86_400_000)
  const counts = new Date(now.getTime() - COUNT_DAYS * 86_400_000)
  const address = new Date(now.getTime() - ADDRESS_DAYS * 86_400_000)
  const keepFrom = new Date(now.getTime() - (ADDRESS_DAYS - 1) * 86_400_000).toISOString().slice(0, 10) // today and yesterday
  const events = n(await db.execute(sql`DELETE FROM error_events WHERE received_at < ${ts(raw)}`))
  const users = n(await db.execute(sql`DELETE FROM error_hourly_users WHERE hour < ${ts(raw)} OR (user_hash LIKE 'ip:%' AND hour < ${ts(address)})`))
  await db.execute(sql`DELETE FROM error_hourly_dims WHERE hour < ${ts(raw)}`)
  // A day's address key goes once its markers are gone: the markers can no longer be traced or linked
  await db.execute(sql`DELETE FROM error_ip_keys WHERE day < ${keepFrom}::date`)
  await db.execute(sql`DELETE FROM error_budget WHERE day < ${keepFrom}::date`)
  await db.execute(sql`DELETE FROM error_releases WHERE seen_at < ${ts(new Date(now.getTime() - 90 * 86_400_000))}`)
  const hours = n(await db.execute(sql`DELETE FROM error_hourly WHERE hour < ${ts(counts)}`))
  // Screenshots go after 30 days (the reports stay), and before a report goes, its screenshot
  await purgeScreenshots(now).catch((err) => console.error('[errors] purging report screenshots failed:', err instanceof Error ? err.message : err))
  await db.execute(sql`DELETE FROM error_reports WHERE created_at < ${ts(counts)} AND screenshot_key IS NULL`)
  // "We know about this" marks hold an account hash: kept 30 days like the others (then it may show once more)
  await db.execute(sql`DELETE FROM error_prompt_known WHERE shown_at < ${ts(raw)}`)
  // Browser signatures only anonymous addresses ever hit, never filed or reported, go after 30 quiet days (with their rows)
  const anonymous = n(await db.execute(sql`
    DELETE FROM error_signatures WHERE source = 'web' AND NOT seen_users AND linear_issue_id IS NULL AND user_reports = 0
      AND last_seen_at < ${ts(raw)}`))
  // Any signature quiet for the whole count window goes too, unless a Linear issue points at it
  const signatures = n(await db.execute(sql`DELETE FROM error_signatures WHERE last_seen_at < ${ts(counts)} AND linear_issue_id IS NULL`))
  return { events, users, hours, signatures: signatures + anonymous }
}
