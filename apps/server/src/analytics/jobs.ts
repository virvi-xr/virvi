import { and, eq, gte, isNull, like, lt, lte, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  analyticsCopresenceDaily,
  analyticsDirtyHours,
  analyticsEvents,
  analyticsHeatmapDaily,
  analyticsJobRuns,
  analyticsPositions,
  analyticsRollupHourly,
  analyticsScenes,
  analyticsSessions,
  locationSetups,
  scenes,
} from '../db/schema.js'
import { config } from '../config.js'
import { HEATMAP_BAND_M, HEATMAP_BAND_SLACK_M, feetOffsetM, groundClamped } from '@virvixr/shared'
import { getSubscription, type TierLimits } from '../integrations/stripe.js'
import type { AnalyticsSceneRow } from './registry.js'
import { purgeWalletChallenges } from './claims.js'
import { purgeAuthHandoffCodes } from '../routes/auth-handoff.js'
import { expireStaleUploads } from '../library/scene-library.js'

const HOUR = 3_600_000
const DAY = 86_400_000
/** Date literal for raw sql templates (postgres-js rejects Date params there). */
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`
const rowsOf = <T>(r: unknown) => r as unknown as T[]

/** Run fn only on the server that wins a Postgres advisory lock (no-op elsewhere). */
async function withJobLock<T>(key: number, fn: () => Promise<T>): Promise<T | null> {
  return db.transaction(async (tx) => {
    const [row] = rowsOf<{ locked: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(${key}) as locked`))
    if (!row?.locked) return null
    return fn()
  })
}

export async function runSessionCloseSweep(now = new Date()): Promise<number> {
  const closed = await db
    .update(analyticsSessions)
    .set({ endedAt: sql`${analyticsSessions.lastSeenAt}` })
    .where(and(isNull(analyticsSessions.endedAt), lt(analyticsSessions.lastSeenAt, new Date(now.getTime() - 60_000))))
    .returning({ id: analyticsSessions.id })
  return closed.length
}

async function jsonCounts(query: ReturnType<typeof sql>): Promise<Record<string, number>> {
  const rows = rowsOf<{ k: string | null; n: number }>(await db.execute(query))
  const out: Record<string, number> = {}
  for (const r of rows) if (r.k) out[r.k] = Number(r.n)
  return out
}

