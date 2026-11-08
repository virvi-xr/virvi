import { sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { config } from '../config.js'

/**
 * Hard limits on what error reporting may store (LIV-66), all in one place.
 *
 * First line, in memory per instance: 60 reports a minute per address (IPv4, or IPv6 by /64; routes/errors.ts), 20
 * new signatures an hour per address and 300 per instance, 50 stored full events a day per address and 5,000 per
 * instance, 20 crash reports a day per address and 500 per instance.
 *
 * The bound that holds across restarts and instances is in the database (`error_budget`, one upsert per flush):
 * - globally per day: 1,000 full events (8 KB each at most), 5,000 new hourly rows, 50,000 new breakdown rows and
 *   50,000 new user/address rows. Past a row budget, new rows are not made: counts go to existing rows or to the
 *   counted-only overflow signature.
 * - per address per day: 100 signature-hours touched; past it that address's events go to overflow.
 * - at most 5,000 browser signatures seen in the last 30 days (server-side ones are never capped).
 * Worst case (row sizes measured: breakdown ~210 B, user/address ~120 B, hourly ~100 B): about 8 MB of events,
 * 10.5 MB of breakdowns, 6 MB of user/address rows and 0.5 MB of hourly rows, so about 25 MB a day in all. With
 * 30-day retention for events, breakdowns and user rows, and 2 days for address rows, about 0.6 GB at most at steady
 * state, plus hourly rows (400 days, but anonymous-only browser signatures and their rows go after 30 quiet days).
 * One address: at most 100 signature-hours, about 2,500 rows and 50 events, about 0.9 MB a day.
 *
 * Anonymous browsers (no server-verified account or trial) may use at most 60% of every shared budget, of the
 * instance's new-signature and stored-event budgets and of the signature cap; the rest is kept for signed-in users,
 * so a flood can't blind reporting for them. Signed-in users aren't held to an address's signature-hours. Server-side
 * records (5xx, uncaught exceptions, failed jobs) use their own `server:` budgets of the same sizes.
 *
 * Breakdown values are clamped: the release must be one the server has run (else "unknown"), routes are templated
 * and cut to 100 characters, a browser is family and major version (a major over 200 is "other"), and at most 10
 * values per breakdown per signature-hour (and 20,000 tracked in memory per instance), the rest "other".
 */
export const ERROR_BUDGETS = {
  maxSignatures: 5000,
  newSignaturesPerIpHour: 20,
  newSignaturesPerHour: 300,
  storedEventsPerIpDay: 50,
  storedEventsPerDay: 5000,
  storedPerSignatureDay: 5,
  maxStoredEventBytes: 8192,
  maxDimValuesPerSignatureHour: 10,
  maxDimKeysInMemory: 20_000,
  reportsPerIpDay: 20,
  reportsPerDay: 500,
  signatureHoursPerIpDay: 100,
  maxTrackedKeys: 100_000,
  db: { events: 1000, hourly: 5000, dims: 50_000, users: 50_000 },
  /** The share of each budget (and of the signature cap) anonymous browser traffic may use; the rest is kept for signed-in users. */
  anonymousShare: 0.6,
}

/**
 * Who a record speaks for: `server` (5xx, uncaught exceptions, failed jobs: trusted, with budgets of their own),
 * `user` (a browser with a server-verified account or trial), or `anon` (any other browser).
 */
export type Trust = 'server' | 'user' | 'anon'

/** Anonymous use may reach anonymousShare of a limit; signed-in use the whole of it. */
export const anonLimit = (limit: number) => Math.floor(limit * ERROR_BUDGETS.anonymousShare)

const HOUR = 3_600_000
const DAY = 24 * HOUR

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
    // A full map makes room by forgetting its oldest key, so a flood of addresses never locks new ones out
    if (used === undefined && this.counts.size >= ERROR_BUDGETS.maxTrackedKeys) this.counts.delete(this.counts.keys().next().value!)
    const got = Math.max(0, Math.min(n, limit - (used ?? 0)))
    if (got) this.counts.set(key, (used ?? 0) + got)
    return got
  }
}

let hourly = new WindowCounter(HOUR)
let daily = new WindowCounter(DAY)

/** A new browser signature: anonymous ones within the address's hourly budget and their share of the instance's. */
export function takeNewSignature(ip: string | null, now = Date.now(), trust: Trust = 'anon'): boolean {
  if (trust === 'anon') {
    if (ip && hourly.take(`sig:${ip}`, 1, ERROR_BUDGETS.newSignaturesPerIpHour, now) < 1) return false
    if (hourly.take('sig:anon', 1, anonLimit(ERROR_BUDGETS.newSignaturesPerHour), now) < 1) return false
  }
  return hourly.take('sig:*', 1, ERROR_BUDGETS.newSignaturesPerHour, now) === 1
}

