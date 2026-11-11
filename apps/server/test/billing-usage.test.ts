import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { streamingServers, streamingSessions, subscriptions } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('GET /api/billing/usage', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  const usage = (u: Awaited<ReturnType<typeof createUser>>) =>
    app.inject({ method: 'GET', url: '/api/billing/usage', headers: { authorization: `Bearer ${tokenFor(u)}` } })

  it('answers a free account', async () => {
    const u = await createUser()
    const res = await usage(u)
    expect(res.statusCode, res.body).toBe(200)
  })

  it('answers an account with a Stripe customer but no plan (it paid for the Design Studio)', async () => {
    const u = await createUser()
    await db.insert(subscriptions).values({ userId: u.id, stripeCustomerId: 'cus_1', tier: 'free', status: 'active' })
    const res = await usage(u)
    expect(res.statusCode, res.body).toBe(200)
  })
  it('answers a paid plan, and counts only the caller\'s own streaming minutes this period', async () => {
    const me = await createUser()
    const other = await createUser()
    const periodStart = new Date(Date.now() - 10 * 24 * 3600_000)
    await db.insert(subscriptions).values({ userId: me.id, stripeCustomerId: 'cus_me', tier: 'creator', status: 'active', currentPeriodStart: periodStart })
    const [mine] = await db.insert(streamingServers).values({ ownerId: me.id, name: 'Mine' }).returning()
    const [theirs] = await db.insert(streamingServers).values({ ownerId: other.id, name: 'Theirs' }).returning()
    await db.insert(streamingSessions).values([
      { serverId: mine.id, startedAt: new Date(), durationSeconds: 90 }, // 1.5 minutes this period
      { serverId: mine.id, startedAt: new Date(periodStart.getTime() - 3600_000), durationSeconds: 6000 }, // before the period
      { serverId: theirs.id, startedAt: new Date(), durationSeconds: 60_000 }, // someone else's
    ])
    const res = await usage(me)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ tier: 'creator', usage: { streamMinutes: 2 } })
  })
})