export async function rollupHour(sceneId: string, hour: Date): Promise<void> {
  const h0 = hour
  const h1 = new Date(hour.getTime() + HOUR)
  const inHour = sql`scene_id = ${sceneId} and started_at >= ${ts(h0)} and started_at < ${ts(h1)}`

  const [base] = rowsOf<Record<string, number | null>>(
    await db.execute(sql`
      select count(*)::int as sessions,
             count(distinct visitor_hash)::int as unique_visitors,
             count(*) filter (where not is_returning)::int as new_visitors,
             count(*) filter (where is_returning)::int as returning_visitors,
             count(*) filter (where verified)::int as verified_sessions,
             coalesce(round(avg(duration_sec)), 0)::int as dwell_avg,
             coalesce(round(percentile_cont(0.5) within group (order by duration_sec)), 0)::int as dwell_p50,
             coalesce(round(percentile_cont(0.9) within group (order by duration_sec)), 0)::int as dwell_p90
      from analytics_sessions where ${inHour}`),
  )

  const [peak] = rowsOf<{ peak: number }>(
    await db.execute(sql`
      select coalesce(max(c), 0)::int as peak from (
        select m, count(s.id) as c
        from generate_series(${ts(h0)}, ${ts(h1)} - interval '1 minute', interval '1 minute') m
        join analytics_sessions s
          on s.scene_id = ${sceneId}
         and s.last_seen_at >= ${ts(h0)}
         and s.started_at < m + interval '1 minute'
         and coalesce(s.ended_at, s.last_seen_at) >= m
        group by m
      ) x`),
  )

  const evIn = sql`scene_id = ${sceneId} and occurred_at >= ${ts(h0)} and occurred_at < ${ts(h1)}`
  const interactions = await jsonCounts(sql`
    select data->>'target' as k, count(*)::int as n from analytics_events
    where ${evIn} and type = 'interact' and data->>'kind' = 'click'
    group by 1 order by 2 desc limit 100`)
  const emotes = await jsonCounts(sql`
    select data->>'emote' as k, count(*)::int as n from analytics_events where ${evIn} and type = 'emote' group by 1`)
  const countries = await jsonCounts(sql`select country as k, count(*)::int as n from analytics_sessions where ${inHour} group by 1`)
  const platforms = await jsonCounts(sql`select platform as k, count(*)::int as n from analytics_sessions where ${inHour} group by 1`)
  const cameraModes = await jsonCounts(sql`select camera_mode as k, count(*)::int as n from analytics_sessions where ${inHour} group by 1`)

  const videoRows = rowsOf<{ target: string; plays: number; watch: number }>(
    await db.execute(sql`
      select target, count(*) filter (where state = 'play')::int as plays,
             coalesce(round(sum(case when state = 'play' then least(extract(epoch from (next_at - occurred_at)), 3600) end)), 0)::int as watch
      from (
        select data->>'target' as target, data->>'state' as state, occurred_at,
               lead(occurred_at) over (partition by session_id, data->>'target' order by occurred_at, seq) as next_at
        from analytics_events where ${evIn} and type = 'video'
      ) v group by target`),
  )
  const video: Record<string, { plays: number; watchSec: number }> = {}
  for (const v of videoRows) video[v.target] = { plays: Number(v.plays), watchSec: Number(v.watch) }

  const values = {
    sessions: Number(base.sessions),
    uniqueVisitors: Number(base.unique_visitors),
    newVisitors: Number(base.new_visitors),
    returningVisitors: Number(base.returning_visitors),
    verifiedSessions: Number(base.verified_sessions),
    peakConcurrency: Number(peak.peak),
    dwellAvgSec: Number(base.dwell_avg),
    dwellP50Sec: Number(base.dwell_p50),
    dwellP90Sec: Number(base.dwell_p90),
    interactions,
    video,
    emotes,
    countries,
    platforms,
    cameraModes,
  }
  await db
    .insert(analyticsRollupHourly)
    .values({ sceneId, hour: h0, ...values })
    .onConflictDoUpdate({ target: [analyticsRollupHourly.sceneId, analyticsRollupHourly.hour], set: values })
}

/** Advisory lock class for one scene-day rollup (the 710xx keys above are whole-job locks). */
const DAY_LOCK_CLASS = 7105

/** heightBand (@virvixr/shared) in SQL, for a location kind; the constants are code, not input. */
export function heightBandSql(y: ReturnType<typeof sql.raw>, kind: string) {
  const offset = feetOffsetM(kind)
  const raw = sql`floor(round((${y} - ${sql.raw(String(offset))} + ${sql.raw(String(HEATMAP_BAND_SLACK_M))}) * 100) / ${sql.raw(String(HEATMAP_BAND_M * 100))})::int`
  return groundClamped(kind) ? sql`greatest(0, ${raw})` : raw
}

