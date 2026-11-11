import { createHmac, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { config } from '../config.js'

/**
 * The pseudonymous user ID on error events: an HMAC of the user's id, so affected users can be counted without storing
 * who they are. The salt is ERROR_USER_SALT, else one derived from JWT_SECRET; it is never logged or returned.
 */
let salt: string | null = null
function errorSalt(): string {
  if (!salt) salt = process.env.ERROR_USER_SALT || createHmac('sha256', config.jwtSecret).update('virvi:error-user-hash').digest('hex')
  return salt
}

export function errorUserHash(userId: string): string {
  return createHmac('sha256', errorSalt()).update(userId).digest('hex').slice(0, 32)
}

const dayKeys = new Map<string, string>()

/** The day's random address key, shared by every instance through `error_ip_keys` (deleted after 2 days by retention.ts). */
async function dayKey(day: string): Promise<string> {
  const cached = dayKeys.get(day)
  if (cached) return cached
  await db.execute(sql`INSERT INTO error_ip_keys (day, key) VALUES (${day}::date, ${randomBytes(32).toString('hex')}) ON CONFLICT (day) DO NOTHING`)
  const [row] = (await db.execute(sql`SELECT key FROM error_ip_keys WHERE day = ${day}::date`)) as unknown as Array<{ key: string }>
  if (dayKeys.size > 4) dayKeys.clear()
  dayKeys.set(day, row.key)
  return row.key
}

/** Test hook: forget cached day keys (what a restart does). */
export function resetIpKeys(): void { dayKeys.clear() }

/**
 * A distinct-address marker for an hour's counts: `ip:` + an HMAC of the address key (IPv4, or IPv6 /64) under that
 * day's random key. Once the key is deleted (after 2 days) the marker can't be traced back or linked to other days.
 * The address itself is never stored.
 */
export async function errorIpHash(ipKey: string, at = new Date()): Promise<string> {
  const key = await dayKey(at.toISOString().slice(0, 10))
  return `ip:${createHmac('sha256', key).update(ipKey).digest('hex').slice(0, 20)}`
}
