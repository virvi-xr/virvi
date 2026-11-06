import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { Wallet } from 'ethers'
import { db } from '../src/db/connection.js'
import { users } from '../src/db/schema.js'
import { config, trialsEnabledFrom } from '../src/config.js'
import { trialsAvailable } from '../src/auth/turnstile.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { finishOAuth } from '../src/auth/trial-convert.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser } from './helpers/factories.js'

describe('TRIALS_ENABLED', () => {
  it('defaults on in cloud mode and off in single and scalable mode; true or false overrides', () => {
    expect(trialsEnabledFrom(undefined, 'cloud')).toBe(true)
    expect(trialsEnabledFrom(undefined, 'single')).toBe(false)
    expect(trialsEnabledFrom('', 'scalable')).toBe(false)
    expect(trialsEnabledFrom('true', 'single')).toBe(true)
    expect(trialsEnabledFrom('false', 'cloud')).toBe(false)
  })

  it('refuses to start on another value rather than guess', () => {
    expect(() => trialsEnabledFrom('yes', 'cloud')).toThrow(/TRIALS_ENABLED/)
  })

  it('trials are unavailable while switched off, and starting one is 503 trials_unavailable', async () => {
    const saved = config.trialsEnabled
    ;(config as any).trialsEnabled = false
    const app = await testApp()
    try {
      expect(trialsAvailable()).toBe(false)
      const res = await app.inject({ method: 'POST', url: '/api/auth/trial', payload: { deviceId: 'device-off'.padEnd(20, 'x') } })
      expect([res.statusCode, res.json().error]).toEqual([503, 'trials_unavailable'])
    } finally {
      ;(config as any).trialsEnabled = saved
      await app.close()
    }
  })
})

describe('the first account on a self-hosted install is admin, trial guests aside', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())
  expect(config.autoPromoteFirstUser).toBe(true) // VIRVI_MODE=single in tests

  async function makeTrial() {
    const u = await createUser({ email: null, name: 'Guest' })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, u.id))
    const s = issueTrialSession(app, { id: u.id, displayName: u.displayName, role: 'creator', trialLastActiveAt: new Date() })
    return { u, headers: { authorization: `Bearer ${s.accessToken}` } }
  }
  const register = (email: string, headers?: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/auth/register', headers, payload: { email, password: 'hunter2hunter2', displayName: 'First' } })

  it('email sign-up after a trial was started elsewhere', async () => {
    await makeTrial()
    const res = await register('first@test.dev')
    expect(res.statusCode).toBe(201)
    expect(res.json().user.role).toBe('admin')
    expect((await register('second@test.dev')).json().user.role).toBe('creator')
  })

  it('Google or Discord sign-in after a trial was started', async () => {
    await makeTrial()
    const s = await finishOAuth(app, { type: 'oauth', identifier: 'google:first', email: 'g@test.dev', displayName: 'G', metadata: {} })
    expect(s.user.role).toBe('admin')
  })

  it('wallet sign-in after a trial was started', async () => {
    await makeTrial()
    const w = Wallet.createRandom()
    const ch = (await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: w.address } })).json()
    const res = await app.inject({ method: 'POST', url: '/api/auth/wallet/verify', payload: { address: w.address, nonce: ch.nonce, signature: await w.signMessage(ch.message) } })
    expect(res.json().user.role).toBe('admin')
  })

  it('a trial that converts into the first account becomes admin', async () => {
    const t = await makeTrial()
    const res = await register('t@test.dev', t.headers)
    expect(res.json().user).toMatchObject({ id: t.u.id, role: 'admin' })
  })

  it('a trial converting once an account exists stays a creator', async () => {
    await register('first@test.dev')
    const t = await makeTrial()
    expect((await register('t@test.dev', t.headers)).json().user).toMatchObject({ id: t.u.id, role: 'creator' })
  })
})
