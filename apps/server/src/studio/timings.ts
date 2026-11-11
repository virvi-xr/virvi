import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioJobs, type JobTimings } from '../db/schema.js'
import type { Exec } from './quota.js'

/**
 * How long a prompt waits for its first reply (`studio_jobs.timings`), filled in as the job goes: how its machine was
 * got (startWorker), when it was taken (jobs/next), the worker's phases and boot, its first progress line the page
 * shows, and when it finished. Only prompt jobs, and every write is conditional, so a repeat changes nothing. Ids and
 * seconds only: never the prompt or the reply.
 */

export type MachineAction = NonNullable<JobTimings['machine']>
export type TimedStep = 'screening' | 'building' | 'firstProgress'

/** Seconds from the job's creation to `at`, to a tenth. */
const since = (at: Date | ReturnType<typeof sql>) =>
  sql`round(extract(epoch from (${at instanceof Date ? sql`${at.toISOString()}::timestamptz` : at} - ${studioJobs.createdAt}))::numeric, 1)`

const merge = (add: ReturnType<typeof sql>) => sql`coalesce(${studioJobs.timings}, '{}'::jsonb) || ${add}`

/** The SQL that adds `taken` to a prompt job's timings, for the statement that hands the job out. */
export const takenTimings = sql`CASE WHEN type = 'prompt' THEN coalesce(timings, '{}'::jsonb)
  || jsonb_build_object('taken', round(extract(epoch from (now() - created_at))::numeric, 1)) ELSE timings END`

export async function recordMachine(jobId: string, machine: MachineAction, exec: Exec = db): Promise<void> {
  await exec.update(studioJobs).set({ timings: merge(sql`jsonb_build_object('machine', ${machine}::text)`) })
    .where(and(eq(studioJobs.id, jobId), eq(studioJobs.type, 'prompt')))
}

/** A step's first time only. */
export async function recordStep(jobId: string, step: TimedStep, now: Date): Promise<void> {
  const t = sql`coalesce(${studioJobs.timings}, '{}'::jsonb)`
  await db.update(studioJobs).set({ timings: merge(sql`jsonb_build_object(${step}::text, ${since(now)})`) })
    .where(and(
      eq(studioJobs.id, jobId), eq(studioJobs.type, 'prompt'), eq(studioJobs.status, 'taken'),
      sql`NOT (${t} ? ${step})`,
    ))
}

export async function recordBoot(jobId: string, seconds: number, restored: boolean): Promise<void> {
  const t = sql`coalesce(${studioJobs.timings}, '{}'::jsonb)`
  await db.update(studioJobs)
    .set({ timings: merge(sql`jsonb_build_object('boot', round(${seconds}::numeric, 1), 'restored', ${restored}::boolean)`) })
    .where(and(eq(studioJobs.id, jobId), eq(studioJobs.type, 'prompt'), sql`NOT (${t} ? 'boot')`))
}

/** The finish log line: ids and seconds only. */
export function timingLine(jobId: string, t: JobTimings): string {
  const s = (k: keyof JobTimings, label: string = k) => typeof t[k] === 'number' ? ` ${label}=${Math.round(t[k] as number)}s` : ''
  return `[studio] job ${jobId} timing: machine=${t.machine ?? 'unknown'}`
    + s('taken') + s('boot') + s('screening') + s('building') + s('firstProgress', 'first_progress') + s('done')
}

/** After a prompt job finished (its result, or failed as lost): its `done`, and the one log line. Never throws. */
export async function finishTimings(jobId: string): Promise<void> {
  try {
    const [row] = await db.update(studioJobs)
      .set({ timings: merge(sql`jsonb_build_object('done', ${since(sql`${studioJobs.finishedAt}`)})`) })
      .where(and(eq(studioJobs.id, jobId), eq(studioJobs.type, 'prompt'), isNotNull(studioJobs.finishedAt)))
      .returning({ timings: studioJobs.timings })
    if (row?.timings) console.log(timingLine(jobId, row.timings))
  } catch (err) {
    console.error('[studio] timings not recorded:', err instanceof Error ? err.message : err)
  }
}

/** The median (the mean of the middle two for an even count) and the 90th percentile (nearest rank); null when empty. */
export function median(values: number[]): number | null {
  if (!values.length) return null
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

export function p90(values: number[]): number | null {
  if (!values.length) return null
  const v = [...values].sort((a, b) => a - b)
  return v[Math.min(v.length - 1, Math.ceil(0.9 * v.length) - 1)]
}

export const RECENT_JOBS = 50
/** Below this many timed jobs, the page gets no typical wait. */
export const TYPICAL_MIN_JOBS = 5
const STEPS = ['taken', 'boot', 'screening', 'building', 'firstProgress', 'done'] as const
const MACHINES = ['created', 'started', 'running'] as const

type Spread = { jobs: number; median: number | null; p90: number | null }
const spread = (values: number[]): Spread => ({ jobs: values.length, median: median(values), p90: p90(values) })

/** The last RECENT_JOBS prompt jobs with timings, newest first. */
async function recentTimings(): Promise<JobTimings[]> {
  const rows = await db.select({ timings: studioJobs.timings }).from(studioJobs)
    .where(and(eq(studioJobs.type, 'prompt'), isNotNull(studioJobs.timings)))
    .orderBy(desc(studioJobs.createdAt), desc(studioJobs.id))
    .limit(RECENT_JOBS)
  return rows.map((r) => r.timings!)
}

const firstReplies = (rows: JobTimings[]) => rows.map((t) => t.firstProgress).filter((x): x is number => typeof x === 'number')

/**
 * The admin page's "First reply" card: created → first progress line over the last RECENT_JOBS timed prompt jobs, in
 * all and by how the machine was got, and the median seconds to each step.
 */
export async function firstReplyStats() {
  const rows = await recentTimings()
  return {
    jobs: rows.length,
    firstReply: spread(firstReplies(rows)),
    byMachine: Object.fromEntries(MACHINES.map((m) => [m, spread(firstReplies(rows.filter((t) => t.machine === m)))])) as Record<typeof MACHINES[number], Spread>,
    steps: Object.fromEntries(STEPS.map((s) => [s, median(rows.map((t) => t[s]).filter((x): x is number => typeof x === 'number'))])) as Record<typeof STEPS[number], number | null>,
  }
}

const TYPICAL_CACHE_MS = 5 * 60_000
let typical: { at: number; value: number | null } | null = null

/** The usual created → first progress, in whole seconds, for the design page; null below TYPICAL_MIN_JOBS. Cached a few minutes. */
export async function typicalFirstReplySec(now: Date): Promise<number | null> {
  if (typical && now.getTime() - typical.at < TYPICAL_CACHE_MS) return typical.value
  const values = firstReplies(await recentTimings())
  const m = values.length >= TYPICAL_MIN_JOBS ? median(values) : null
  typical = { at: now.getTime(), value: m === null ? null : Math.round(m) }
  return typical.value
}

/** Tests start each case with no cached value. */
export function clearTypicalCache(): void {
  typical = null
}
