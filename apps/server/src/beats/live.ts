import { busKeyValue } from '../realtime/bus.js'

/**
 * Live room presence for BEAT check-ins (LIV-11, attacker Critical 1). A check-in only credits time while the same user
 * holds a live Virvi room connection from that scene (the scene joins the room anyway, for `beat_available`), so a bot
 * has to keep a websocket open per wallet rather than only call HTTP.
 *
 * The scene room marks `beat-live:<sceneId>:<userId>` with the time the connection opened, refreshes it every
 * BEAT_LIVE_REFRESH_MS (so it outlives a crashed server by at most BEAT_LIVE_TTL_S) and clears it when the user's last
 * connection in that room closes. It lives in the Colyseus presence (Redis when rooms are spread over servers), so any
 * server answering the check-in sees it. Platform-neutral: any platform whose scene joins the room counts.
 */

export const BEAT_LIVE_TTL_S = 90
export const BEAT_LIVE_REFRESH_MS = 30_000
/** The TTL and refresh in use (tests shorten them; rooms read them when they're made). */
export const beatLiveTiming = { ttlS: BEAT_LIVE_TTL_S, refreshMs: BEAT_LIVE_REFRESH_MS }

const key = (sceneId: string, userId: string) => `beat-live:${sceneId}:${userId}`

/** Used only when no presence is set up (a process without the room server). */
const local = new Map<string, { since: number; until: number }>()

/** The user holds a live room connection from this scene, open since `sinceMs`. */
export async function markBeatLive(sceneId: string, userId: string, sinceMs: number): Promise<void> {
  const kv = busKeyValue()
  if (kv) await kv.setex(key(sceneId, userId), String(sinceMs), beatLiveTiming.ttlS)
  else local.set(key(sceneId, userId), { since: sinceMs, until: Date.now() + beatLiveTiming.ttlS * 1000 })
}

/** The user's last connection from this scene closed. */
export async function clearBeatLive(sceneId: string, userId: string): Promise<void> {
  const kv = busKeyValue()
  if (kv) await kv.del(key(sceneId, userId))
  local.delete(key(sceneId, userId))
}

/** Since when (ms) the user has held a live room connection from this scene, or null when they hold none. */
export async function beatLiveSince(sceneId: string, userId: string): Promise<number | null> {
  const kv = busKeyValue()
  if (kv) {
    const v = Number(await kv.get(key(sceneId, userId)))
    return Number.isFinite(v) && v > 0 ? v : null
  }
  const hit = local.get(key(sceneId, userId))
  if (!hit || hit.until < Date.now()) return null
  return hit.since
}

/**
 * Presence in an AR space (the Virvi app, iPhone or Quest): the space's feed marks `ar-live:<spaceId>:<userId>` on each
 * poll from a signed-in visitor, with the time of the first poll while the mark lives, in the same store and with the
 * same TTL as the room marks above. It lapses BEAT_LIVE_TTL_S after the polls stop. An app's check-in credits time only
 * since then, so the app's own word that the space is in view never counts alone.
 */
const arKey = (spaceId: string, userId: string) => `ar-live:${spaceId}:${userId}`

/** The user's app is polling this space's feed, since `sinceMs`. */
export async function markArLive(spaceId: string, userId: string, sinceMs: number): Promise<void> {
  const kv = busKeyValue()
  if (kv) await kv.setex(arKey(spaceId, userId), String(sinceMs), beatLiveTiming.ttlS)
  else local.set(arKey(spaceId, userId), { since: sinceMs, until: Date.now() + beatLiveTiming.ttlS * 1000 })
}

/** Since when (ms) the user's app has polled this space's feed without a break, or null when it hasn't lately. */
export async function arLiveSince(spaceId: string, userId: string): Promise<number | null> {
  const kv = busKeyValue()
  if (kv) {
    const v = Number(await kv.get(arKey(spaceId, userId)))
    return Number.isFinite(v) && v > 0 ? v : null
  }
  const hit = local.get(arKey(spaceId, userId))
  if (!hit || hit.until < Date.now()) return null
  return hit.since
}
