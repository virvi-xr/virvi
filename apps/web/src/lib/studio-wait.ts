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
 * the agent's (the `checking` after `building` is the pieces' checks; `rendering`, `saving`). The `checking` step
 * shows only when the worker sent that phase: an older worker doesn't, and taken goes straight to the agent reading.
 */
export function waitSteps(job: { id: string; status: string }, events: StudioEvent[]): WaitStep[] | null {
  const own = events.filter((e) => e.jobId === job.id)
  if (own.some(shown)) return null
  let checking = false
  let building = false
  for (const e of own) {
    if (e.type !== 'phase') continue
    if (building && e.phase !== 'building') return null
    if (e.phase === 'checking') checking = true
    else if (e.phase === 'building') building = true
  }
  const taken = job.status !== 'queued' || checking || building || own.some((e) => e.type === 'job' && e.status === 'taken')
  const steps: WaitStep[] = [{ key: 'start', label: WAIT_LABELS.start, state: taken ? 'done' : 'current' }]
  if (checking) steps.push({ key: 'check', label: WAIT_LABELS.check, state: building ? 'done' : 'current' })
  steps.push({ key: 'read', label: WAIT_LABELS.read, state: taken && (building || !checking) ? 'current' : 'todo' })
  return steps
}

/** Seconds as `m:ss`. */
export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The design detail's typicalFirstReplySec in round words, or null without one. */
export function typicalHint(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec)) return null
  const fives = Math.max(5, Math.round(sec / 5) * 5)
  if (fives <= 45) return `Usually about ${fives} seconds`
  if (sec < 90) return 'Usually about a minute'
  return `Usually about ${Math.round(sec / 60)} minutes`
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
  steps: Record<'taken' | 'boot' | 'checking' | 'building' | 'firstProgress' | 'done', number | null>
}

/** Seconds on the admin card: whole seconds, or a dash when there are none. */
export const secondsLabel = (sec: number | null) => sec === null ? '–' : `${Math.round(sec)} s`
