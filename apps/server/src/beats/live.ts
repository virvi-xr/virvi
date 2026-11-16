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

const key = (sceneId: string, userId: string) => `beat-live:${sceneId}:${userId}`

/** Used only when no presence is set up (a process without the room server). */
const local = new Map<string, { since: number; until: number }>()

/** The user holds a live room connection from this scene, open since `sinceMs`. */
export async function markBeatLive(sceneId: string, userId: string, sinceMs: number): Promise<void> {
  const kv = busKeyValue()
  if (kv) await kv.setex(key(sceneId, userId), String(sinceMs), BEAT_LIVE_TTL_S)
  else local.set(key(sceneId, userId), { since: sinceMs, until: Date.now() + BEAT_LIVE_TTL_S * 1000 })
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