export async function rollupDay(sceneId: string, day: string, now = new Date()): Promise<void> {
  const d0 = new Date(`${day}T00:00:00Z`)
  const d1 = new Date(d0.getTime() + DAY)
  const [loc] = await db.select({ kind: analyticsScenes.kind }).from(analyticsScenes).where(eq(analyticsScenes.id, sceneId))
  const band = heightBandSql(sql.raw('y'), loc?.kind ?? 'parcels')
  await db.transaction(async (tx) => {
    // One rollup of a scene's day at a time (the regular rollups and the height backfill can meet here).
    await tx.execute(sql`select pg_advisory_xact_lock(${DAY_LOCK_CLASS}, hashtext(${`${sceneId}|${day}`}))`)
    await tx.delete(analyticsHeatmapDaily).where(and(eq(analyticsHeatmapDaily.sceneId, sceneId), eq(analyticsHeatmapDaily.day, day)))
    await tx.execute(sql`
      insert into analytics_heatmap_daily (scene_id, day, cell_x, cell_y, cell_z, dwell_sec, visits)
      select ${sceneId}, ${day}::date, floor(x)::int, ${band}, floor(z)::int,
             round(sum(least(coalesce(gap, 3), 15)))::int, count(distinct session_id)::int
      from (
        select session_id, x, y, z,
               extract(epoch from (lead(occurred_at) over (partition by session_id order by occurred_at, seq) - occurred_at)) as gap
        from analytics_positions
        where scene_id = ${sceneId} and occurred_at >= ${ts(d0)} and occurred_at < ${ts(d1)}
          and abs(x) < 32768 and abs(z) < 32768
      ) p
      group by 3, 4, 5`)

    await tx.delete(analyticsCopresenceDaily).where(and(eq(analyticsCopresenceDaily.sceneId, sceneId), eq(analyticsCopresenceDaily.day, day)))
    await tx.execute(sql`
      insert into analytics_copresence_daily (scene_id, day, visitor_a, visitor_b, overlap_sec)
      select ${sceneId}, ${day}::date, va, vb, overlap from (
        select least(a.visitor_hash, b.visitor_hash) as va, greatest(a.visitor_hash, b.visitor_hash) as vb,
               round(sum(extract(epoch from (
                 least(coalesce(a.ended_at, a.last_seen_at), coalesce(b.ended_at, b.last_seen_at)) - greatest(a.started_at, b.started_at)
               ))))::int as overlap
        from analytics_sessions a
        join analytics_sessions b
          on b.scene_id = a.scene_id and a.id < b.id and a.visitor_hash <> b.visitor_hash
         and b.last_seen_at >= ${ts(d0)}
         and a.started_at < coalesce(b.ended_at, b.last_seen_at)
         and b.started_at < coalesce(a.ended_at, a.last_seen_at)
        where a.scene_id = ${sceneId} and a.started_at >= ${ts(d0)} and a.started_at < ${ts(d1)}
        group by 1, 2
      ) x where overlap >= 300 order by overlap desc limit 1000
      on conflict do nothing`)
  })

  await db.execute(sql`
    update analytics_scenes set verified_session_share = coalesce((
      select avg(case when verified then 1.0 else 0.0 end) from analytics_sessions
      where scene_id = ${sceneId} and started_at >= ${ts(new Date(now.getTime() - 7 * DAY))}
    ), 0) where id = ${sceneId}`)
}

type DirtyRow = { sceneId: string; hour: Date }

export async function runRollups(now = new Date()): Promise<{ hours: number; days: number }> {
  // Atomically claim past hours (a concurrent writer re-marking an hour inserts a fresh row
  // that the next run picks up); current-hour rows stay so they are recomputed as data arrives.
  const claimed = rowsOf<{ scene_id: string; hour: Date | string }>(
    await db.execute(sql`
      delete from analytics_dirty_hours where ctid in (
        select ctid from analytics_dirty_hours
        where hour + interval '1 hour' <= ${ts(now)} order by hour limit 500
      ) returning scene_id, hour`),
  ).map((r): DirtyRow => ({ sceneId: r.scene_id, hour: new Date(r.hour) }))
  const current = (await db.select().from(analyticsDirtyHours).where(lte(analyticsDirtyHours.hour, now))).filter(
    (d) => d.hour.getTime() + HOUR > now.getTime(),
  )
  const todo: DirtyRow[] = [...claimed, ...current]
  const days = new Map<string, Set<string>>()
  for (const d of todo) {
    try {
      await rollupHour(d.sceneId, d.hour)
    } catch (err) {
      console.error(`[virvi-server] rollup failed for ${d.sceneId} ${d.hour.toISOString()}:`, err)
      await db.insert(analyticsDirtyHours).values({ sceneId: d.sceneId, hour: d.hour }).onConflictDoNothing()
      continue
    }
    const day = d.hour.toISOString().slice(0, 10)
    if (!days.has(d.sceneId)) days.set(d.sceneId, new Set())
    days.get(d.sceneId)!.add(day)
  }
  let dayCount = 0
  for (const [sceneId, set] of days) {
    for (const day of set) {
      try {
        await rollupDay(sceneId, day, now)
        dayCount++
      } catch (err) {
        console.error(`[virvi-server] rollup failed for ${sceneId} ${day}:`, err)
      }
    }
  }
  return { hours: todo.length, days: dayCount }
}

