import { config } from '../config.js'
import { recordJobFailure } from '../errors/record.js'

/**
 * Per-platform checks on the wallet before a BEAT is tracked or claimed (LIV-11, attacker Critical 1). BEATs can be
 * claimed from several platforms (Decentraland today, Hyperfy and others later, and in person), so each platform may add
 * its own filter here; a platform with no check passes. The per-IP limit and live room presence are platform-neutral and
 * live elsewhere (visitor.ts, live.ts).
 *
 * Decentraland: the wallet must have a deployed Decentraland profile (the catalyst's `/lambdas/profiles/<address>`), a
 * cheap filter against freshly made wallets. A wallet with a profile is remembered for a day, one without for ten
 * minutes (so someone who just made one can come back soon). When the catalyst can't answer, the check passes (fail
 * open) and it is recorded as a job failure at most once an hour.
 */

export type BeatPlatform = 'decentraland' | (string & {})
/** True when the wallet passes. */
export type BeatPlatformCheck = (wallet: string, now: Date) => Promise<boolean>

const DAY_MS = 86_400_000
const NO_PROFILE_TTL_MS = 10 * 60_000
const ALERT_EVERY_MS = 60 * 60_000
const TIMEOUT_MS = 3_000
const CACHE_MAX = 50_000

const profiles = new Map<string, { ok: boolean; until: number }>()
let lastAlertAt = 0

class CatalystDown extends Error {}

async function hasDclProfile(wallet: string): Promise<boolean> {
  const url = `${config.beats.profileCatalystUrl.replace(/\/+$/, '')}/lambdas/profiles/${encodeURIComponent(wallet)}`
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    throw new CatalystDown(`catalyst profile lookup failed: ${(err as Error).message}`)
  }
  if (res.status === 404) return false
  if (!res.ok) throw new CatalystDown(`catalyst profile lookup failed: HTTP ${res.status}`)
  let body: unknown
  try { body = await res.json() } catch { throw new CatalystDown('catalyst profile lookup: not JSON') }
  const avatars = (body as { avatars?: unknown } | null)?.avatars
  return Array.isArray(avatars) && avatars.length > 0
}

export const decentralandProfileCheck: BeatPlatformCheck = async (wallet, now) => {
  const w = wallet.toLowerCase()
  const hit = profiles.get(w)
  if (hit && hit.until > now.getTime()) return hit.ok
  try {
    const ok = await hasDclProfile(w)
    if (profiles.size >= CACHE_MAX) profiles.clear()
    profiles.set(w, { ok, until: now.getTime() + (ok ? DAY_MS : NO_PROFILE_TTL_MS) })
    return ok
  } catch (err) {
    if (!(err instanceof CatalystDown)) throw err
    if (now.getTime() - lastAlertAt >= ALERT_EVERY_MS) {
      lastAlertAt = now.getTime()
      console.warn('[beats] Decentraland profile check unavailable; letting claims through')
      recordJobFailure('beat_profile_check', err, { owner: null })
    }
    return true
  }
}

const defaults: Record<string, BeatPlatformCheck> = { decentraland: decentralandProfileCheck }
const overrides = new Map<string, BeatPlatformCheck | null>()

/** The platform's check on this wallet; true when it passes, or when the platform has none. */
export async function platformCheck(platform: BeatPlatform, wallet: string, now = new Date()): Promise<boolean> {
  const check = overrides.has(platform) ? overrides.get(platform) : defaults[platform]
  return check ? check(wallet, now) : true
}

/** Tests: replace a platform's check (null: no check at all), or undefined to go back to the real one. */
export function setBeatPlatformCheckForTests(platform: BeatPlatform, check: BeatPlatformCheck | null | undefined): void {
  if (check === undefined) overrides.delete(platform)
  else overrides.set(platform, check)
}

/** Tests: forget cached profile answers and the alert throttle. */
export function resetBeatPlatformChecks(): void {
  profiles.clear()
  lastAlertAt = 0
}
