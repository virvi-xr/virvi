import { and, eq } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { userAuthMethods } from '../db/schema.js'
import { ipKey } from '../errors/limits.js'

/**
 * New wallets per network for BEATs (LIV-11, attacker Critical 1; fix round I-5): a script making thousands of throwaway
 * wallets to claim BEATs has to spread them over many networks. It applies only to BEAT tracking and claiming, never to
 * signing in to Virvi, so a conference or a shared network keeps everything else.
 *
 * A wallet is new when Virvi first saw it (its wallet sign-in method was made) less than BEAT_NEW_WALLET_WINDOW_MS ago.
 * Each network (an IPv4 address or an IPv6 /64, request.ip respecting TRUST_PROXY_HOPS) may bring at most
 * BEAT_NEW_WALLETS_PER_IP_HOUR different new wallets to BEATs in any hour; the same wallet counts once. Counted in this
 * process's memory only (nothing stored; with several servers each counts its own).
 */

export const BEAT_NEW_WALLET_WINDOW_MS = 24 * 3_600_000
const HOUR_MS = 3_600_000
const seen = new Map<string, Map<string, number>>()

/** True when the wallet was first seen by Virvi within the window (or never: no sign-in method yet). */
export async function isNewWallet(wallet: string, now: Date): Promise<boolean> {
  const m = await db.query.userAuthMethods.findFirst({
    where: and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, wallet.toLowerCase())), columns: { createdAt: true },
  })
  return !m || now.getTime() - m.createdAt.getTime() < BEAT_NEW_WALLET_WINDOW_MS
}

/** True when this network may bring this new wallet to BEATs now (and counts it, once per wallet per hour). */
export function takeNewWallet(ip: string, wallet: string, now = Date.now()): boolean {
  const k = ipKey(ip)
  const w = wallet.toLowerCase()
  const recent = new Map([...(seen.get(k) ?? new Map<string, number>())].filter(([, t]) => now - t < HOUR_MS))
  seen.set(k, recent)
  if (recent.has(w)) return true
  if (recent.size >= config.beats.newWalletsPerIpHour) return false
  recent.set(w, now)
  if (seen.size > 100_000) for (const [key, m] of seen) if (![...m.values()].some((t) => now - t < HOUR_MS)) seen.delete(key)
  return true
}

/** Tests: forget every count. */
export function resetNewWallets(): void {
  seen.clear()
}
