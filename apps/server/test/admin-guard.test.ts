import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { events, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign } from './helpers/studio.js'

/**
 * Admin power is the database's role, read on every request: a token minted before a demotion opens no admin route
 * (the role route included), no admin override, and no other person's design; one minted before a promotion works.
 */
describe('the admin role comes from the database', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let admin: TestUser
  let other: TestUser
  const prev = config.studioEnabled
  beforeAll(() => { (config as any).studioEnabled = true })
  afterAll(() => { (config as any).studioEnabled = prev })
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    admin = await createUser({ role: 'admin' })
    other = await createUser()
  })
  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any })

  const ADMIN_ROUTES = (f: { other: TestUser; admin: TestUser }): [string, string, unknown?][] => [
    ['GET', '/api/admin/stats'],
    ['GET', `/api/admin/users/${f.other.id}`],
    ['PUT', `/api/admin/users/${f.admin.id}/role`, { role: 'admin' }],
    ['GET', '/api/admin/ads'],
    ['GET', '/api/admin/advertiser-leads'],
    ['GET', '/api/admin/studio/flags'],
    ['GET', '/api/admin/studio/designs'],
  ]

  it('an admin’s token works on every admin route while they are one', async () => {
    const token = tokenFor(admin)
    for (const [m, url, body] of ADMIN_ROUTES({ other, admin })) {
      expect((await call(m, url, token, body)).statusCode, `${m} ${url}`).not.toBe(403)
    }
  })

  it('a demoted admin’s still-valid token gets 403 on every admin route, and can’t make itself admin again', async () => {
    const token = tokenFor(admin) // minted while admin
    await db.update(users).set({ role: 'creator' }).where(eq(users.id, admin.id))
    for (const [m, url, body] of ADMIN_ROUTES({ other, admin })) {
      expect((await call(m, url, token, body)).statusCode, `${m} ${url}`).toBe(403)
    }
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, admin.id))
    expect(row.role).toBe('creator')
  })

  it('a demoted admin’s token loses admin overrides elsewhere and Virvi support on designs', async () => {
    const token = tokenFor(admin)
    const [event] = await db.insert(events).values({ ownerId: other.id, name: 'Not yours' }).returning()
    const design = await createDesign(other)
    expect((await call('GET', `/api/events/${event.id}`, token)).statusCode).toBe(200)
    expect((await call('GET', `/api/studio/designs/${design.id}`, token)).statusCode).toBe(200)
    await db.update(users).set({ role: 'creator' }).where(eq(users.id, admin.id))
    expect((await call('GET', `/api/events/${event.id}`, token)).statusCode).toBe(403)
    expect((await call('GET', `/api/studio/designs/${design.id}`, token)).statusCode).toBe(404)
    expect((await call('POST', `/api/studio/designs/${design.id}/prompts`, token, { text: 'help' })).statusCode).toBe(404)
  })

  it('a token minted before a promotion is an admin’s at once, on the admin list and on designs alike', async () => {
    const token = tokenFor(other) // minted as a creator
    const design = await createDesign(admin)
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, other.id))
    expect((await call('GET', '/api/admin/studio/designs', token)).statusCode).toBe(200)
    expect((await call('GET', `/api/studio/designs/${design.id}`, token)).statusCode).toBe(200)
  })
})
