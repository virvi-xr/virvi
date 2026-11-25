import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { arDevices, authHandoffCodes, users } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const SECRET = 'headset-secret-visitor'
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
const as = (u: TestUser, extra: Record<string, unknown> = {}) => bearer(tokenFor(u, extra))

describe('Virvi app and Quest visitor sign-in', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { vi.useRealTimers(); await app.close() })

  const appCode = (headers?: Record<string, string>) => app.inject({ method: 'POST', url: '/api/auth/app-handoff', headers })
  const exchange = (code: string) => app.inject({ method: 'POST', url: '/api/auth/handoff/exchange', payload: { code } })

  describe('app hand-off code', () => {
    it('gives an email-only account a one-time code that exchanges for that account\'s session', async () => {
      const user = await createUser({ wallet: null })
      const res = await appCode(as(user, { am: 'email' }))
      expect(res.statusCode).toBe(200)
      const { code, expiresAt } = res.json()
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(new Date(expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 61_000)
      const [row] = await db.select().from(authHandoffCodes)
      expect(row.kind).toBe('app')
      expect(row.wallet).toBeNull()

      const ok = await exchange(code)
      expect(ok.statusCode).toBe(200)
      const body = ok.json()
      expect(body.user).toMatchObject({ id: user.id })
      const claims = app.jwt.verify<Record<string, unknown>>(body.accessToken)
      expect(claims).toMatchObject({ id: user.id, kind: 'account', verified: true, am: 'email' })
      expect(claims.wallet).toBeUndefined()
      expect(app.jwt.verify<Record<string, unknown>>(body.refreshToken)).toMatchObject({ refresh: true, am: 'email' })

      const again = await exchange(code)
      expect(again.statusCode).toBe(410)
    })

    it('keeps the sign-in method of the session that asked, and never claims a wallet it lacks', async () => {
      const user = await createUser({ wallet: randomWallet() })
      const { code } = (await appCode(as(user, { am: 'wallet' }))).json()
      const claims = app.jwt.verify<Record<string, unknown>>((await exchange(code)).json().accessToken)
      expect(claims.am).toBe('wallet')
      expect(claims.wallet).toBeUndefined()
      const old = await createUser({ wallet: null })
      const c2 = (await appCode(as(old))).json().code
      expect(app.jwt.verify<Record<string, unknown>>((await exchange(c2)).json().accessToken).am).toBe('unknown')
    })

    it('is 410 after 60 seconds', async () => {
      const user = await createUser({ wallet: null })
      const { code } = (await appCode(as(user))).json()
      await db.update(authHandoffCodes).set({ expiresAt: new Date(Date.now() - 1000) })
      expect((await exchange(code)).statusCode).toBe(410)
    })

    it('refuses trials, passes, unsigned requests and unverified tokens', async () => {
      const trial = await createUser({ wallet: null })
      await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, trial.id))
      expect((await appCode(as(trial, { kind: 'trial' }))).statusCode).toBe(403)
      const user = await createUser({ wallet: null })
      expect((await appCode(as(user, { kind: 'scene', sceneId: crypto.randomUUID() }))).statusCode).toBe(403)
      expect((await appCode()).statusCode).toBe(401)
      expect((await appCode(as(user, { verified: false }))).statusCode).toBe(401)
      expect(await db.select().from(authHandoffCodes)).toHaveLength(0)
    })

    it('leaves the in-world hand-off refusing a wallet-less account', async () => {
      const user = await createUser({ wallet: null })
      const res = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: as(user) })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: 'Sign-in hand-off needs a verified wallet' })
    })

    it('does not exchange an account code that has no wallet', async () => {
      const user = await createUser({ wallet: null })
      const code = 'x'.repeat(43)
      await db.insert(authHandoffCodes).values({ codeHash: sha256(code), userId: user.id, wallet: null, kind: 'account', expiresAt: new Date(Date.now() + 60_000) })
      expect((await exchange(code)).statusCode).toBe(410)
    })
  })

  describe('Quest visitor pairing', () => {
    const start = (payload: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url: '/api/ar/pair', payload: { secretHash: sha256(SECRET), deviceName: 'Quest 3', ...payload } })
    const approve = (code: string, u: TestUser, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/ar/pair/${code}/approve`, headers: as(u), payload })
    const claim = (code: string) => app.inject({ method: 'POST', url: `/api/ar/pair/${code}/claim`, payload: { secret: SECRET } })

    it('a visitor pairing approved by A and claimed returns A\'s account session, once', async () => {
      const a = await createUser({ wallet: null })
      const { code } = (await start({ purpose: 'visitor' })).json()
      const info = await app.inject({ method: 'GET', url: `/api/ar/pair/${code}`, headers: as(a) })
      expect(info.json()).toMatchObject({ deviceName: 'Quest 3', purpose: 'visitor' })
      expect((await claim(code)).json()).toEqual({ status: 'pending' })
      // kind is ignored for a visitor code
      expect((await approve(code, a, {})).json()).toEqual({ result: 'approved' })
      const res = await claim(code)
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toMatchObject({ status: 'approved', purpose: 'visitor', session: { user: { id: a.id } } })
      // an id for BEAT writes (the Quest's `X-Virvi-Device`), though the row is no headset: see the mint below
      expect(body.deviceId).toBe((await db.select().from(arDevices))[0].id)
      const claims = app.jwt.verify<Record<string, unknown>>(body.session.accessToken)
      expect(claims).toMatchObject({ id: a.id, kind: 'account', verified: true })
      expect(claims.deviceId).toBeUndefined()
      expect((await claim(code)).statusCode).toBe(404)
      // the row is spent, not a live headset
      const rows = await db.select().from(arDevices)
      expect(rows[0]).toMatchObject({ purpose: 'visitor', kind: 'personal', codeHash: null, status: 'revoked' })
      const mint = await app.inject({ method: 'POST', url: `/api/ar/devices/${rows[0].id}/pass`, payload: { secret: SECRET, spaceId: crypto.randomUUID() } })
      expect(mint.statusCode).toBe(401)
      const list = await app.inject({ method: 'GET', url: '/api/ar/devices', headers: as(a) })
      expect(list.json()).toEqual([])
    })

    it('refuses a trial approving a visitor code', async () => {
      const trial = await createUser({ wallet: null })
      await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, trial.id))
      const { code } = (await start({ purpose: 'visitor' })).json()
      const res = await app.inject({ method: 'POST', url: `/api/ar/pair/${code}/approve`, headers: as(trial, { kind: 'trial' }), payload: {} })
      expect(res.statusCode).toBe(403)
      expect((await claim(code)).json()).toEqual({ status: 'pending' })
    })

    it('rejects an unknown purpose', async () => {
      expect((await start({ purpose: 'admin' })).statusCode).toBe(400)
    })

    it('a builder pairing behaves as before', async () => {
      const a = await createUser({ wallet: null })
      const { code } = (await start()).json()
      expect((await app.inject({ method: 'GET', url: `/api/ar/pair/${code}`, headers: as(a) })).json()).toEqual({ deviceName: 'Quest 3', codeExpiresAt: expect.any(String), purpose: 'builder' })
      expect((await approve(code, a, { kind: 'shared' })).json()).toEqual({ result: 'approved' })
      const body = (await claim(code)).json()
      const [row] = await db.select().from(arDevices)
      expect(body).toEqual({ status: 'approved', deviceId: row.id, kind: 'shared', expiresAt: row.expiresAt!.toISOString() })
      const b = await createUser({ wallet: null })
      const { code: c2 } = (await start()).json()
      expect((await approve(c2, b, { kind: 'bogus' })).statusCode).toBe(400)
    })
  })

  describe('Apple app id', () => {
    it('serves the app\'s id in the apple-app-site-association file by default', async () => {
      const res = await app.inject({ method: 'GET', url: '/.well-known/apple-app-site-association' })
      expect(res.json().applinks.details[0].appIDs).toContain('P22YGT64VU.io.virvi.app')
    })
  })
})
