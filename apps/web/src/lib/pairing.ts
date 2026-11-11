// Copy and helpers for approving a Hyperfy pairing and listing linked sessions.
import { normalizePairingCode, type HyperfyPairingSummary } from '@virvixr/shared'

type ApiError = Error & { status?: number; body?: { error?: string; result?: string } }

export function approvalPrompt(p: { worldName: string; sceneName: string; playerName?: string | null }): string {
  return `Link Hyperfy world "${p.worldName}" (scene ${p.sceneName}) to your account? Requested by ${p.playerName ?? 'a player'}.`
}

export function pairingErrorMessage(err: unknown): string {
  const e = err instanceof Error ? (err as ApiError) : null
  if (e?.body?.result === 'expired' || e?.body?.error === 'expired') return 'This code has expired. Ask for a new one in the world.'
  if (e?.status === 403 || e?.body?.error === 'no_access') return "You don't have access to this scene."
  if (e?.status === 404) return "That code doesn't exist."
  return 'Something went wrong. Try again in a moment.'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

/** "18:30 UTC", or "Oct 21, 02:05 UTC" when it is not today (UTC). */
function utcTime(iso: string, now: Date): string {
  const d = new Date(iso)
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  const sameDay = d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate()
  return sameDay ? time : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${time}`
}

export function pairingRowLabel(p: HyperfyPairingSummary, now: Date): string {
  const tail = p.kind === 'hosted' || !p.expiresAt ? 'remembered on this browser' : `until ${utcTime(p.expiresAt, now)}`
  return `${p.worldName} · ${tail}`
}

/**
 * The code for /pair/<code>. The static export has one page for every code, so outside `next dev`
 * the route param is `_` and the real code is in the address bar. Any case or format is accepted.
 */
const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

export function pairingCodeFromPath(pathname: string, paramCode: string | undefined): string | null {
  if (paramCode && paramCode !== '_') return normalizePairingCode(decode(paramCode))
  const m = /^\/pair\/([^/]+)\/?$/.exec(pathname)
  return m ? normalizePairingCode(decode(m[1])) : null
}

/** The code for /pair/headset/<code>; same static-export rules as `pairingCodeFromPath`. */
export function headsetPairingCodeFromPath(pathname: string, paramCode: string | undefined): string | null {
  if (paramCode && paramCode !== '_') return normalizePairingCode(decode(paramCode))
  const m = /^\/pair\/headset\/([^/]+)\/?$/.exec(pathname)
  return m ? normalizePairingCode(decode(m[1])) : null
}

/** The headset pairing page for a code someone typed, or null when nothing usable was typed (a full page load: one static page). */
export function headsetPairHref(typed: string): string | null {
  const code = normalizePairingCode(typed)
  return code ? `/pair/headset/${encodeURIComponent(code)}/` : null
}

export function headsetErrorMessage(err: unknown): string {
  const e = err instanceof Error ? (err as ApiError) : null
  if (e?.body?.error === 'unverified') return 'Verify your email before approving a headset.'
  if (e?.status === 404) return 'This code has expired or was already used. Ask the headset for a new one.'
  return 'Something went wrong. Try again in a moment.'
}

/** The pairing page's opening line: a trial's headset signs in to its trial, an account's to its account. */
export function headsetSignInPrompt(deviceName: string | null, trial: boolean): string {
  const into = trial ? 'your trial' : 'your account'
  return deviceName ? `"${deviceName}" wants to sign in to ${into}.` : `A headset wants to sign in to ${into}.`
}
