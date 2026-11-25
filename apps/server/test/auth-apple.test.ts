import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { users, userAuthMethods } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { appleClient, verifyAppleIdToken, verifyAppleIdTokenFresh, buildAppleClientSecret, resetAppleKeysForTests } from '../src/auth/apple.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser } from './helpers/factories.js'

const SERVICE = 'io.virvi.signin'
const ISS = 'https://appleid.apple.com'
const NOW = 1_800_000_000_000

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const jwkOf = (pub: crypto.KeyObject, kid: string, alg: string) => ({ ...pub.export({ format: 'jwk' }), kid, alg, use: 'sig' })
const JWKS = { keys: [jwkOf(rsa.publicKey, 'rsa1', 'RS256'), jwkOf(ec.publicKey, 'ec1', 'ES256')] }

const b64 = (o: object | Buffer) => Buffer.from(o instanceof Buffer ? o : JSON.stringify(o)).toString('base64url')
function sign(claims: Record<string, unknown>, kind: 'rsa' | 'ec' = 'rsa') {
  const header = kind === 'rsa' ? { alg: 'RS256', kid: 'rsa1' } : { alg: 'ES256', kid: 'ec1' }
  const input = `${b64(header)}.${b64(claims)}`
  const sig = kind === 'rsa'
    ? crypto.sign('sha256', Buffer.from(input), rsa.privateKey)
    : crypto.sign('sha256', Buffer.from(input), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' })
  return `${input}.${b64(sig)}`
}
const good = (over: Record<string, unknown> = {}) => ({
  iss: ISS, aud: SERVICE, sub: '001234.abc', email: 'jo@example.com', email_verified: 'true',
  iat: NOW / 1000 - 10, exp: NOW / 1000 + 600, ...over,
})

describe('verifyAppleIdToken', () => {
  beforeEach(() => { (config as any).appleSigninServiceId = SERVICE })
  it('returns the identity for a valid RS256 and ES256 token', () => {
    expect(verifyAppleIdToken(sign(good()), JWKS, NOW)).toEqual({ sub: '001234.abc', email: 'jo@example.com', emailVerified: true })
    expect(verifyAppleIdToken(sign(good(), 'ec'), JWKS, NOW).sub).toBe('001234.abc')
  })
  it('refuses a wrong audience, wrong issuer, expired token, bad signature and unknown key', () => {
    expect(() => verifyAppleIdToken(sign(good({ aud: 'other' })), JWKS, NOW)).toThrow()
    expect(() => verifyAppleIdToken(sign(good({ iss: 'https://evil.example' })), JWKS, NOW)).toThrow()
    expect(() => verifyAppleIdToken(sign(good({ exp: NOW / 1000 - 1 })), JWKS, NOW)).toThrow()
    const t = sign(good()).split('.')
    expect(() => verifyAppleIdToken(`${t[0]}.${b64(good({ sub: 'someone-else' }))}.${t[2]}`, JWKS, NOW)).toThrow()
    expect(() => verifyAppleIdToken(sign(good()), { keys: [] }, NOW)).toThrow()
    expect(() => verifyAppleIdToken('garbage', JWKS, NOW)).toThrow()
  })
})

describe("Apple's keys", () => {
  const origDownload = appleClient.downloadJwks
  beforeEach(() => { (config as any).appleSigninServiceId = SERVICE; resetAppleKeysForTests() })
  afterEach(() => { appleClient.downloadJwks = origDownload; resetAppleKeysForTests() })
  /** A token signed by the RSA key under another key id (Apple rotated its keys). */
  const rotated = (kid: string) => {
    const input = `${b64({ alg: 'RS256', kid })}.${b64(good())}`
    return `${input}.${b64(crypto.sign('sha256', Buffer.from(input), rsa.privateKey))}`
  }

  it('fetches the keys again once on an unknown key id, and not more than once a minute', async () => {
    let downloads = 0
    let served: typeof JWKS = JWKS
    appleClient.downloadJwks = async () => { downloads++; return served }
    expect((await verifyAppleIdTokenFresh(sign(good()), NOW)).sub).toBe('001234.abc')
    expect(downloads).toBe(1)
    // Apple adds a key: the cached set doesn't have it, so one fresh fetch finds it
    served = { keys: [...JWKS.keys, jwkOf(rsa.publicKey, 'new1', 'RS256')] }
    expect((await verifyAppleIdTokenFresh(rotated('new1'), NOW)).sub).toBe('001234.abc')
    expect(downloads).toBe(2)
    // A key id nobody has, 30 s later: no fetch (one a minute at most), refused
    await expect(verifyAppleIdTokenFresh(rotated('nope'), NOW + 30_000)).rejects.toThrow('unknown signing key')
    expect(downloads).toBe(2)
    // A minute on: one fetch, still refused
    await expect(verifyAppleIdTokenFresh(rotated('nope'), NOW + 61_000)).rejects.toThrow('unknown signing key')
    expect(downloads).toBe(3)
    // Any other failure never fetches again
    await expect(verifyAppleIdTokenFresh(sign(good({ aud: 'other' })), NOW + 200_000)).rejects.toThrow()
    expect(downloads).toBe(3)
  })
})

describe('buildAppleClientSecret', () => {
  it('is an ES256 JWT for the service id signed by the team key, accepting \\n escapes', () => {
    const pem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const jwt = buildAppleClientSecret({ teamId: 'TEAM123456', keyId: 'KEY1234567', serviceId: SERVICE, privateKey: pem.replace(/\n/g, '\\n') }, NOW)
    const [h, p, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY1234567' })
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    expect(claims).toMatchObject({ iss: 'TEAM123456', sub: SERVICE, aud: ISS, iat: NOW / 1000 })
    expect(claims.exp).toBeGreaterThan(claims.iat)
    expect(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true)
  })
})

describe('Sign in with Apple routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = { ...config } as any
  const enable = () => Object.assign(config as any, {
    appleSigninServiceId: SERVICE, appleSigninTeamId: 'TEAM123456', appleSigninKeyId: 'KEY1234567',
    appleSigninPrivateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  })
  const origExchange = appleClient.exchangeCode
  const origJwks = appleClient.fetchJwks
  let idToken = ''
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    enable()
    appleClient.fetchJwks = async () => JWKS
    appleClient.exchangeCode = async () => idToken
  })
  afterEach(async () => {
    for (const k of ['appleSigninServiceId', 'appleSigninTeamId', 'appleSigninKeyId', 'appleSigninPrivateKey']) (config as any)[k] = prev[k]
    appleClient.exchangeCode = origExchange
    appleClient.fetchJwks = origJwks
    await app.close()
  })

  const callback = (body: Record<string, string>) => app.inject({
    method: 'POST', url: '/api/auth/apple/callback',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body).toString(),
  })
  const liveClaims = (over: Record<string, unknown> = {}) => good({ iat: Date.now() / 1000 - 5, exp: Date.now() / 1000 + 600, ...over })

  it('providers reports apple false without config and true with it', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/providers' })).json().apple).toBe(true)
    ;(config as any).appleSigninPrivateKey = undefined
    expect((await app.inject({ method: 'GET', url: '/api/auth/providers' })).json().apple).toBe(false)
  })

  it('authorize is 501 unconfigured, else redirects to Apple with form_post and the state', async () => {
    const state = 'abcdefghijklmnop1234'
    const res = await app.inject({ method: 'GET', url: `/api/auth/apple?state=${state}` })
    expect(res.statusCode).toBe(302)
    const loc = new URL(res.headers.location as string)
    expect(loc.origin + loc.pathname).toBe('https://appleid.apple.com/auth/authorize')
    expect(loc.searchParams.get('response_mode')).toBe('form_post')
    expect(loc.searchParams.get('scope')).toBe('name email')
    expect(loc.searchParams.get('client_id')).toBe(SERVICE)
    expect(loc.searchParams.get('state')).toBe(state)
    expect(loc.searchParams.get('redirect_uri')).toBe(`${config.oauthCallbackUrl}/api/auth/apple/callback`)
    ;(config as any).appleSigninKeyId = undefined
    expect((await app.inject({ method: 'GET', url: '/api/auth/apple' })).statusCode).toBe(501)
  })

  it('creates one user, takes the name from the first callback, and signs the same user in the second time', async () => {
    idToken = sign(liveClaims())
    const state = 'abcdefghijklmnop1234'
    const first = await callback({ code: 'c1', state, user: JSON.stringify({ name: { firstName: 'Jo', lastName: 'Park' }, email: 'jo@example.com' }) })
    expect(first.statusCode).toBe(302)
    const url = new URL(first.headers.location as string)
    expect(url.pathname).toBe('/auth/callback')
    expect(url.searchParams.get('token')).toBeTruthy()
    expect(url.searchParams.get('state')).toBe(state)
    const [u] = await db.select().from(users)
    expect(u.displayName).toBe('Jo Park')
    expect(u.email).toBe('jo@example.com')
    expect(u.emailVerifiedAt).toBeTruthy()

    const second = await callback({ code: 'c2' })
    expect(new URL(second.headers.location as string).searchParams.get('token')).toBeTruthy()
    expect(await db.select().from(users)).toHaveLength(1)
    const methods = await db.select().from(userAuthMethods)
    expect(methods).toHaveLength(1)
    expect(methods[0].identifier).toBe('apple:001234.abc')
  })

  it('a malformed user field is ignored', async () => {
    idToken = sign(liveClaims())
    const res = await callback({ code: 'c', user: '{not json' })
    expect(new URL(res.headers.location as string).searchParams.get('token')).toBeTruthy()
    expect((await db.select().from(users))[0].displayName).toBeTruthy()
  })

  it('a privaterelay email is verified and never attaches to an existing user with another method', async () => {
    const existing = await createUser({ email: 'jo@example.com' })
    idToken = sign(liveClaims({ sub: 'relay.1', email: 'abc123@privaterelay.appleid.com' }))
    const res = await callback({ code: 'c' })
    expect(new URL(res.headers.location as string).searchParams.get('token')).toBeTruthy()
    const all = await db.select().from(users)
    expect(all).toHaveLength(2)
    const created = all.find((x) => x.id !== existing.id)!
    expect(created.email).toBe('abc123@privaterelay.appleid.com')
    expect(created.emailVerifiedAt).toBeTruthy()
    expect(await db.select().from(userAuthMethods).where(eq(userAuthMethods.userId, existing.id))).toHaveLength(0)
  })

  it('redirects with an error for a bad token, a missing code or an Apple error, creating nothing', async () => {
    idToken = sign(liveClaims({ aud: 'other' }))
    expect(new URL((await callback({ code: 'c' })).headers.location as string).searchParams.get('error')).toBe('oauth_failed')
    expect(new URL((await callback({})).headers.location as string).searchParams.get('error')).toBe('missing_code')
    expect(new URL((await callback({ error: 'user_cancelled_authorize' })).headers.location as string).searchParams.get('error')).toBe('user_cancelled_authorize')
    expect(await db.select().from(users)).toHaveLength(0)
  })
})
