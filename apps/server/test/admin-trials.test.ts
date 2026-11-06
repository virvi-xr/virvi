import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { users } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('admin user counts leave trial guests out', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  async function setup() {
    const admin = await createUser({ role: 'admin', name: 'Admin' })
    await createUser({ name: 'Real' })
    for (let i = 0; i < 2; i++) {
      const t = await createUser({ email: null, name: i ? 'Guest' : 'Real guest' })
      await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    }
    return { authorization: `Bearer ${tokenFor(admin)}` }
  }

  it('stats count accounts only, and report trial guests separately', async () => {
    const headers = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/admin/stats', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ totalUsers: 2, trialGuests: 2 })
  })

  it('the user list and its total skip trial guests, searched or not (a guest is named Real too)', async () => {
    const headers = await setup()
    const all = await app.inject({ method: 'GET', url: '/api/admin/users', headers })
    expect(all.json().total).toBe(2)
    expect(all.json().users.map((u: { displayName: string }) => u.displayName).sort()).toEqual(['Admin', 'Real'])
    const searched = await app.inject({ method: 'GET', url: '/api/admin/users?search=real', headers })
    expect(searched.json().users.map((u: { displayName: string }) => u.displayName).sort()).toEqual(['Real'])
    expect(searched.json().total).toBe(1)
  })
})
