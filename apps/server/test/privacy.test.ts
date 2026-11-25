import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { PRIVACY_NOTICE_VERSION, TERMS_VERSION } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { privacyDecisions, termsAcceptances, users } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('dashboard privacy notice', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(async () => { await app.close() })

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const status = (token: string) => app.inject({ method: 'GET', url: '/api/auth/privacy', headers: auth(token) })
  const decide = (token: string, decision: unknown, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/auth/privacy', headers: auth(token), payload: { decision, version: PRIVACY_NOTICE_VERSION, ...extra } })
  const rows = (userId: string) => db.select().from(privacyDecisions).where(eq(privacyDecisions.userId, userId))

  it('an account that never decided has no decision', async () => {
    const u = await createUser()
    const res = await status(tokenFor(u))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ version: PRIVACY_NOTICE_VERSION, decision: null, decidedAt: null })
    expect((await app.inject({ method: 'GET', url: '/api/auth/privacy' })).statusCode).toBe(401)
  })

  it('records a decision with where it was made, and returns it with its time', async () => {
    const u = await createUser()
    const res = await decide(tokenFor(u), 'decline')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ version: PRIVACY_NOTICE_VERSION, decision: 'decline' })
    expect(Date.parse(res.json().decidedAt)).toBeGreaterThan(Date.now() - 60_000)
    expect(await rows(u.id)).toMatchObject([{ decision: 'decline', version: PRIVACY_NOTICE_VERSION, via: 'prompt' }])
  })

  it('is append-only: a change from Settings adds a row and becomes the choice', async () => {
    const u = await createUser()
    await decide(tokenFor(u), 'decline')
    const res = await decide(tokenFor(u), 'accept', { via: 'settings' })
    expect(res.json().decision).toBe('accept')
    expect((await rows(u.id)).map((r) => [r.decision, r.via])).toEqual([['decline', 'prompt'], ['accept', 'settings']])
    expect((await status(tokenFor(u))).json().decision).toBe('accept')
  })

  it('refuses a stale version (400) and a bad decision, recording nothing', async () => {
    const u = await createUser()
    for (const version of [0, PRIVACY_NOTICE_VERSION + 1, String(PRIVACY_NOTICE_VERSION), undefined]) {
      const res = await decide(tokenFor(u), 'accept', { version })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'stale_version', version: PRIVACY_NOTICE_VERSION })
    }
    expect((await decide(tokenFor(u), 'sure')).statusCode).toBe(400)
    expect(await rows(u.id)).toEqual([])
  })

  it('a decision on an older notice is no decision: the account is asked again', async () => {
    const u = await createUser()
    await db.insert(privacyDecisions).values({ userId: u.id, decision: 'accept', version: PRIVACY_NOTICE_VERSION - 1, via: 'prompt' })
    expect((await status(tokenFor(u))).json().decision).toBeNull()
  })

  it('goes with the account when it is deleted', async () => {
    const u = await createUser()
    await decide(tokenFor(u), 'accept')
    await db.delete(users).where(eq(users.id, u.id))
    expect(await rows(u.id)).toEqual([])
  })

  it("admins see each account's Terms and privacy choice, and when, in the user list and detail", async () => {
    const admin = await createUser({ role: 'admin' })
    const u = await createUser({ name: 'Zed' })
    await db.insert(termsAcceptances).values({ userId: u.id, version: TERMS_VERSION, via: 'prompt' })
    await decide(tokenFor(u), 'decline')
    const list = (await app.inject({ method: 'GET', url: '/api/admin/users?search=Zed', headers: auth(tokenFor(admin)) })).json()
    const row = list.users.find((r: { id: string }) => r.id === u.id)
    expect(row.privacy).toMatchObject({ decision: 'decline', version: PRIVACY_NOTICE_VERSION })
    expect(Date.parse(row.privacy.decidedAt)).not.toBeNaN()
    expect(row.terms).toMatchObject({ accepted: true, acceptedVersion: TERMS_VERSION })
    const detail = (await app.inject({ method: 'GET', url: `/api/admin/users/${u.id}`, headers: auth(tokenFor(admin)) })).json()
    expect(detail.privacy).toMatchObject({ decision: 'decline' })
    expect(detail.terms).toMatchObject({ accepted: true })
    // Undecided accounts read as such
    const other = (await app.inject({ method: 'GET', url: '/api/admin/users', headers: auth(tokenFor(admin)) })).json().users.find((r: { id: string }) => r.id === admin.id)
    expect(other.privacy).toEqual({ version: PRIVACY_NOTICE_VERSION, decision: null, decidedAt: null })
  })
})
