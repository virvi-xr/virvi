import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { db } from '../src/db/connection.js'
import { giveawayClaimMints, giveawayClaims, giveaways, userAuthMethods, users } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { giveawaysOn } from './helpers/giveaways-fake.js'

/** LIV-194 final review: deleting an account never cascades a giveaway (and its sealed key) away (I-1); a visitor's claims (M-10). */
describe('account deletion and giveaways (LIV-194)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let off: () => void
  beforeEach(async () => {
    await resetDb()
    ;({ off } = giveawaysOn())
    app = await testApp()
  })
  afterEach(async () => {
    off()
    await app.close()
  })

  async function withPassword(u: TestUser) {
    await db.insert(userAuthMethods).values({ userId: u.id, type: 'email', identifier: u.email!, credentialHash: await bcrypt.hash('pw-1234', 4) })
  }
  const selfDelete = (u: TestUser) =>
    app.inject({ method: 'DELETE', url: '/api/auth/account', payload: { password: 'pw-1234' }, headers: { authorization: `Bearer ${tokenFor(u)}` } })
  const adminDelete = async (u: TestUser) => {
    const admin = await createUser({ role: 'admin' })
    return app.inject({ method: 'DELETE', url: `/api/admin/users/${u.id}`, headers: { authorization: `Bearer ${tokenFor(admin)}` } })
  }
  const giveaway = (ownerId: string, set: Partial<typeof giveaways.$inferInsert> = {}) =>
    db.insert(giveaways).values({ ownerId, name: 'G', walletAddress: randomWallet(), walletKeyEnc: 'v1:x:y:z', ...set }).returning().then((r) => r[0])
  const userExists = async (id: string) => !!(await db.query.users.findFirst({ where: eq(users.id, id) }))

  for (const [label, del] of [['self-delete', selfDelete], ['admin delete', adminDelete]] as const) {
    it(`I-1 ${label}: refused (409 giveaways_first) while the user owns a giveaway not yet deleted; allowed once it is`, async () => {
      const host = await createUser({ wallet: randomWallet() })
      await withPassword(host)
      const g = await giveaway(host.id)
      // One whose delete is still returning the float counts too
      await giveaway(host.id, { deleteState: 'returning', enabled: false })
      const res = await del(host)
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json()).toEqual({ error: 'giveaways_first', message: 'Delete your giveaways in Drops first (send back your POL there), then delete your account.' })
      expect(await userExists(host.id)).toBe(true)
      expect((await db.select().from(giveaways).where(eq(giveaways.id, g.id)))[0].walletKeyEnc).toBe('v1:x:y:z')

      await db.update(giveaways).set({ deletedAt: new Date(), walletKeyEnc: null }).where(eq(giveaways.ownerId, host.id))
      expect((await del(host)).statusCode).toBe(204)
      expect(await userExists(host.id)).toBe(false)
    })
  }

  it("M-10: a visitor's deletion drops their present claims and keeps queued and settled ones, unlinked", async () => {
    const host = await createUser({ wallet: randomWallet() })
    const g = await giveaway(host.id)
    const g2 = await giveaway(host.id)
    const g3 = await giveaway(host.id)
    const v = await createUser({ wallet: randomWallet() })
    await withPassword(v)
    const claim = async (gid: string, status: 'present' | 'waiting' | 'sent') =>
      (await db.insert(giveawayClaims).values({ giveawayId: gid, userId: v.id, wallet: v.wallet!.toLowerCase(), consentVersion: 1, status }).returning())[0]
    const present = await claim(g.id, 'present')
    const waiting = await claim(g2.id, 'waiting')
    await db.insert(giveawayClaimMints).values({ claimId: waiting.id, contractAddress: randomWallet() })
    const sent = await claim(g3.id, 'sent')
    expect((await selfDelete(v)).statusCode).toBe(204)
    const rows = await db.select().from(giveawayClaims)
    expect(rows.find((r) => r.id === present.id)).toBeUndefined()
    expect(rows.find((r) => r.id === waiting.id)).toMatchObject({ status: 'waiting', userId: null })
    expect(rows.find((r) => r.id === sent.id)).toMatchObject({ status: 'sent', userId: null })
  })
})
