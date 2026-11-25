import crypto from 'node:crypto'
import { config } from '../config.js'

const APPLE_ISSUER = 'https://appleid.apple.com'
const APPLE_KEYS_URL = `${APPLE_ISSUER}/auth/keys`
const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`
const JWKS_TTL_MS = 3600_000

export interface AppleIdentity { sub: string; email: string | null; emailVerified: boolean }
export interface AppleJwk { kty: string; kid?: string; alg?: string; [k: string]: unknown }
export interface AppleJwks { keys: AppleJwk[] }

export interface AppleSigninConfig { teamId: string; keyId: string; serviceId: string; privateKey: string }

/** True when all four Sign in with Apple settings are present. */
export const appleConfigured = () => !!(config.appleSigninServiceId && config.appleSigninTeamId && config.appleSigninKeyId && config.appleSigninPrivateKey)

const b64u = (v: object | Buffer) => Buffer.from(v instanceof Buffer ? v : JSON.stringify(v)).toString('base64url')

/** The ES256 JWT Apple takes as the client secret. The key may carry literal `\n` escapes (env vars). Never log the result. */
export function buildAppleClientSecret(c: AppleSigninConfig, nowMs = Date.now()): string {
  const key = crypto.createPrivateKey(c.privateKey.replace(/\\n/g, '\n'))
  const iat = Math.floor(nowMs / 1000)
  const input = `${b64u({ alg: 'ES256', kid: c.keyId })}.${b64u({ iss: c.teamId, iat, exp: iat + 300, aud: APPLE_ISSUER, sub: c.serviceId })}`
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
  return `${input}.${b64u(sig)}`
}

/** Checks an Apple id_token's signature against the JWKS, its issuer, audience (our service id) and expiry. Throws if anything is off. */
export function verifyAppleIdToken(idToken: string, jwks: AppleJwks, nowMs = Date.now()): AppleIdentity {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('malformed id_token')
  let header: { alg?: string; kid?: string }
  let claims: Record<string, unknown>
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  } catch { throw new Error('malformed id_token') }
  if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new Error('unsupported id_token algorithm')
  const jwk = jwks.keys.find((k) => k.kid === header.kid && (!k.alg || k.alg === header.alg))
  if (!jwk) throw new Error('unknown signing key')
  const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' })
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url'))
  if (!ok) throw new Error('bad id_token signature')
  if (claims.iss !== APPLE_ISSUER) throw new Error('wrong id_token issuer')
  if (!config.appleSigninServiceId || claims.aud !== config.appleSigninServiceId) throw new Error('wrong id_token audience')
  if (typeof claims.exp !== 'number' || claims.exp <= nowMs / 1000) throw new Error('id_token expired')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id_token has no subject')
  const email = typeof claims.email === 'string' && claims.email ? claims.email : null
  // Apple only returns addresses it has verified, relay addresses included
  return { sub: claims.sub, email, emailVerified: true }
}

let jwksCache: { at: number; jwks: AppleJwks } | null = null

/** The network calls, replaceable in tests. */
export const appleClient = {
  async fetchJwks(): Promise<AppleJwks> {
    if (jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.jwks
    const res = await fetch(APPLE_KEYS_URL, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`Apple keys request failed (${res.status})`)
    const jwks = (await res.json()) as AppleJwks
    if (!Array.isArray(jwks?.keys)) throw new Error('Apple keys response malformed')
    jwksCache = { at: Date.now(), jwks }
    return jwks
  },
  /** Trades the authorization code for the id_token. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: config.appleSigninServiceId!,
      client_secret: buildAppleClientSecret({
        teamId: config.appleSigninTeamId!, keyId: config.appleSigninKeyId!, serviceId: config.appleSigninServiceId!, privateKey: config.appleSigninPrivateKey!,
      }),
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    })
    const res = await fetch(APPLE_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`Apple token request failed (${res.status})`)
    const json = (await res.json()) as { id_token?: string }
    if (!json.id_token) throw new Error('Apple token response had no id_token')
    return json.id_token
  },
}

/** Apple's `user` form field (first authorization only) is a JSON string: the name, or null when absent or unreadable. */
export function appleNameFromUserField(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    const n = (JSON.parse(raw) as { name?: { firstName?: unknown; lastName?: unknown } })?.name
    const full = [n?.firstName, n?.lastName].filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()).join(' ')
    return full.slice(0, 100) || null
  } catch { return null }
}
