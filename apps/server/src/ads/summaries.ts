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
