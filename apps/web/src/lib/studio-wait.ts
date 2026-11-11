import type { StudioEvent } from './studio'

/**
 * The wait after a prompt is sent, until the agent's first progress line: a short list of steps (the job is taken,
 * the worker checks the request when it does, the agent reads it), the time so far, and the usual wait. Then the
 * agent's progress lines, as before (progressFor).
 */

export type WaitStep = { key: 'start' | 'check' | 'read'; label: string; state: 'done' | 'current' | 'todo' }

export const WAIT_LABELS = {
  start: 'Starting your studio',
  check: 'Checking your request',
  read: 'The agent is reading your request',
} as const

/** A progress line the page shows (progressFor): its commands (`Running: …`) don't. */
const shown = (e: StudioEvent) => e.type === 'progress' && !!e.text.trim() && !e.text.startsWith('Running:')

/**
 * The steps for a prompt job, or null once the agent's progress takes over: its first shown line, or a phase after
 * the agent's (`checking`, `rendering`, `saving`). The check step shows only when the worker sent `screening`: an
 * older worker doesn't, and taken goes straight to the agent reading.
 */
export function waitSteps(job: { id: string; status: string }, events: StudioEvent[]): WaitStep[] | null {
  const own = events.filter((e) => 'jobId' in e && e.jobId === job.id)
  if (own.some(shown)) return null
  const phases = new Set(own.flatMap((e) => (e.type === 'phase' ? [e.phase] : [])))
  if ([...phases].some((p) => p !== 'screening' && p !== 'building')) return null
  const screening = phases.has('screening')
  const building = phases.has('building')
  const taken = job.status !== 'queued' || phases.size > 0 || own.some((e) => e.type === 'job' && e.status === 'taken')
  const steps: WaitStep[] = [{ key: 'start', label: WAIT_LABELS.start, state: taken ? 'done' : 'current' }]
  if (screening) steps.push({ key: 'check', label: WAIT_LABELS.check, state: building ? 'done' : 'current' })
  steps.push({ key: 'read', label: WAIT_LABELS.read, state: taken && (building || !screening) ? 'current' : 'todo' })
  return steps
}

/**
 * The wait as a bar and the time left (the owner, 2026-11-11: show what's left, not what has gone). `typicalSec`: the
 * usual first reply (the design detail's). The bar reaches 90% at the usual wait, then creeps on but never fills
 * before the agent answers; a done step holds it up. With no usual wait known, it moves with the steps and gives no time.
 */
export function waitProgress(elapsedSec: number, typicalSec: number | null | undefined, steps: WaitStep[]): { fraction: number; left: string | null } {
  const byStep = (steps.filter((s) => s.state === 'done').length / Math.max(1, steps.length)) * 0.9
  if (typicalSec == null || !Number.isFinite(typicalSec) || typicalSec <= 0) return { fraction: byStep, left: null }
  const e = Math.max(0, elapsedSec)
  const t = e / typicalSec
  const byTime = t <= 1 ? 0.9 * t : 0.9 + 0.08 * (1 - Math.exp(-(t - 1)))
  const remaining = typicalSec - e
  const left = remaining <= 0 ? 'Almost there, taking a little longer than usual'
    : remaining <= 10 ? 'A few seconds left'
      : remaining < 55 ? `About ${Math.ceil(remaining / 5) * 5} seconds left`
        : remaining < 90 ? 'About a minute left'
          : `About ${Math.round(remaining / 60)} minutes left`
  return { fraction: Math.max(byStep, byTime), left }
}

export const WARM_EVERY_MS = 5 * 60_000

/**
 * Starting a design's machine while the person writes a prompt (POST /designs/:id/warm): at most once per design every
 * 5 minutes, fire and forget. Returns whether it asked.
 */
export function createWarmer(send: (designId: string) => Promise<unknown>, now: () => number = Date.now) {
  const last = new Map<string, number>()
  return (designId: string): boolean => {
    const at = last.get(designId)
    if (at !== undefined && now() - at < WARM_EVERY_MS) return false
    last.set(designId, now())
    try {
      send(designId).catch(() => {})
    } catch { /* never in the way of typing */ }
    return true
  }
}

type Spread = { jobs: number; median: number | null; p90: number | null }
/** The admin page's First reply card (GET /api/admin/studio/first-reply). */
export type FirstReplyStats = {
  jobs: number
  firstReply: Spread
  byMachine: Record<'created' | 'started' | 'running', Spread>
  steps: Record<'taken' | 'boot' | 'screening' | 'building' | 'firstProgress' | 'done', number | null>
}

/** Seconds on the admin card: whole seconds, or a dash when there are none. */
export const secondsLabel = (sec: number | null) => sec === null ? '–' : `${Math.round(sec)} s`
