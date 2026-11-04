import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  users, userAuthMethods, studioCredits, studioFlags, studioCreditLedger, studioDesigns, studioEntitlements, studioFinalizeCredits, studioGiftCodes, studioGiftRedemptions,
  studioPauses, studioPayments, studioPromptCredits, studioUsageDays,
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
    await db.insert(studioUsageDays).values([{ userId: shell.id, day: today(), prompts: 3, costUsd: 0.5 }, { userId: shell.id, day: '2020-01-01', prompts: 2, costUsd: 0.1 }])
    await db.insert(studioUsageDays).values({ userId: e.id, day: today(), prompts: 1, costUsd: 0.25 })
    await db.insert(studioPromptCredits).values({ userId: shell.id, balance: 2, gifted: 4 })
    await db.insert(studioPromptCredits).values({ userId: e.id, balance: 1, gifted: 1 })
    await db.insert(studioFinalizeCredits).values({ userId: shell.id, balance: 1 })
    await db.insert(studioCredits).values([{ userId: shell.id, balanceCents: 1200 }, { userId: e.id, balanceCents: 300 }])

    expect(await linkVerifiedWallet(e.id, w)).toBe('linked')

    expect((await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id)))[0].ownerId).toBe(e.id)
    expect((await db.select().from(studioPayments).where(eq(studioPayments.id, payment.id)))[0].userId).toBe(e.id)
    expect((await db.select().from(studioEntitlements).where(eq(studioEntitlements.id, entitlement.id)))[0].userId).toBe(e.id)
    const days = await db.select().from(studioUsageDays).where(eq(studioUsageDays.userId, e.id))
    expect(days.find((r) => r.day === today())).toMatchObject({ prompts: 4, costUsd: 0.75 })
    expect(days.find((r) => r.day === '2020-01-01')?.prompts).toBe(2)
    expect((await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, e.id)))[0]).toMatchObject({ balance: 3, gifted: 5 })
    expect((await db.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, e.id)))[0].balance).toBe(1)
    expect(await creditBalance(e.id)).toBe(1500)
    const merges = (await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.userId, e.id))).filter((r) => r.reason === 'merge')
    expect(merges).toHaveLength(1)
    expect(merges[0].deltaCents).toBe(1200)
    expect(await db.query.users.findFirst({ where: eq(users.id, shell.id) })).toBeUndefined()

    const res = await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/packages`, headers: { authorization: `Bearer ${tokenFor(e)}` } })
    expect(res.statusCode).toBe(200)
  })

  it('writes a merge ledger row on the source side too while the shell survives', async () => {
    const { w, shell } = await shellWith()
    const e = await createUser({ role: 'creator' })
    await db.insert(studioCredits).values({ userId: shell.id, balanceCents: 700 })
    // an extra auth method keeps the shell alive
    await db.insert(userAuthMethods).values({ userId: shell.id, type: 'wallet', identifier: randomWallet(), metadata: { verified: true } })
    await linkVerifiedWallet(e.id, w)
    const rows = await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.userId, shell.id))
    expect(rows.map((r) => r.deltaCents)).toEqual([-700])
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
})