/** A Virvi scene's plan: its owner's subscription limits; null when the scene is gone. */
export async function planLimitsForScene(virviSceneId: string): Promise<TierLimits | null> {
  const host = await db.query.scenes.findFirst({ where: eq(scenes.id, virviSceneId), columns: { ownerId: true } })
  if (!host) return null
  return (await getSubscription(host.ownerId)).limits
}

/**
 * Whether a location's heatmap shows heights and the 3D view (LIV-85): every self-hosted install with all features
 * unlocked; otherwise the plan of the Virvi scene whose setup the reader reads through (as retention follows the host's).
 */
export async function heatmap3dFor(virviSceneId: string | null | undefined): Promise<boolean> {
  if (config.allFeaturesUnlocked) return true
  if (!virviSceneId) return false
  return (await planLimitsForScene(virviSceneId))?.analyticsHeatmap3d === true
}

export async function retentionDaysFor(scene: AnalyticsSceneRow): Promise<number> {
  if (scene.isPreview) return 7
  const active = await db.query.locationSetups.findFirst({ where: and(eq(locationSetups.analyticsSceneId, scene.id), isNull(locationSetups.endedAt)) })
  if (!active) return 30
  if (config.allFeaturesUnlocked) {
    const host = await db.query.scenes.findFirst({ where: eq(scenes.id, active.virviSceneId), columns: { id: true } })
    return host ? Infinity : 30
  }
  const limits = await planLimitsForScene(active.virviSceneId)
  if (!limits) return 30
  const d = limits.analyticsRetentionDays
  return d === Infinity || (typeof d === 'number' && Number.isFinite(d)) ? d : 30
}

async function deleteOlder(table: 'analytics_events' | 'analytics_positions' | 'analytics_sessions', sceneId: string, cutoff: Date) {
  const col = table === 'analytics_sessions' ? sql.raw('last_seen_at') : sql.raw('occurred_at')
  let total = 0
  for (;;) {
    const rows = rowsOf<{ id: unknown }>(
      await db.execute(sql`
        delete from ${sql.raw(table)} where ctid in (
          select ctid from ${sql.raw(table)} where scene_id = ${sceneId} and ${col} < ${ts(cutoff)} limit 10000
        ) returning 1 as id`),
    )
    total += rows.length
    if (rows.length < 10000) return total
  }
}

export async function runRetention(now = new Date()): Promise<{ deleted: number }> {
  const all = await db.select().from(analyticsScenes)
  let deleted = 0
  for (const scene of all) {
    try {
      const days = await retentionDaysFor(scene)
      if (!Number.isFinite(days)) continue
      const cutoff = new Date(now.getTime() - days * DAY)
      deleted += await deleteOlder('analytics_events', scene.id, cutoff)
      deleted += await deleteOlder('analytics_positions', scene.id, cutoff)
      deleted += await deleteOlder('analytics_sessions', scene.id, cutoff)
    } catch (err) {
      console.error(`[virvi-server] retention failed for ${scene.id}:`, err)
    }
  }
  return { deleted }
}

/** analytics_job_runs name of the once-only height backfill; `<name>:<location id>` rows record progress while it runs. */
export const HEATMAP_BACKFILL_JOB = 'heatmap-height-backfill'

/**
 * Once only (LIV-85): re-run the daily heatmap rollup, which now records floor heights, for every day still fully
 * inside each location's retention, so recent history gets heights. Older days, and the day the retention cutoff
 * falls in (part of its raw positions may be gone), keep their height-less cells. rollupDay replaces a day's cells
 * under a per-day lock, so a rerun or a concurrent rollup changes nothing; the job itself runs under the
 * analytics job lock. Locations that fail are retried on the next run; the job is marked done once none fail.
 * Returns null when it has already run.
 */
