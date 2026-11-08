import { sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { getLinearClient, type LinearClient } from './linear.js'
import { getThresholds } from './settings.js'

/**
 * Reading Done back from Linear (LIV-66 phase 2). With filing on, jobs.ts runs this every 10 minutes under an advisory
 * lock (one instance at a time). A signature whose issue was completed is marked fixed, as the Errors page's Mark fixed
 * does, so its next event is a regression (and the filing pass notes it on the issue). An issue completed before the
 * signature's last regression, or one already applied, doesn't mark it fixed again; reopening an issue in Linear
 * un-marks a signature that Linear (not an admin) had marked fixed.
 */

export const DONE_SYNC_EVERY_MS = 10 * 60_000
const BATCH = 50
/** Issues read per run: the most recently seen signatures first. */
const MAX_PER_RUN = 1000

const rowsOf = <T>(r: unknown) => r as unknown as T[]
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`

export interface DoneSyncResult { checked: number; resolved: number; reopened: number; skipped?: 'not_configured' | 'off' }

export async function syncLinearDone(now = new Date(), client: LinearClient | null = getLinearClient()): Promise<DoneSyncResult> {
  if (!client) return { checked: 0, resolved: 0, reopened: 0, skipped: 'not_configured' }
  if (!(await getThresholds()).filing) return { checked: 0, resolved: 0, reopened: 0, skipped: 'off' }
  const rows = rowsOf<{ id: string; issue: string; resolved_at: string | null; resolved_by: string | null; regressed_at: string | null; linear_done_at: string | null }>(await db.execute(sql`
    SELECT id, linear_issue_id AS issue, resolved_at, resolved_by, regressed_at, linear_done_at FROM error_signatures
    WHERE linear_issue_id IS NOT NULL AND (resolved_at IS NULL OR (linear_done_at IS NOT NULL AND resolved_by IS NULL))
    ORDER BY last_seen_at DESC LIMIT ${MAX_PER_RUN}`))
  const result: DoneSyncResult = { checked: 0, resolved: 0, reopened: 0 }
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const states = new Map((await client.issueStates(batch.map((r) => r.issue))).map((s) => [s.id, s]))
    for (const r of batch) {
      const s = states.get(r.issue)
      if (!s) continue // gone from Linear: left as it is
      result.checked++
      const completedAt = s.stateType === 'completed' && s.completedAt ? new Date(s.completedAt) : null
      if (completedAt && !r.resolved_at) {
        // Each completion is applied once (an admin's Undo or a regression isn't overridden by the same one), and only
        // if it came after the last regression. Fixed from now, so a later event is a regression
        if (r.linear_done_at && completedAt.getTime() <= new Date(r.linear_done_at).getTime()) continue
        if (r.regressed_at && completedAt.getTime() <= new Date(r.regressed_at).getTime()) continue
        const done = rowsOf<{ id: string }>(await db.execute(sql`
          UPDATE error_signatures SET resolved_at = ${ts(now)}, resolved_by = NULL, regressed_at = NULL, linear_done_at = ${ts(completedAt)}
          WHERE id = ${r.id}::uuid AND resolved_at IS NULL RETURNING id`))
        result.resolved += done.length
      } else if (!completedAt && r.resolved_at && r.linear_done_at && !r.resolved_by) {
        const reopened = rowsOf<{ id: string }>(await db.execute(sql`
          UPDATE error_signatures SET resolved_at = NULL, linear_done_at = NULL
          WHERE id = ${r.id}::uuid AND resolved_by IS NULL AND linear_done_at IS NOT NULL RETURNING id`))
        result.reopened += reopened.length
      }
    }
  }
  return result
}
