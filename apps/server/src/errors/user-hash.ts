import { createHmac } from 'node:crypto'
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

/**
 * A distinct-address marker for an hour's counts: `ip:` + an HMAC of the day and the address key (IPv4, or IPv6 /64).
 * The day is in the hash, so the same address can't be followed across days. The address itself is never stored.
 */
export function errorIpHash(ipKey: string, at = new Date()): string {
  return `ip:${createHmac('sha256', errorSalt()).update(`${at.toISOString().slice(0, 10)}:${ipKey}`).digest('hex').slice(0, 20)}`
}
