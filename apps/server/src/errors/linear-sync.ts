import { sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { getLinearClient, isTransientLinearError, linearPaused, noteLinearTransient, type LinearClient, type LinearIssueState } from './linear.js'
import { getThresholds } from './settings.js'

/**
 * Reading Done back from Linear (LIV-66 phase 2). With filing on, jobs.ts runs this every 10 minutes under an advisory
 * lock (one instance at a time). A signature whose issue was completed (Done) is marked fixed, as the Errors
 * page's Mark fixed does, so its next event is a regression (and the filing pass notes it on the issue). An issue completed before the
 * signature's last regression, or one already applied, doesn't mark it fixed again; reopening an issue in Linear
 * un-marks a signature that Linear (not an admin) had marked fixed. A Canceled, Won't fix or Duplicate issue lets go
 * of the link without marking anything fixed, so a new issue can be filed later. It honours the filing backoff.
 */

export const DONE_SYNC_EVERY_MS = 10 * 60_000
const BATCH = 50
/** Issues read per run: the most recently seen signatures first. */
const MAX_PER_RUN = 1000

const rowsOf = <T>(r: unknown) => r as unknown as T[]
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`

export interface DoneSyncResult { checked: number; resolved: number; reopened: number; unlinked: number; skipped?: 'not_configured' | 'off' | 'backoff' }

export async function syncLinearDone(now = new Date(), client: LinearClient | null = getLinearClient()): Promise<DoneSyncResult> {
  const none = { checked: 0, resolved: 0, reopened: 0, unlinked: 0 }
  if (!client) return { ...none, skipped: 'not_configured' }
  if (!(await getThresholds()).filing) return { ...none, skipped: 'off' }
  // The same backoff as the filing pass: after a rate limit, an outage or a refused key, wait
  if (linearPaused(now.getTime())) return { ...none, skipped: 'backoff' }
  const rows = rowsOf<{ id: string; issue: string; resolved_at: string | null; resolved_by: string | null; regressed_at: string | null; linear_done_at: string | null }>(await db.execute(sql`
    SELECT id, linear_issue_id AS issue, resolved_at, resolved_by, regressed_at, linear_done_at FROM error_signatures
    WHERE linear_issue_id IS NOT NULL AND (resolved_at IS NULL OR (linear_done_at IS NOT NULL AND resolved_by IS NULL))
    ORDER BY last_seen_at DESC LIMIT ${MAX_PER_RUN}`))
  const result: DoneSyncResult = { ...none }
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    let found: LinearIssueState[]
    try {
      found = await client.issueStates(batch.map((r) => r.issue))
    } catch (err) {
      if (isTransientLinearError(err)) noteLinearTransient(now.getTime())
      console.error('[errors] reading issue states from Linear failed:', err instanceof Error ? err.message : err)
      return result
    }
    const states = new Map(found.map((s) => [s.id, s]))
    for (const r of batch) {
      const s = states.get(r.issue)
      if (!s) continue // gone from Linear: left as it is
      result.checked++
      // Canceled, Won't fix or Duplicate: the issue is closed but nothing was fixed. The link is let go (so the data
      // can file a new issue later) and the signature is not marked fixed, so no "regression" note follows
      if (s.stateType === 'canceled') {
        const un = rowsOf<{ id: string }>(await db.execute(sql`
          UPDATE error_signatures SET linear_issue_id = NULL, linear_issue_key = NULL, linear_issue_url = NULL, linear_filed_at = NULL,
            linear_filed_reason = NULL, linear_commented_at = NULL, linear_quiet_at = NULL, linear_regression_at = NULL, linear_done_at = NULL
          WHERE id = ${r.id}::uuid AND linear_issue_id = ${r.issue} RETURNING id`))
        result.unlinked += un.length
        continue
      }
      // Only Done marks it fixed
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
