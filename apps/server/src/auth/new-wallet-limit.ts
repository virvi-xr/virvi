import { config } from '../config.js'
import { ipKey } from '../errors/limits.js'

/**
 * Scene passes for wallets Virvi has never seen, per network and hour (LIV-11, attacker Critical 1): a script making
 * thousands of throwaway wallets to claim BEATs has to spread them over many networks. A network is an IPv4 address or
 * an IPv6 /64 (request.ip, which respects TRUST_PROXY_HOPS). Counted in this process's memory only (nothing stored; with
 * several servers each counts its own), over a sliding hour. On while BEATs are on.
 */

const HOUR_MS = 3_600_000
const seen = new Map<string, number[]>()

/** True when this network may have one more never-seen wallet's pass now (and counts it). */
export function takeNewWalletPass(ip: string, now = Date.now()): boolean {
  const limit = config.beats.newWalletsPerIpHour
  const k = ipKey(ip)
  const recent = (seen.get(k) ?? []).filter((t) => now - t < HOUR_MS)
  if (recent.length >= limit) {
    seen.set(k, recent)
    return false
  }
  recent.push(now)
  seen.set(k, recent)
  if (seen.size > 100_000) for (const [key, ts] of seen) if (!ts.some((t) => now - t < HOUR_MS)) seen.delete(key)
  return true
}

/** Tests: forget every count. */
export function resetNewWalletPasses(): void {
  seen.clear()
}
