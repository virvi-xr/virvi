import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { Wallet } from 'ethers'
import { createSigner } from 'fast-jwt'
import { db } from '../src/db/connection.js'
import { users, userAuthMethods, studioDesigns, studioUsageDays } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { TRIAL_DAY, reservePrompt } from '../src/studio/quota.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { finishOAuth } from '../src/auth/trial-convert.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'
import { createDesign } from './helpers/studio.js'

describe('converting and merging a trial', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = config.studioEnabled
  beforeAll(() => { ;(config as any).studioEnabled = true })
  afterAll(() => { ;(config as any).studioEnabled = prev; setStudioStore(null) })
  beforeEach(async () => { await resetDb(); setStudioStore(memoryStudioStore()); app = await testApp() })
  afterEach(() => app.close())

  async function makeTrial(opts: { designs?: number; prompts?: number } = {}) {
    const u = await createUser({ email: null, name: 'Guest' })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, u.id))
    for (let i = 0; i < (opts.designs ?? 1); i++) await createDesign(u, { name: `Trial ${i}` })
    for (let i = 0; i < (opts.prompts ?? 0); i++) await reservePrompt(u.id, new Date(), { counted: true })
    const s = issueTrialSession(app, { id: u.id, displayName: u.displayName, role: 'creator', trialLastActiveAt: new Date() })
    return { u, ...s, headers: { authorization: `Bearer ${s.accessToken}` } }
  }
  const owned = async (id: string) => (await db.select().from(studioDesigns).where(eq(studioDesigns.ownerId, id))).length

  it('email sign-up from a trial keeps the same id, its designs, and resets prompts', async () => {
    const t = await makeTrial({ designs: 1, prompts: 2 })
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers: t.headers, payload: { email: 'New@Test.dev', password: 'hunter2hunter2', displayName: 'Newbie', fromAction: 'more_prompts' } })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.user).toMatchObject({ id: t.u.id, email: 'new@test.dev', displayName: 'Newbie' })
    expect(await owned(t.u.id)).toBe(1)
    const [row] = await db.select().from(users).where(eq(users.id, t.u.id))
    expect(row.isTrial).toBe(false)
    expect(await db.select().from(studioUsageDays).where(eq(studioUsageDays.userId, t.u.id))).toEqual([])
    const usage = await app.inject({ method: 'GET', url: '/api/studio/usage', headers: { authorization: `Bearer ${body.accessToken}` } })
    expect(usage.json()).toMatchObject({ left: 3 })
    expect(usage.json().trial).toBeFalsy()
  })

  it('email sign-up from a trial with a taken email is still 409 and leaves the trial alone', async () => {
    const t = await makeTrial()
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'dup@test.dev', password: 'hunter2hunter2', displayName: 'A' } })
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers: t.headers, payload: { email: 'dup@test.dev', password: 'hunter2hunter2', displayName: 'B' } })
    expect(res.statusCode).toBe(409)
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].isTrial).toBe(true)
  })

  it('signing in from a trial moves its designs into the account and removes the trial', async () => {
    const t = await makeTrial({ designs: 2, prompts: 1 })
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'old@test.dev', password: 'hunter2hunter2', displayName: 'Old' } })
    const accountId = reg.json().user.id
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: t.headers, payload: { email: 'old@test.dev', password: 'hunter2hunter2', fromAction: 'x' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.id).toBe(accountId)
    expect(await owned(accountId)).toBe(2)
    expect(await db.query.users.findFirst({ where: eq(users.id, t.u.id) })).toBeUndefined()
    const usage = await app.inject({ method: 'GET', url: '/api/studio/usage', headers: { authorization: `Bearer ${res.json().accessToken}` } })
    expect(usage.json()).toMatchObject({ left: 3 })
  })

  async function walletVerify(w: Wallet, headers?: Record<string, string>) {
    const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: w.address } })
    const { nonce, message } = ch.json()
    return app.inject({ method: 'POST', url: '/api/auth/wallet/verify', headers, payload: { address: w.address, nonce, signature: await w.signMessage(message), fromAction: 'x' } })
  }

  it('wallet sign-in converts or merges', async () => {
    const t = await makeTrial({ designs: 1 })
    const w = Wallet.createRandom()
    const res = await walletVerify(w, t.headers)
    expect(res.statusCode).toBe(200)
    expect(res.json().user.id).toBe(t.u.id)
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].isTrial).toBe(false)
    expect(await owned(t.u.id)).toBe(1)

    const t2 = await makeTrial({ designs: 1 })
    const w2 = Wallet.createRandom()
    const known = await createUser({ wallet: w2.address })
    const res2 = await walletVerify(w2, t2.headers)
    expect(res2.statusCode).toBe(200)
    expect(res2.json().user.id).toBe(known.id)
    expect(await owned(known.id)).toBe(1)
    expect(await db.query.users.findFirst({ where: eq(users.id, t2.u.id) })).toBeUndefined()
  })

  const identity = (id: string) => ({ type: 'oauth' as const, identifier: `google:${id}`, email: `${id}@g.dev`, displayName: 'G User', metadata: { provider: 'google' } })
  const adopt = (accountToken: string, trialToken: unknown, fromAction?: string) =>
    app.inject({ method: 'POST', url: '/api/auth/trial/adopt', headers: { authorization: `Bearer ${accountToken}` }, payload: { trialToken, ...(fromAction ? { fromAction } : {}) } })

  it('after Google sign-in, the browser holding the trial session moves it into the account', async () => {
    const t = await makeTrial({ designs: 1 })
    const s = await finishOAuth(app, identity('new1'))
    expect(s.user.id).not.toBe(t.u.id)
    const res = await adopt(s.accessToken, t.refreshToken, 'more_prompts')
    expect([res.statusCode, res.json()]).toEqual([200, { moved: true }])
    expect(await owned(s.user.id)).toBe(1)
    expect(await db.query.users.findFirst({ where: eq(users.id, t.u.id) })).toBeUndefined()
    // a second hand-over of the same trial finds nothing to move
    expect((await adopt(s.accessToken, t.refreshToken)).json()).toEqual({ moved: false })
  })

  it('an expired trial access token still hands the trial over (the browser holds the session)', async () => {
    const t = await makeTrial({ designs: 1 })
    const s = await finishOAuth(app, identity('exp1'))
    const expired = createSigner({ key: config.jwtSecret, expiresIn: 1 })({ id: t.u.id, kind: 'trial', role: 'creator', displayName: 'Guest' })
    await new Promise((r) => setTimeout(r, 5))
    expect((await adopt(s.accessToken, expired)).json()).toEqual({ moved: true })
    expect(await owned(s.user.id)).toBe(1)
  })

  it('a forged token, an account token or garbage moves nothing', async () => {
    const t = await makeTrial({ designs: 1 })
    const s = await finishOAuth(app, identity('f1'))
    const forged = createSigner({ key: 'other-secret', expiresIn: 600_000 })({ id: t.u.id, kind: 'trial' })
    for (const bad of [forged, s.accessToken, 'garbage', 42, undefined]) {
      const res = await adopt(s.accessToken, bad)
      expect([res.statusCode, res.json()]).toEqual([200, { moved: false }])
    }
    expect(await owned(t.u.id)).toBe(1)
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].isTrial).toBe(true)
  })

  it('only an account can take a trial over: a trial bearer or no bearer is refused', async () => {
    const t = await makeTrial()
    const t2 = await makeTrial()
    const asTrial = await adopt(t2.accessToken, t.refreshToken)
    expect([asTrial.statusCode, asTrial.json().error]).toEqual([403, 'account_required'])
    const none = await app.inject({ method: 'POST', url: '/api/auth/trial/adopt', payload: { trialToken: t.refreshToken } })
    expect(none.statusCode).toBe(401)
  })

  it('an OAuth start link carries no trial: a crafted ?claim= is ignored', async () => {
    const t = await makeTrial({ designs: 1 })
    const prev = [config.googleClientId, config.googleClientSecret]
    ;(config as any).googleClientId = 'cid'; (config as any).googleClientSecret = 'sec'
    const res = await app.inject({ method: 'GET', url: `/api/auth/google?claim=${t.accessToken}` })
    ;(config as any).googleClientId = prev[0]; (config as any).googleClientSecret = prev[1]
    expect(res.statusCode).toBe(302)
    expect(String(res.headers.location)).not.toContain('state=')
    expect(await owned(t.u.id)).toBe(1)
  })

  it('an OAuth start passes a well-formed state through, and drops a malformed one', async () => {
    const prev = [config.googleClientId, config.googleClientSecret]
    ;(config as any).googleClientId = 'cid'; (config as any).googleClientSecret = 'sec'
    const ok = await app.inject({ method: 'GET', url: '/api/auth/google?state=AbCdEfGhIjKlMnOpQrStUv_-' })
    const bad = await app.inject({ method: 'GET', url: '/api/auth/google?state=x.y' })
    ;(config as any).googleClientId = prev[0]; (config as any).googleClientSecret = prev[1]
    expect(new URL(String(ok.headers.location)).searchParams.get('state')).toBe('AbCdEfGhIjKlMnOpQrStUv_-')
    expect(String(bad.headers.location)).not.toContain('state=')
  })

  it('a trial idle past its expiry is not handed over (the sweep may be removing it)', async () => {
    const t = await makeTrial({ designs: 1 })
    await db.update(users).set({ trialLastActiveAt: new Date(Date.now() - (config.trialIdleDays + 1) * 86400_000) }).where(eq(users.id, t.u.id))
    const s = await finishOAuth(app, identity('idle1'))
    expect((await adopt(s.accessToken, t.refreshToken)).json()).toEqual({ moved: false })
  })

  it("the trial's old tokens are refused after conversion", async () => {
    const t = await makeTrial()
    await app.inject({ method: 'POST', url: '/api/auth/register', headers: t.headers, payload: { email: 'c@test.dev', password: 'hunter2hunter2', displayName: 'C' } })
    const a = await app.inject({ method: 'GET', url: '/api/studio/designs', headers: t.headers })
    expect([a.statusCode, a.json().error]).toEqual([401, 'trial_ended'])
    const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${t.refreshToken}` } })
    expect([r.statusCode, r.json().error]).toEqual([401, 'trial_ended'])
  })

  /** A trial access token for `t` that ran out a minute ago (signed with the server's own key). */
  const expiredTrialHeaders = (t: { u: { id: string } }) => {
    const iat = Math.floor(Date.now() / 1000) - 3600
    const tok = createSigner({ key: config.jwtSecret })({ id: t.u.id, role: 'creator', kind: 'trial', iat, exp: iat + 60 })
    return { authorization: `Bearer ${tok}` }
  }

  it('sign-up with an expired trial bearer is 401 trial_expired, not a separate account', async () => {
    const t = await makeTrial({ designs: 1 })
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers: expiredTrialHeaders(t), payload: { email: 'late@test.dev', password: 'hunter2hunter2', displayName: 'Late' } })
    expect([res.statusCode, res.json().error]).toEqual([401, 'trial_expired'])
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, 'late@test.dev') })).toBeUndefined()
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].isTrial).toBe(true)
  })

  it('sign-in and wallet sign-in with an expired trial bearer are 401 trial_expired', async () => {
    const t = await makeTrial({ designs: 1 })
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'acct@test.dev', password: 'hunter2hunter2', displayName: 'Acct' } })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: expiredTrialHeaders(t), payload: { email: 'acct@test.dev', password: 'hunter2hunter2' } })
    expect([login.statusCode, login.json().error]).toEqual([401, 'trial_expired'])
    const wallet = await walletVerify(Wallet.createRandom(), expiredTrialHeaders(t))
    expect([wallet.statusCode, wallet.json().error]).toEqual([401, 'trial_expired'])
    expect(await owned(t.u.id)).toBe(1)
  })

  it('TRIAL_DAY usage never lands on the account when merging', async () => {
    const t = await makeTrial({ prompts: 2 })
    const acct = await createUser()
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'm@test.dev', password: 'hunter2hunter2', displayName: 'M' } })
    await app.inject({ method: 'POST', url: '/api/auth/login', headers: t.headers, payload: { email: 'm@test.dev', password: 'hunter2hunter2' } })
    expect(await db.select().from(studioUsageDays).where(eq(studioUsageDays.day, TRIAL_DAY))).toEqual([])
    void acct; void reg
  })
})
