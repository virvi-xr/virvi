import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { users, userAuthMethods } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (typeof v === 'string' && v.startsWith('valid:')) return { walletAddress: v.slice(6), metadata: {} }
    throw new Error('bad signature')
  },
  verifyDclSceneRequest: async (_m: string, _p: string, h: Record<string, string>, _b: string | null, opts?: { allowUnsignedBody?: boolean }) => {
    const v = h['x-identity-auth-chain-0']
    const scene = { sceneId: 'bafyX', parcel: '0,0', realm: { hostname: 'peer.decentraland.org', serverName: 'main' }, isGuest: false }
    if (typeof v === 'string' && v.startsWith('valid:')) return { wallet: v.slice(6), scene, bodySigned: true }
    // The web explorer signs the request but not its body (no hashPayload)
    if (typeof v === 'string' && v.startsWith('nohash:')) {
      if (!opts?.allowUnsignedBody) throw new Error('body does not match signed hash')
      return { wallet: v.slice(7), scene, bodySigned: false }
    }
    throw new Error('bad signature')
  },
}))

const WALLET = '0x00000000000000000000000000000000000000aa'
const VICTIM = '0x00000000000000000000000000000000000000bb'

describe('POST /api/auth/platform', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(async () => {
    ;(config as any).allowUnverifiedPlatformAuth = false
    await app.close()
  })

  it('verified signed fetch creates a wallet user and a verified token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${WALLET}` },
      payload: { user: { displayName: 'Alice' } },
    })
    expect(res.statusCode).toBe(200)
    const claims = verifySessionToken(res.json().accessToken)!
    expect(claims.wallet).toBe(WALLET)
    expect(claims.verified).toBe(true)
    expect(claims.kind).toBe('scene')
    const method = await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, WALLET) })
    expect(method).toBeTruthy()
  })

  it('a web-explorer sign-in (request signed, body not) gets a verified pass, without the body display name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `nohash:${WALLET}` },
      payload: { user: { displayName: 'Evil' } },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.guest).toBeUndefined()
    const claims = verifySessionToken(body.accessToken)!
    expect(claims.wallet).toBe(WALLET)
    expect(claims.verified).toBe(true)
    const method = await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, WALLET), with: { user: true } })
    expect(method!.user.displayName).toBe('0x0000…00aa')
  })

  it('a forged body wallet with a bad signature gets a guest token and no account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': 'forged' },
      payload: { user: { walletAddress: VICTIM, id: VICTIM } },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.guest).toBe(true)
    const claims = verifySessionToken(body.accessToken)!
    expect(claims.guest).toBe(true)
    expect(claims.wallet ?? null).toBeNull()
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, VICTIM) })).toBeUndefined()
  })

  it('a body wallet with no signature headers also gets a guest token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: { user: { walletAddress: VICTIM } } })
    expect(res.json().guest).toBe(true)
  })

  it('guest tokens are rejected by authenticated REST routes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: {} })
    const scenesRes = await app.inject({
      method: 'GET',
      url: '/api/scenes',
      headers: { authorization: `Bearer ${res.json().accessToken}` },
    })
    expect(scenesRes.statusCode).toBe(401)
  })

  it('preview mode issues an unverified token tied to a preview: identifier', async () => {
    ;(config as any).allowUnverifiedPlatformAuth = true
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: { user: { id: VICTIM } } })
    const claims = verifySessionToken(res.json().accessToken)!
    expect(claims.verified).toBe(false)
    expect(claims.wallet ?? null).toBeNull()
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, `preview:${VICTIM}`) })).toBeTruthy()
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, VICTIM) })).toBeUndefined()
  })

  it('only the very first user is auto-promoted to admin; later in-world players are viewers', async () => {
    await createUser({ role: 'admin' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${WALLET}` },
      payload: {},
    })
    expect(res.json().user.role).toBe('viewer')
  })

  it('the first-ever platform user becomes admin in single mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${WALLET}` },
      payload: {},
    })
    expect(res.json().user.role).toBe('admin')
  })

  it('refresh keeps wallet and verified=false', async () => {
    ;(config as any).allowUnverifiedPlatformAuth = true
    const login = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: { user: { id: 'p1' } } })
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { authorization: `Bearer ${login.json().refreshToken}` },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(verifySessionToken(refreshed.json().accessToken)!.verified).toBe(false)
  })

  it('a verified pass has no refresh token; a scene refresh token is neither a bearer nor refreshable', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${WALLET}` },
      payload: {},
    })
    expect(login.json().refreshToken).toBeNull()
    const refreshToken = app.jwt.sign({ ...verifySessionToken(login.json().accessToken)!, refresh: true })
    const scenesRes = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${refreshToken}` } })
    expect(scenesRes.statusCode).toBe(401)
    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${refreshToken}` } })
    expect(refreshed.statusCode).toBe(401)
  })

  it('verifySessionToken rejects refresh tokens and garbage', async () => {
    const u = await createUser()
    expect(verifySessionToken(tokenFor(u, { refresh: true }))).toBeNull()
    expect(verifySessionToken('not-a-jwt')).toBeNull()
    expect(verifySessionToken(undefined)).toBeNull()
  })
})
