import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  users, userAuthMethods, studioCredits, studioFlags, studioCreditLedger, studioDesigns, studioEntitlements, studioFinalizeCredits, studioGiftCodes, studioGiftRedemptions,
  studioIdeaUses, studioPauses, studioPayments, studioPromptCredits, studioUsageDays,
  notifications, studioDesignInvites, studioDesignMembers, studioJobs, studioMessages,
} from '../src/db/schema.js'
import { config } from '../src/config.js'
import { linkVerifiedWallet } from '../src/auth/wallet-users.js'
import { creditBalance } from '../src/studio/credit.js'
import { utcDay } from '../src/studio/quota.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, randomWallet, tokenFor } from './helpers/factories.js'
import { createDesign, addRevision, entitle } from './helpers/studio.js'

describe('studio data follows a wallet linked to an existing account', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = config.studioEnabled
  beforeAll(() => { ;(config as any).studioEnabled = true })
  afterAll(() => { ;(config as any).studioEnabled = prev; setStudioStore(null) })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    app = await testApp()
  })

  const shellWith = async () => { const w = randomWallet(); return { w, shell: await createUser({ role: 'viewer', email: null, wallet: w }) } }
  const today = () => utcDay(new Date())

  it('moves designs, payments, entitlements, counters and credit', async () => {
    const store = memoryStudioStore(); setStudioStore(store)
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    const d = await createDesign(shell)
    const rev = await addRevision(d, 'hat')
    const { payment, entitlement } = await entitle(d, rev)
    await store.put('pkg/hat.zip', Buffer.from('PK-hat'), 'application/zip')
    await db.update(studioEntitlements).set({ packageKey: 'pkg/hat.zip' }).where(eq(studioEntitlements.id, entitlement.id))
    await db.insert(studioUsageDays).values([{ userId: shell.id, day: today(), prompts: 3, costUsd: 0.5, promptHelps: 4 }, { userId: shell.id, day: '2020-01-01', prompts: 2, costUsd: 0.1 }])
    await db.insert(studioUsageDays).values({ userId: e.id, day: today(), prompts: 1, costUsd: 0.25, promptHelps: 1 })
    await db.insert(studioPromptCredits).values({ userId: shell.id, balance: 2, gifted: 4 })
    await db.insert(studioPromptCredits).values({ userId: e.id, balance: 1, gifted: 1 })
    await db.insert(studioFinalizeCredits).values({ userId: shell.id, balance: 1 })
    await db.insert(studioCredits).values([{ userId: shell.id, balanceCents: 1200 }, { userId: e.id, balanceCents: 300 }])
    await db.insert(studioIdeaUses).values({ ideaId: 'bucket-hat-palm', userId: shell.id, designId: d.id })

    expect(await linkVerifiedWallet(e.id, w)).toBe('linked')
    // the idea stays retired, now under the account
    expect(await db.select({ userId: studioIdeaUses.userId, designId: studioIdeaUses.designId }).from(studioIdeaUses)).toEqual([{ userId: e.id, designId: d.id }])

    expect((await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id)))[0].ownerId).toBe(e.id)
    expect((await db.select().from(studioPayments).where(eq(studioPayments.id, payment.id)))[0].userId).toBe(e.id)
    expect((await db.select().from(studioEntitlements).where(eq(studioEntitlements.id, entitlement.id)))[0].userId).toBe(e.id)
    const days = await db.select().from(studioUsageDays).where(eq(studioUsageDays.userId, e.id))
    expect(days.find((r) => r.day === today())).toMatchObject({ prompts: 4, costUsd: 0.75, promptHelps: 5 })
    expect(days.find((r) => r.day === '2020-01-01')?.prompts).toBe(2)
    expect((await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, e.id)))[0]).toMatchObject({ balance: 3, gifted: 5 })
    expect((await db.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, e.id)))[0].balance).toBe(1)
    expect(await creditBalance(e.id)).toBe(1500)
    const merges = (await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.userId, e.id))).filter((r) => r.reason === 'merge')
    // Both sides of the merge, the shell's having moved with its ledger
    expect(merges.map((r) => r.deltaCents).sort((a, b) => a - b)).toEqual([-1200, 1200])
    expect(await db.query.users.findFirst({ where: eq(users.id, shell.id) })).toBeUndefined()

    const res = await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/packages`, headers: { authorization: `Bearer ${tokenFor(e)}` } })
    expect(res.statusCode).toBe(200)
  })

  it("writes a merge ledger row on each side, and moves the source's ledger to the target", async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    await db.insert(studioCredits).values({ userId: shell.id, balanceCents: 700 })
    await db.insert(studioCreditLedger).values({ userId: shell.id, deltaCents: 700, reason: 'refund', refId: 'r1' })
    // an extra auth method keeps the shell alive
    await db.insert(userAuthMethods).values({ userId: shell.id, type: 'wallet', identifier: randomWallet(), metadata: { verified: true } })
    await linkVerifiedWallet(e.id, w)
    expect(await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.userId, shell.id))).toEqual([])
    const rows = await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.userId, e.id))
    expect(rows.map((r) => [r.reason, r.deltaCents]).sort()).toEqual([['merge', -700], ['merge', 700], ['refund', 700]])
    expect(rows.reduce((n, r) => n + r.deltaCents, 0)).toBe(700)
    expect(await creditBalance(shell.id)).toBe(0)
    expect(await creditBalance(e.id)).toBe(700)
  })

  it('keeps both accounts open designs, then refuses a third', async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    await createDesign(shell, { name: 'From wallet' })
    await createDesign(e, { name: 'From email' })
    await linkVerifiedWallet(e.id, w)
    const headers = { authorization: `Bearer ${tokenFor(e)}` }
    const list = await app.inject({ method: 'GET', url: '/api/studio/designs', headers })
    expect(list.json().map((x: any) => x.name).sort()).toEqual(['From email', 'From wallet'])
    const usage = await app.inject({ method: 'GET', url: '/api/studio/usage', headers })
    expect(usage.json().openDesigns).toBe(2)
    const third = await app.inject({ method: 'POST', url: '/api/studio/designs', headers, payload: { kind: 'wearable', agent: 'claude' } })
    expect(third.statusCode).toBe(403)
    expect(third.json().code).toBe('open_design_limit')
  })

  it('carries a pause, and a gift code only once', async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    const mk = async (h: string) => (await db.insert(studioGiftCodes).values({ codeHash: h, codeHint: 'abcd', prompts: 1, finalizes: 1, maxUses: 5 }).returning())[0]
    const a = await mk('h1'); const b = await mk('h2')
    await db.insert(studioGiftRedemptions).values([{ codeId: a.id, userId: shell.id }, { codeId: b.id, userId: shell.id }, { codeId: a.id, userId: e.id }])
    await db.insert(studioPauses).values({ userId: shell.id })
    await linkVerifiedWallet(e.id, w)
    const reds = await db.select().from(studioGiftRedemptions)
    expect(reds).toHaveLength(2)
    expect(reds.every((r) => r.userId === e.id)).toBe(true)
    expect(await db.select().from(studioPauses).where(eq(studioPauses.userId, e.id))).toHaveLength(1)
  })

  it('merges a shell with no studio data as before', async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    expect(await linkVerifiedWallet(e.id, w)).toBe('linked')
    expect(await db.query.users.findFirst({ where: eq(users.id, shell.id) })).toBeUndefined()
    expect(await creditBalance(e.id)).toBe(0)
  })

  it('dismisses the shell\'s open flag when the target already has one, and moves it otherwise', async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    await db.insert(studioFlags).values([{ userId: shell.id }, { userId: e.id }])
    await linkVerifiedWallet(e.id, w)
    const rows = await db.select().from(studioFlags)
    expect(rows.every((r) => r.userId === e.id)).toBe(true)
    expect(rows.filter((r) => r.status === 'open')).toHaveLength(1)
    expect(rows.filter((r) => r.status === 'dismissed')).toHaveLength(1)
  })

  it('moves an open flag when the target has none', async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    await db.insert(studioFlags).values({ userId: shell.id })
    await linkVerifiedWallet(e.id, w)
    const rows = await db.select().from(studioFlags)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: e.id, status: 'open' })
  })

  it('keeps a target that is already paused paused, with one pause row', async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    await db.insert(studioPauses).values([{ userId: shell.id }, { userId: e.id }])
    await linkVerifiedWallet(e.id, w)
    expect(await db.select().from(studioPauses)).toHaveLength(1)
    expect((await db.select().from(studioPauses))[0].userId).toBe(e.id)
  })

  it('waits behind a checkout holding the target\'s finalize credits, and still sums (no deadlock)', async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    await createDesign(shell)
    await db.insert(studioFinalizeCredits).values([{ userId: shell.id, balance: 1 }, { userId: e.id, balance: 2 }])
    await db.insert(studioCredits).values([{ userId: shell.id, balanceCents: 500 }, { userId: e.id, balanceCents: 100 }])
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let locked!: () => void
    const isLocked = new Promise<void>((r) => { locked = r })
    // A checkout: finalize credits first, then (after the merge starts) credit
    const checkout = db.transaction(async (tx) => {
      await tx.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, e.id)).for('update')
      locked()
      await held
      await tx.select().from(studioCredits).where(eq(studioCredits.userId, e.id)).for('update')
    })
    await isLocked
    let done = false
    const merge = linkVerifiedWallet(e.id, w).then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 300))
    expect(done).toBe(false) // it really waited for the checkout
    release()
    await checkout
    expect(await merge).toBe('linked')
    expect((await db.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, e.id)))[0].balance).toBe(3)
    expect(await creditBalance(e.id)).toBe(600)
  })

  it('waits behind a grant holding a source payment row, then its design (payment before design: no deadlock)', async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    const d = await createDesign(shell)
    const { payment } = await entitle(d, await addRevision(d, 'hat'))
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let locked!: () => void
    const isLocked = new Promise<void>((r) => { locked = r })
    // A grant: the payment row first, then (after the merge starts) the design
    const grant = db.transaction(async (tx) => {
      await tx.select().from(studioPayments).where(eq(studioPayments.id, payment.id)).for('update')
      locked()
      await held
      await tx.select().from(studioDesigns).where(eq(studioDesigns.id, d.id)).for('update')
    })
    await isLocked
    let done = false
    const merge = linkVerifiedWallet(e.id, w).then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 300))
    // The merge waits for the payment row before it locks the design
    expect(done).toBe(false)
    release()
    await grant
    expect(await merge).toBe('linked')
    expect((await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id)))[0].ownerId).toBe(e.id)
  })
  // ── Collaboration (LIV-159) ──
  const join = async (designId: string, userId: string, role: 'collaborator' | 'viewer', leftAt?: Date) =>
    (await db.insert(studioDesignMembers).values({ designId, userId, role, leftAt }).returning())[0]
  const openOn = async (designId: string) =>
    db.select({ userId: studioDesignMembers.userId, role: studioDesignMembers.role }).from(studioDesignMembers)
      .where(and(eq(studioDesignMembers.designId, designId), isNull(studioDesignMembers.leftAt)))
  const invite = async (designId: string, invitedBy: string, userId: string | null) =>
    (await db.insert(studioDesignInvites).values({
      designId, email: `i${Math.random()}@test.dev`, role: 'viewer', token: `t${Math.random()}`, invitedBy, userId, expiresAt: new Date(Date.now() + 86400_000),
    }).returning())[0]

  it("moves the shell's memberships, past ones too", async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    const other = await createUser()
    const d = await createDesign(other)
    const past = await createDesign(other)
    await join(d.id, shell.id, 'collaborator')
    await join(past.id, shell.id, 'viewer', new Date())
    await linkVerifiedWallet(e.id, w)
    expect(await openOn(d.id)).toEqual([{ userId: e.id, role: 'collaborator' }])
    const left = await db.select().from(studioDesignMembers).where(eq(studioDesignMembers.designId, past.id))
    expect(left.map((m) => m.userId)).toEqual([e.id])
  })

  it('both on a design: one open membership, the stronger role', async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    const other = await createUser()
    const up = await createDesign(other)
    const keep = await createDesign(other)
    await join(up.id, shell.id, 'collaborator'); await join(up.id, e.id, 'viewer')
    await join(keep.id, shell.id, 'viewer'); await join(keep.id, e.id, 'collaborator')
    await linkVerifiedWallet(e.id, w)
    expect(await openOn(up.id)).toEqual([{ userId: e.id, role: 'collaborator' }])
    expect(await openOn(keep.id)).toEqual([{ userId: e.id, role: 'collaborator' }])
  })

  it("the target owning the design drops the shell's membership, and either way round", async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    const mine = await createDesign(e)
    const theirs = await createDesign(shell)
    await join(mine.id, shell.id, 'collaborator')
    await join(theirs.id, e.id, 'viewer')
    await linkVerifiedWallet(e.id, w)
    expect(await openOn(mine.id)).toEqual([])
    expect(await openOn(theirs.id)).toEqual([])
    expect((await db.select().from(studioDesigns).where(eq(studioDesigns.id, theirs.id)))[0].ownerId).toBe(e.id)
  })

  it('moves invites (to and from the shell), notifications, and who sent prompts and messages', async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    const other = await createUser()
    const d = await createDesign(other)
    const own = await createDesign(shell)
    const to = await invite(d.id, other.id, shell.id)
    const from = await invite(own.id, shell.id, null)
    await db.insert(notifications).values([
      { userId: shell.id, kind: 'studio_invite', data: { inviteId: to.id } },
      { userId: shell.id, kind: 'studio_prompts', data: { n: 1 }, groupKey: `prompts:${d.id}` },
      { userId: e.id, kind: 'studio_prompts', data: { n: 2 }, groupKey: `prompts:${d.id}` },
    ])
    await join(d.id, shell.id, 'collaborator')
    const [job] = await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', status: 'done', payload: {}, userId: shell.id }).returning()
    const [msg] = await db.insert(studioMessages).values({ designId: d.id, role: 'user', text: 'hi', userId: shell.id }).returning()
    await linkVerifiedWallet(e.id, w)
    const inv = async (id: string) => (await db.select().from(studioDesignInvites).where(eq(studioDesignInvites.id, id)))[0]
    expect((await inv(to.id)).userId).toBe(e.id)
    expect((await inv(from.id)).invitedBy).toBe(e.id)
    const ns = await db.select().from(notifications)
    expect(ns).toHaveLength(3)
    expect(ns.every((n) => n.userId === e.id)).toBe(true)
    // One unread per group: the shell's gives way
    expect(ns.filter((n) => n.groupKey && !n.readAt)).toHaveLength(1)
    expect((await db.select().from(studioJobs).where(eq(studioJobs.id, job.id)))[0].userId).toBe(e.id)
    expect((await db.select().from(studioMessages).where(eq(studioMessages.id, msg.id)))[0].userId).toBe(e.id)
  })
})
