/**
 * The HUD's showings list for Schedule-mode screens (LIV-87): wording and which host controls apply.
 * Pure (no @dcl/sdk), so it is unit-tested. Mirrors the Hyperfy HUD (packages/hyperfy-app src/hud/model.ts).
 */
import { friendlyEditError, httpStatusOf } from './edit-errors.js'

/** A showing as GET /api/elements/:id/showings lists it, with show times in ms. */
export interface HUDShowing {
  id: string
  title: string
  enabled: boolean
  upcoming: Array<{ startsAt: number; lengthSeconds: number }>
}

export type ShowControl = 'delay' | 'end' | 'play-now'

/** How far one press of "Delay 5 min" pushes the next show (the dashboard's step too). */
export const DELAY_STEP_MINUTES = 5
export const SHOWINGS_LOADING = 'Loading showings…'
export const NO_SHOWINGS = 'No showings yet: add them on virvi.io'

export function showingsFromApi(body: { showings?: any[] } | null | undefined): HUDShowing[] {
  return (body?.showings ?? []).map((s) => ({
    id: String(s.id),
    title: typeof s.title === 'string' ? s.title : '',
    enabled: s.enabled !== false,
    upcoming: (Array.isArray(s.upcoming) ? s.upcoming : [])
      .map((u: any) => ({ startsAt: Date.parse(u?.startsAt), lengthSeconds: Number(u?.lengthSeconds) }))
      .filter((u: { startsAt: number; lengthSeconds: number }) => Number.isFinite(u.startsAt) && Number.isFinite(u.lengthSeconds)),
  }))
}

/** "9 min", "1 h 05 min", "2 days": relative, since a scene's clock time zone isn't the visitor's. */
export function timeLeft(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000))
  if (min < 60) return `${min} min`
  if (min < 1440) return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
  const d = Math.floor(min / 1440)
  return `${d} ${d === 1 ? 'day' : 'days'}`
}

export interface ShowingRow { id: string; title: string; status: string; canEnd: boolean; canPlay: boolean; canDelay: boolean }

/** One row of the list: what's on, and which of End now / Play now / Delay apply. A paused showing gets none. */
export function showingRow(s: HUDShowing, now: number): ShowingRow {
  const title = s.title || 'Untitled showing'
  if (!s.enabled) return { id: s.id, title, status: 'Paused on virvi.io', canEnd: false, canPlay: false, canDelay: false }
  const on = s.upcoming.find((u) => u.startsAt <= now && now < u.startsAt + u.lengthSeconds * 1000)
  const next = s.upcoming.find((u) => u.startsAt > now)
  const status = on
    ? `On now, ${timeLeft(on.startsAt + on.lengthSeconds * 1000 - now)} left`
    : next
      ? `Next in ${timeLeft(next.startsAt - now)}`
      : 'Nothing coming up'
  return { id: s.id, title, status, canEnd: !!on, canPlay: !on, canDelay: !!next }
}

export function showControlNote(control: ShowControl, title: string): string {
  const name = title || 'Untitled showing'
  if (control === 'delay') return `${name}: the next show starts ${DELAY_STEP_MINUTES} min later`
  return control === 'end' ? `${name}: ended` : `${name}: playing now for everyone`
}

/** A refused control: the server's own reason for a 400 / 409 (a clash, nothing to delay), else the usual wording. */
export function showControlError(err: unknown, opts: { connected?: boolean } = {}): string {
  const status = httpStatusOf(err)
  if (status === 400 || status === 409) {
    const body = (err as Error).message.replace(/^HTTP \d+:\s*/, '')
    try {
      const msg = JSON.parse(body)?.message
      if (typeof msg === 'string' && msg.trim()) return msg
    } catch {
      // not JSON: fall through
    }
  }
  return friendlyEditError(err, opts)
}
