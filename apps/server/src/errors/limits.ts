/**
 * Hard limits on what error reporting may store (LIV-66), all in one place. With these, one address can add at most
 * about 2–3 MB a day, and the whole table set stays bounded however many addresses report:
 *
 * - Per address (IPv4, or IPv6 by /64): 60 reports a minute (routes/errors.ts), at most 20 new signatures an hour
 *   (480 a day, about 0.5 MB of signature, hourly and breakdown rows) and at most 200 stored full events a day
 *   (200 × 8 KB = 1.6 MB). Crash reports: 20 a day.
 * - Per server instance: at most 300 new signatures an hour and 5,000 stored full events a day (40 MB a day, so at most
 *   about 1.2 GB across the 30-day raw retention per instance). Crash reports: 500 a day.
 * - In all: at most 5,000 distinct signatures. Past that, and past an address's or the instance's new-signature budget,
 *   events fold into one counted-only "overflow <kind>" signature (never stored in full, never filed).
 * - Per signature: the first occurrence and at most 5 full events a day; each stored event at most 8 KB (oldest
 *   breadcrumbs, then the stack, cut first); at most 20 distinct values per breakdown per signature per hour (the rest
 *   count as "other").
 *
 * Counters other than the signature total are per instance, in memory, reset by the window; the signature total is
 * read from the database (cached a minute).
 */
export const ERROR_BUDGETS = {
  maxSignatures: 5000,
  newSignaturesPerIpHour: 20,
  newSignaturesPerHour: 300,
  storedEventsPerIpDay: 200,
  storedEventsPerDay: 5000,
  storedPerSignatureDay: 5,
  maxStoredEventBytes: 8192,
  maxDimValuesPerSignatureHour: 20,
  reportsPerIpDay: 20,
  reportsPerDay: 500,
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** The most keys a window counter tracks; past it, a new key is refused (fails closed). */
const MAX_KEYS = 100_000

/** A fixed-window counter per key. */
class WindowCounter {
  private window = 0
  private counts = new Map<string, number>()
  constructor(private readonly ms: number) {}

  /** Takes up to `n` of `limit` for `key` in the current window; returns how many it got. */
  take(key: string, n: number, limit: number, now = Date.now()): number {
    const w = Math.floor(now / this.ms)
    if (w !== this.window) {
      this.window = w
      this.counts.clear()
    }
    const used = this.counts.get(key)
    if (used === undefined && this.counts.size >= MAX_KEYS) return 0
    const got = Math.max(0, Math.min(n, limit - (used ?? 0)))
    if (got) this.counts.set(key, (used ?? 0) + got)
    return got
  }
}

let hourly = new WindowCounter(HOUR)
let daily = new WindowCounter(DAY)

/** A new signature from this address: within its hourly budget and the instance's. */
export function takeNewSignature(ip: string | null, now = Date.now()): boolean {
  if (ip && hourly.take(`sig:${ip}`, 1, ERROR_BUDGETS.newSignaturesPerIpHour, now) < 1) return false
  return hourly.take('sig:*', 1, ERROR_BUDGETS.newSignaturesPerHour, now) === 1
}

/** A full event stored from this address today (server events pass `null` and use only the instance budget). */
export function takeStoredEvent(ip: string | null, now = Date.now()): boolean {
  if (ip && daily.take(`ev:${ip}`, 1, ERROR_BUDGETS.storedEventsPerIpDay, now) < 1) return false
  return daily.take('ev:*', 1, ERROR_BUDGETS.storedEventsPerDay, now) === 1
}

/** A crash report from this address today. */
export function takeReport(ip: string, now = Date.now()): boolean {
  if (daily.take(`rep:${ip}`, 1, ERROR_BUDGETS.reportsPerIpDay, now) < 1) return false
  return daily.take('rep:*', 1, ERROR_BUDGETS.reportsPerDay, now) === 1
}

/** Test hook. */
export function resetErrorBudgets(): void {
  hourly = new WindowCounter(HOUR)
  daily = new WindowCounter(DAY)
}

function expandV6(ip: string): string[] | null {
  const [head, tail, ...rest] = ip.split('::')
  if (rest.length) return null
  const h = head ? head.split(':') : []
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null
  const groups = t === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null
  return groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
}

/** The key an address is limited by: an IPv4 address as it is, an IPv6 address by its /64 (one host's whole range). */
export function ipKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (v4) return v4[1]
  const g = expandV6(ip.replace(/%.*$/, ''))
  return g ? `${g.slice(0, 4).join(':')}::/64` : ip.slice(0, 64)
}
