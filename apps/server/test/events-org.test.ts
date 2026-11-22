import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { events, organizations, orgMembers } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, tokenFor, testApp } from './helpers/factories.js'

describe('events record the organization they were made in', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  const create = (user: Awaited<ReturnType<typeof createUser>>, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { authorization: `Bearer ${tokenFor(user, extra)}` },
      payload: { name: 'Launch party' },
    })

  async function orgWith(owner: Awaited<ReturnType<typeof createUser>>, member?: Awaited<ReturnType<typeof createUser>>) {
    const [org] = await db.insert(organizations).values({ name: 'Acme', slug: 'acme', billingOwnerId: owner.id }).returning()
    await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: 'owner' })
    if (member) await db.insert(orgMembers).values({ orgId: org.id, userId: member.id, role: 'member' })
    return org
  }

  it('stores the active organization from the token', async () => {
    const me = await createUser()
    const org = await orgWith(me)
    const res = await create(me, { orgId: org.id })
    expect(res.statusCode).toBe(201)
    expect(res.json().event.orgId).toBe(org.id)
    const [row] = await db.select().from(events).where(eq(events.id, res.json().event.id))
    expect(row.orgId).toBe(org.id)
  })

  it('stores null on a personal token', async () => {
    const me = await createUser()
    const res = await create(me)
    expect(res.statusCode).toBe(201)
    expect(res.json().event.orgId).toBeNull()
  })

  it('does not widen access: another member of the org still cannot read it', async () => {
    const me = await createUser()
    const other = await createUser()
    const org = await orgWith(me, other)
    const id = (await create(me, { orgId: org.id })).json().event.id
    const res = await app.inject({
      method: 'GET',
      url: `/api/events/${id}`,
      headers: { authorization: `Bearer ${tokenFor(other, { orgId: org.id })}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
