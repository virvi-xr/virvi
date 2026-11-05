import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { organizations, orgMembers, users } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

const as = (u: any) => ({ authorization: `Bearer ${tokenFor(u)}` })
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** Settings → Your Organizations reads these flat shapes (LIV-93). */
describe('organization responses', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it("lists the user's orgs with their role, member count and which one is active", async () => {
    const me = await createUser({ name: 'Me' })
    const other = await createUser({ name: 'Other' })
    const [a] = await db.insert(organizations).values({ name: 'Alpha', slug: 'alpha', billingOwnerId: me.id }).returning()
    const [b] = await db.insert(organizations).values({ name: 'Beta', slug: 'beta', billingOwnerId: other.id }).returning()
    await db.insert(orgMembers).values([
      { orgId: a.id, userId: me.id, role: 'owner' },
      { orgId: a.id, userId: other.id, role: 'member' },
      { orgId: b.id, userId: other.id, role: 'owner' },
      { orgId: b.id, userId: me.id, role: 'admin' },
    ])
    await db.update(users).set({ activeOrgId: b.id }).where(eq(users.id, me.id))
    const res = await app.inject({ method: 'GET', url: '/api/orgs', headers: as(me) })
    expect(res.statusCode).toBe(200)
    const orgs = res.json().organizations.sort((x: any, y: any) => x.name.localeCompare(y.name))
    expect(orgs).toEqual([
      { id: a.id, name: 'Alpha', slug: 'alpha', logoUrl: null, role: 'owner', memberCount: 2, isActive: false },
      { id: b.id, name: 'Beta', slug: 'beta', logoUrl: null, role: 'admin', memberCount: 2, isActive: true },
    ])
  })

  it('a new org comes back in the same shape, with the creator as owner', async () => {
    const me = await createUser()
    const res = await app.inject({ method: 'POST', url: '/api/orgs', headers: as(me), payload: { name: 'Gamma Crew' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().organization).toEqual({
      id: expect.any(String), name: 'Gamma Crew', slug: 'gamma-crew', logoUrl: null, role: 'owner', memberCount: 1, isActive: true,
    })
    // A second one isn't made active over the first
    const second = await app.inject({ method: 'POST', url: '/api/orgs', headers: as(me), payload: { name: 'Delta' } })
    expect(second.json().organization).toMatchObject({ role: 'owner', memberCount: 1, isActive: false })
  })

  it('lists members flat, with their name, email and wallet, never only an id', async () => {
    const me = await createUser({ name: 'Me', email: 'me@x.io' })
    const walletOnly = await createUser({ name: '', email: null, wallet: '0x00000000000000000000000000000000000000Ab' })
    const [org] = await db.insert(organizations).values({ name: 'Org', slug: 'org', billingOwnerId: me.id }).returning()
    await db.insert(orgMembers).values([{ orgId: org.id, userId: me.id, role: 'owner' }, { orgId: org.id, userId: walletOnly.id, role: 'member' }])
    const res = await app.inject({ method: 'GET', url: `/api/orgs/${org.id}/members`, headers: as(me) })
    expect(res.statusCode).toBe(200)
    const members = res.json().members.sort((x: any, y: any) => x.role.localeCompare(y.role))
    expect(members).toEqual([
      { userId: walletOnly.id, role: 'member', joinedAt: expect.any(String), displayName: '', email: null, walletAddress: '0x00000000000000000000000000000000000000ab' },
      { userId: me.id, role: 'owner', joinedAt: expect.any(String), displayName: 'Me', email: 'me@x.io', walletAddress: null },
    ])
    expect(JSON.stringify(members.map(({ userId, ...rest }: any) => rest))).not.toMatch(UUID)
  })
})