/** A full event stored today: anonymous ones within the address's budget and their share; server ones on their own budget. */
export function takeStoredEvent(ip: string | null, now = Date.now(), trust: Trust = 'anon'): boolean {
  if (trust === 'server') return daily.take('ev:server', 1, ERROR_BUDGETS.storedEventsPerDay, now) === 1
  if (trust === 'anon') {
    if (ip && daily.take(`ev:${ip}`, 1, ERROR_BUDGETS.storedEventsPerIpDay, now) < 1) return false
    if (daily.take('ev:anon', 1, anonLimit(ERROR_BUDGETS.storedEventsPerDay), now) < 1) return false
  }
  return daily.take('ev:*', 1, ERROR_BUDGETS.storedEventsPerDay, now) === 1
}

/** A crash report from this address today. */
export function takeReport(ip: string, now = Date.now()): boolean {
  if (daily.take(`rep:${ip}`, 1, ERROR_BUDGETS.reportsPerIpDay, now) < 1) return false
  return daily.take('rep:*', 1, ERROR_BUDGETS.reportsPerDay, now) === 1
}

/** Test hook (also what a restart does). */
export function resetErrorBudgets(): void {
  hourly = new WindowCounter(HOUR)
  daily = new WindowCounter(DAY)
  releases = null
}

// ── The shared daily budget ─────────────────────────────────────────────────

const rowsOf = <T>(r: unknown) => r as unknown as T[]
export const budgetDay = (at = new Date()) => at.toISOString().slice(0, 10)

/** One flush's view of today's `error_budget` rows: read once, used locally, added back in one upsert. */
export class DayBudget {
  private base = new Map<string, number>()
  private used = new Map<string, number>()
  private constructor(readonly day: string) {}

  static async load(keys: string[], at = new Date()): Promise<DayBudget> {
    const b = new DayBudget(budgetDay(at))
    const unique = [...new Set(keys)]
    if (unique.length) {
      const rows = rowsOf<{ key: string; n: number }>(await db.execute(sql`
        SELECT key, n FROM error_budget WHERE day = ${b.day}::date AND key IN (${sql.join(unique.map((k) => sql`${k}`), sql`, `)})`))
      for (const r of rows) b.base.set(r.key, Number(r.n))
    }
    return b
  }

  /** Takes up to `n` of `limit` for `key`; returns how many it got. */
  take(key: string, n: number, limit: number): number {
    const have = (this.base.get(key) ?? 0) + (this.used.get(key) ?? 0)
    const got = Math.max(0, Math.min(n, limit - have))
    if (got) this.used.set(key, (this.used.get(key) ?? 0) + got)
    return got
  }

  /**
   * Takes from a shared budget by trust: server records from their own `server:<key>`; anonymous ones from
   * `anon:<key>` (anonymousShare of the limit) and the shared key; signed-in ones from the shared key, whose last
   * part only they can reach.
   */
  takeFor(key: keyof typeof ERROR_BUDGETS.db, n: number, trust: Trust): number {
    const limit = ERROR_BUDGETS.db[key]
    if (trust === 'server') return this.take(`server:${key}`, n, limit)
    if (trust === 'anon') {
      const got = this.take(`anon:${key}`, n, anonLimit(limit))
      return got ? this.take(key, got, limit) : 0
    }
    return this.take(key, n, limit)
  }

  async save(): Promise<void> {
    const rows = [...this.used.entries()].filter(([, n]) => n > 0)
    if (!rows.length) return
    await db.execute(sql`
      INSERT INTO error_budget (day, key, n) VALUES ${sql.join(rows.map(([k, n]) => sql`(${this.day}::date, ${k}, ${n})`), sql`, `)}
      ON CONFLICT (day, key) DO UPDATE SET n = error_budget.n + excluded.n`)
  }
}

// ── Known releases ─────────────────────────────────────────────────────────

let releases: { set: Set<string>; at: number } | null = null

/** Records a release this server runs (at boot and daily), so browsers on it are believed. */
export async function registerRelease(release = config.release): Promise<void> {
  await db.execute(sql`INSERT INTO error_releases (release) VALUES (${release}) ON CONFLICT (release) DO UPDATE SET seen_at = NOW()`)
  releases?.set.add(release)
}

/** The releases a browser may claim: the server's own, and any the server registered in the last 90 days (cached 5 minutes). */
export async function knownReleases(): Promise<Set<string>> {
  if (!releases || Date.now() - releases.at > 300_000) {
    const rows = rowsOf<{ release: string }>(await db.execute(sql`SELECT release FROM error_releases`))
    releases = { set: new Set(rows.map((r) => r.release)), at: Date.now() }
  }
  releases.set.add(config.release)
  return releases.set
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
