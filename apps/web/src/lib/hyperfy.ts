// Copy and helpers for "Your Hyperfy worlds" (self-run and hosted) on the deploy page.
import type { HyperfyWorldSummary } from '@virvixr/shared'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function lastSeenLabel(iso: string | null, now: Date): string {
  if (!iso) return 'Never connected'
  const then = new Date(iso)
  const age = now.getTime() - then.getTime()
  if (age < 2 * MIN) return 'Connected just now'
  if (age < HOUR) return `Last seen ${Math.floor(age / MIN)} min ago`
  if (age < DAY) return `Last seen ${Math.floor(age / HOUR)} h ago`
  return `Last seen ${then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
}

/**
 * LIV-33: what a self-run world's card says about its Virvi app. `current` goes after the key and last-seen line;
 * `behind` is a warning to download the app again. Both null until the world has connected.
 */
export function appVersionNote(app: { version: string | null; latest: string; behind: boolean } | null | undefined): { current: string | null; behind: string | null } {
  if (!app) return { current: null, behind: null }
  if (!app.behind) return { current: app.version ? `Virvi app ${app.version}` : null, behind: null }
  const runs = app.version ? `This world runs Virvi app ${app.version}; ${app.latest} is out.` : 'This world runs an older Virvi app.'
  return { current: null, behind: `${runs} Download the app again and drag it into the world to replace the old one.` }
}

export function setupSteps(feedUrl: string): string[] {
  return [
    'Download the Virvi app and drag virvi.hyp into your Hyperfy world.',
    "Open the app's settings and paste your world key into Virvi world key.",
    `Leave Virvi feed URL as ${feedUrl} unless Virvi support tells you otherwise.`,
    'Your scene appears within a few seconds and follows your edits.',
  ]
}

/** Removing a world only stops the feed; the world keeps showing its last scene. */
export function removeWorldPrompt(name: string): string {
  return `Remove "${name}"? The Virvi app in that world stops receiving updates from Virvi.`
}

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** The status line of a hosted world's row. */
export function worldStatusLabel(w: HyperfyWorldSummary, now: Date): string {
  if (w.status === 'provisioning') return 'Setting up…'
  if (w.status === 'running') return 'Live'
  if (w.status === 'failed') return w.errorMessage ? `Failed: ${w.errorMessage}` : 'Failed'
  if (w.purgeAfter && new Date(w.purgeAfter).getTime() > now.getTime()) return `Ended. Restorable until ${shortDate(w.purgeAfter)}`
  return 'Ended'
}

/** `limit` is Infinity on an unlimited plan; null when the plan has none (noSlotsLine says so instead of "0 of 0"). */
export function slotLine(used: number, limit: number): string | null {
  if (limit === 0) return null
  const worlds = used === 1 ? 'hosted world' : 'hosted worlds'
  return Number.isFinite(limit) ? `${used} of ${limit} hosted worlds` : `${used} ${worlds}`
}

/** Shown in place of the create form when no slot is free. */
export function noSlotsLine(limit: number): string {
  return limit === 0 ? "Your plan doesn't include hosted worlds." : "You've used all your hosted worlds."
}

/** Destroying a hosted world deletes it for good, unlike an ended one. */
export function destroyWorldPrompt(name: string): string {
  return `Destroy "${name}"? The world and everything built in it are deleted and can't be restored.`
}

type ApiError = Error & { status?: number; body?: { error?: string; message?: string; used?: number; limit?: number | null } }

export function hyperfyErrorMessage(err: unknown): string {
  const e = err instanceof Error ? (err as ApiError) : null
  if (e?.message === 'upgrade_required') return "Your plan doesn't include deploying. Upgrade to connect your own Hyperfy world."
  switch (e?.message) {
    case 'hyperfy_hosting_unavailable':
      return 'Hosted worlds are not available right now. Try again later.'
    case 'world_limit_reached': {
      const { used, limit } = e.body ?? {}
      if (limit === 0) return "Your plan doesn't include hosted worlds. Upgrade your plan to make one."
      return typeof used === 'number' && typeof limit === 'number'
        ? `You're using ${used} of ${limit} hosted worlds. Destroy one or upgrade your plan to make another.`
        : "You've used all your hosted worlds. Destroy one or upgrade your plan to make another."
    }
    case 'not_restorable':
      return "This world can't be restored."
    case 'already_ended':
      return 'This world has ended. Restore it instead.'
    case 'not_hosted':
      return 'Only hosted worlds have an end date.'
    case 'world_update_failed':
      return e.body?.message || "The world couldn't be updated. Try again in a moment."
  }
  if (e?.status === 502) return "The world couldn't start. Try again in a moment."
  if (e?.status === 400) {
    const why = String(e.body?.error ?? e.message ?? '')
    if (why.startsWith('name is required')) return 'Give the world a name of 100 characters or fewer.'
    if (why.startsWith('endsAt must be')) return 'Pick an end date in the future, or leave it empty.'
  }
  return 'Something went wrong. Try again in a moment.'
}
