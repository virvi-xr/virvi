import { eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsJobRuns } from '../db/schema.js'

/** analytics_job_runs row holding the last day summarized (its lastRunDay). */
export const AD_SUMMARIES_THROUGH = 'ad-summaries:through'

const DAY = 86_400_000

/** The last UTC day whose ad views are in the summaries, or null when none are. */
export async function adSummariesThrough(): Promise<string | null> {
  const [row] = await db.select().from(analyticsJobRuns).where(eq(analyticsJobRuns.name, AD_SUMMARIES_THROUGH))
  return row?.lastRunDay ?? null
}

/**
 * Summarize every closed day not yet summarized (LIV-190). A day is closed once a whole further day has passed, so the
 * day before yesterday is the newest one written: events carry the server's UTC day, and the lag covers anything still
 * in flight at midnight. Each day is written once; the delete makes a re-run after a failed commit harmless.
 */
export async function summarizeAdDays(now = new Date()): Promise<{ through: string }> {
  const target = new Date(now.getTime() - 2 * DAY).toISOString().slice(0, 10)
  return db.transaction(async (tx) => {
    // One run at a time: a second waits here and then finds the days already done
    await tx.execute(sql`select pg_advisory_xact_lock(71190)`)
    const [row] = await tx.select().from(analyticsJobRuns).where(eq(analyticsJobRuns.name, AD_SUMMARIES_THROUGH))
    const from = row?.lastRunDay ?? null
    if (from && from >= target) return { through: from }
    const after = from ?? '0001-01-01'
    await tx.execute(sql`delete from ad_daily_space where day > ${after}::date and day <= ${target}::date`)
    await tx.execute(sql`delete from ad_daily_viewers where day > ${after}::date and day <= ${target}::date`)
    await tx.execute(sql`
      insert into ad_daily_space (ad_id, element_id, scene_id, day, level, verified, views, look_ms_sum, look_count)
      select ad_id, element_id, scene_id, day, level, verified, count(*)::int,
             coalesce(sum(dwell_ms) filter (where level = 'look' and verified), 0)::bigint,
             (count(dwell_ms) filter (where level = 'look' and verified))::int
        from ad_events
       where day > ${after}::date and day <= ${target}::date
       group by ad_id, element_id, scene_id, day, level, verified`)
    await tx.execute(sql`
      insert into ad_daily_viewers (ad_id, day, level, verified, viewers)
      select ad_id, day, level, verified, count(distinct viewer_key)::int
        from ad_events
       where day > ${after}::date and day <= ${target}::date
       group by ad_id, day, level, verified`)
    await tx
      .insert(analyticsJobRuns)
      .values({ name: AD_SUMMARIES_THROUGH, lastRunDay: target })
      .onConflictDoUpdate({ target: analyticsJobRuns.name, set: { lastRunDay: target } })
    return { through: target }
  })
}

/** How long raw ad views are kept (LIV-167, owner decision 2026-11-18). Summaries are kept forever. */
export const AD_VIEW_RETENTION_MONTHS = 13

/** The first UTC day still kept on `now`: the same calendar day, 13 months back. */
export function adRetentionCutoff(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - AD_VIEW_RETENTION_MONTHS, 1))
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(now.getUTCDate(), lastDay))
  return d.toISOString().slice(0, 10)
}

/**
 * Delete raw ad views older than the retention period (LIV-167), only for days already in the summaries, so reports
 * never lose a number. Runs after summarizeAdDays in the daily jobs; batched so a long backlog doesn't hold locks.
 */
export async function purgeOldAdViews(now = new Date()): Promise<{ deleted: number }> {
  const through = await adSummariesThrough()
  if (!through) return { deleted: 0 }
  const cutoff = adRetentionCutoff(now)
  let deleted = 0
  for (;;) {
    const rows = (await db.execute(sql`
      delete from ad_events where id in (
        select id from ad_events where day < ${cutoff}::date and day <= ${through}::date limit 10000
      ) returning 1 as x`)) as unknown as unknown[]
    deleted += rows.length
    if (rows.length < 10000) return { deleted }
  }
}
