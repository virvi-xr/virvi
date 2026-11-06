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

  const ticketFor = async (t: { headers: Record<string, string> }) =>
    (await app.inject({ method: 'POST', url: '/api/auth/trial/claim', headers: t.headers })).json().ticket as string
  const identity = (id: string) => ({ type: 'oauth' as const, identifier: `google:${id}`, email: `${id}@g.dev`, displayName: 'G User', metadata: { provider: 'google' } })

  it('Google from a trial with a claim ticket converts; an existing identity merges', async () => {
    const t = await makeTrial({ designs: 1 })
    const ticket = await ticketFor(t)
    expect(app.jwt.verify<any>(ticket)).toMatchObject({ id: t.u.id, kind: 'trial_claim' })
    const s = await finishOAuth(app, identity('new1'), ticket)
    expect(s.user.id).toBe(t.u.id)
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0]).toMatchObject({ isTrial: false, email: 'new1@g.dev' })
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.userId, t.u.id) })).toMatchObject({ identifier: 'google:new1' })

    const t2 = await makeTrial({ designs: 1 })
    const first = await finishOAuth(app, identity('old1'), undefined)
    const s2 = await finishOAuth(app, identity('old1'), await ticketFor(t2))
    expect(s2.user.id).toBe(first.user.id)
    expect(await owned(first.user.id)).toBe(1)
    expect(await db.query.users.findFirst({ where: eq(users.id, t2.u.id) })).toBeUndefined()
  })

  it('a forged or stale claim is ignored', async () => {
    const t = await makeTrial({ designs: 1 })
    const forged = createSigner({ key: 'other-secret', expiresIn: 600_000 })({ id: t.u.id, kind: 'trial_claim' })
    const s = await finishOAuth(app, identity('f1'), forged)
    expect(s.user.id).not.toBe(t.u.id)
    expect((await db.select().from(users).where(eq(users.id, t.u.id)))[0].isTrial).toBe(true)
    expect(await owned(t.u.id)).toBe(1)

    const ticket = await ticketFor(t)
    await finishOAuth(app, identity('f2'), ticket)
    const stale = await finishOAuth(app, identity('f3'), ticket)
    expect(stale.user.id).not.toBe(t.u.id)
    expect(await owned(t.u.id)).toBe(1)
    // garbage and an access token are not tickets
    expect((await finishOAuth(app, identity('f4'), 'garbage')).user.id).not.toBe(t.u.id)
    const t2 = await makeTrial()
    expect((await finishOAuth(app, identity('f5'), t2.accessToken)).user.id).not.toBe(t2.u.id)
  })

  it('a claim ticket is not a bearer token, and only a trial can ask for one', async () => {
    const t = await makeTrial()
    const ticket = await ticketFor(t)
    const res = await app.inject({ method: 'GET', url: '/api/studio/designs', headers: { authorization: `Bearer ${ticket}` } })
    expect(res.statusCode).toBe(401)
    const acct = await createUser()
    const no = await app.inject({ method: 'POST', url: '/api/auth/trial/claim', headers: { authorization: `Bearer ${tokenFor(acct)}` } })
    expect(no.statusCode).toBe(403)
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
    const claim = await app.inject({ method: 'POST', url: '/api/auth/trial/claim', headers: expiredTrialHeaders(t), payload: {} })
    expect([claim.statusCode, claim.json().error]).toEqual([401, 'trial_expired'])
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
