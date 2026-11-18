import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { TERMS_VERSION } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { termsAcceptances, users } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('Terms of Service agreement', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(async () => { await app.close() })

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const status = (token: string) => app.inject({ method: 'GET', url: '/api/auth/terms', headers: auth(token) })
  const agree = (token: string, version: unknown) =>
    app.inject({ method: 'POST', url: '/api/auth/terms', headers: auth(token), payload: { version } })
  const register = (email: string, acceptTerms?: unknown) =>
    app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'longenough1', displayName: 'Nia', acceptTerms } })
  const rows = async (userId: string) => db.select().from(termsAcceptances).where(eq(termsAcceptances.userId, userId))

  it('an account that never agreed is asked to', async () => {
    const u = await createUser()
    const res = await status(tokenFor(u))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ version: TERMS_VERSION, accepted: false, acceptedVersion: null })
  })

  it('agreeing to the current version records it once, and the account is not asked again', async () => {
    const u = await createUser()
    const res = await agree(tokenFor(u), TERMS_VERSION)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ version: TERMS_VERSION, accepted: true, acceptedVersion: TERMS_VERSION })
    expect((await agree(tokenFor(u), TERMS_VERSION)).statusCode).toBe(200)
    const recorded = await rows(u.id)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ version: TERMS_VERSION, via: 'prompt' })
    expect((await status(tokenFor(u))).json().accepted).toBe(true)
  })

  it('agreeing to a version that is not the current one is refused', async () => {
    const u = await createUser()
    for (const version of ['2020-01-01', undefined, 42]) {
      const res = await agree(tokenFor(u), version)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'stale_terms', version: TERMS_VERSION })
    }
    expect(await rows(u.id)).toEqual([])
  })

  it('after the Terms change, an account that agreed to the old version is asked again and keeps its history', async () => {
    const u = await createUser()
    await db.insert(termsAcceptances).values({ userId: u.id, version: '2020-01-01', via: 'sign-up' })
    expect((await status(tokenFor(u))).json()).toEqual({ version: TERMS_VERSION, accepted: false, acceptedVersion: '2020-01-01' })
    await agree(tokenFor(u), TERMS_VERSION)
    expect((await rows(u.id)).map((r) => r.version).sort()).toEqual(['2020-01-01', TERMS_VERSION])
  })

  it('signing up with the box ticked for the current version records the agreement', async () => {
    const res = await register('nia@test.dev', TERMS_VERSION)
    expect(res.statusCode).toBe(201)
    expect((await status(res.json().accessToken)).json().accepted).toBe(true)
    const [user] = await db.select().from(users).where(eq(users.email, 'nia@test.dev'))
    expect(await rows(user.id)).toMatchObject([{ version: TERMS_VERSION, via: 'sign-up' }])
  })

  it('signing up without agreeing (or to an old version) still makes the account, which is then asked', async () => {
    for (const [email, accept] of [['a@test.dev', undefined], ['b@test.dev', '2020-01-01'], ['c@test.dev', true]] as const) {
      const res = await register(email, accept)
      expect(res.statusCode).toBe(201)
      expect((await status(res.json().accessToken)).json().accepted).toBe(false)
    }
  })

  it('deleting the user removes their agreements', async () => {
    const u = await createUser()
    await agree(tokenFor(u), TERMS_VERSION)
    await db.delete(users).where(eq(users.id, u.id))
    expect(await rows(u.id)).toEqual([])
  })
})