export async function runHeatmapHeightBackfill(
  now = new Date(),
  rollup: (sceneId: string, day: string, now?: Date) => Promise<void> = rollupDay,
): Promise<{ scenes: number; days: number; failed: number } | null> {
  const [done] = await db.select().from(analyticsJobRuns).where(eq(analyticsJobRuns.name, HEATMAP_BACKFILL_JOB))
  if (done) return null
  const today = now.toISOString().slice(0, 10)
  const progress = new Set(
    (await db.select({ name: analyticsJobRuns.name }).from(analyticsJobRuns).where(like(analyticsJobRuns.name, `${HEATMAP_BACKFILL_JOB}:%`))).map((r) => r.name),
  )
  let scenesDone = 0
  let days = 0
  let failed = 0
  for (const scene of await db.select().from(analyticsScenes)) {
    const key = `${HEATMAP_BACKFILL_JOB}:${scene.id}`
    if (progress.has(key)) continue
    try {
      const retention = await retentionDaysFor(scene)
      const firstDay = Number.isFinite(retention) ? new Date(Math.ceil((now.getTime() - retention * DAY) / DAY) * DAY) : null
      const rows = rowsOf<{ day: string }>(
        await db.execute(sql`
          select distinct to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD') as day from analytics_positions
          where scene_id = ${scene.id}${firstDay ? sql` and occurred_at >= ${ts(firstDay)}` : sql``}
          order by 1`),
      )
      for (const { day } of rows) {
        await rollup(scene.id, day, now)
        days++
      }
      await db.insert(analyticsJobRuns).values({ name: key, lastRunDay: today }).onConflictDoNothing()
      scenesDone++
    } catch (err) {
      failed++
      console.error(`[virvi-server] heatmap height backfill failed for ${scene.id}:`, err)
    }
  }
  if (!failed) {
    await db.insert(analyticsJobRuns).values({ name: HEATMAP_BACKFILL_JOB, lastRunDay: today }).onConflictDoNothing()
    await db.delete(analyticsJobRuns).where(like(analyticsJobRuns.name, `${HEATMAP_BACKFILL_JOB}:%`))
  }
  return { scenes: scenesDone, days, failed }
}

const dailyJobs: Array<{ name: string; fn: (now: Date) => Promise<unknown> }> = [{ name: 'retention', fn: runRetention }]

export function registerDailyJob(name: string, fn: (now: Date) => Promise<unknown>): void {
  dailyJobs.push({ name, fn })
}

registerDailyJob('wallet-challenge-purge', (now) => purgeWalletChallenges(now))
registerDailyJob('auth-handoff-purge', (now) => purgeAuthHandoffCodes(now))
registerDailyJob('stale-upload-expire', (now) => expireStaleUploads(now))

export function startAnalyticsJobs(): () => void {
  if (!config.analyticsJobsEnabled) return () => {}
  const timers: NodeJS.Timeout[] = []
  const kicks: Array<() => void> = []
  const every = (ms: number, key: number, name: string, fn: () => Promise<unknown>) => {
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        await withJobLock(key, fn)
      } catch (err) {
        console.error(`[virvi-server] analytics job ${name} failed:`, err)
      } finally {
        running = false
      }
    }
    kicks.push(tick)
    const t = setInterval(tick, ms)
    t.unref()
    timers.push(t)
  }
  every(30_000, 71001, 'session-close', () => runSessionCloseSweep())
  every(5 * 60_000, 71002, 'rollups', () => runRollups())
  every(60 * 60_000, 71003, 'daily', () => runDailyJobs())
  // Once only; afterwards each tick is a single lookup of its done record.
  every(60 * 60_000, 71004, 'heatmap-height-backfill', () => runHeatmapHeightBackfill())
  // Kick every job once shortly after boot so restarts never skip a cycle.
  const kick = setTimeout(() => {
    for (const t of kicks) void t()
  }, 30_000)
  kick.unref()
  timers.push(kick)
  return () => timers.forEach((t) => (clearInterval(t), clearTimeout(t)))
}

/** Runs each registered daily job at most once per UTC day (persisted in analytics_job_runs). */
export async function runDailyJobs(now = new Date()): Promise<void> {
  const today = now.toISOString().slice(0, 10)
  for (const job of dailyJobs) {
    const [row] = await db.select().from(analyticsJobRuns).where(eq(analyticsJobRuns.name, job.name))
    if (row && row.lastRunDay >= today) continue
    await job.fn(now)
    await db
      .insert(analyticsJobRuns)
      .values({ name: job.name, lastRunDay: today })
      .onConflictDoUpdate({ target: analyticsJobRuns.name, set: { lastRunDay: today } })
  }
}
