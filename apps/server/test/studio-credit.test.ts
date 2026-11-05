import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioCreditLedger } from '../src/db/schema.js'
import { addCredit, creditBalance, takeCredit } from '../src/studio/credit.js'
import { resetDb } from './helpers/db.js'
import { createUser, type TestUser } from './helpers/factories.js'

describe('studio credit balance', () => {
  let user: TestUser
  beforeEach(async () => {
    await resetDb()
    user = await createUser()
  })
  const ledger = () => db.select().from(studioCreditLedger).where(eq(studioCreditLedger.userId, user.id))

  it('has no balance for a new account', async () => {
    expect(await creditBalance(user.id)).toBe(0)
  })

  it('adds credit and writes a ledger row', async () => {
    await db.transaction((tx) => addCredit(tx, user.id, 1500, 'refund', 'pay_1', new Date()))
    expect(await creditBalance(user.id)).toBe(1500)
    const rows = await ledger()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ deltaCents: 1500, reason: 'refund', refId: 'pay_1' })
  })

  it('adds onto an existing balance', async () => {
    await db.transaction((tx) => addCredit(tx, user.id, 1000, 'refund', null, new Date()))
    await db.transaction((tx) => addCredit(tx, user.id, 500, 'release', null, new Date()))
    expect(await creditBalance(user.id)).toBe(1500)
    expect(await ledger()).toHaveLength(2)
  })

  it('writes nothing for zero or negative cents', async () => {
    await db.transaction((tx) => addCredit(tx, user.id, 0, 'refund', null, new Date()))
    await db.transaction((tx) => addCredit(tx, user.id, -5, 'refund', null, new Date()))
    expect(await ledger()).toHaveLength(0)
    expect(await creditBalance(user.id)).toBe(0)
  })

  it('takes at most the balance', async () => {
    await db.transaction((tx) => addCredit(tx, user.id, 1500, 'refund', null, new Date()))
    const taken = await db.transaction((tx) => takeCredit(tx, user.id, 2000, 'hold', 'pay_2', new Date()))
    expect(taken).toBe(1500)
    expect(await creditBalance(user.id)).toBe(0)
    const rows = await ledger()
    expect(rows.map((r) => r.deltaCents).sort((a, b) => a - b)).toEqual([-1500, 1500])
  })

  it('takes nothing, and writes nothing, when there is no balance', async () => {
    const taken = await db.transaction((tx) => takeCredit(tx, user.id, 1000, 'hold', null, new Date()))
    expect(taken).toBe(0)
    expect(await ledger()).toHaveLength(0)
  })

  it('takes less than the balance when asked for less', async () => {
    await db.transaction((tx) => addCredit(tx, user.id, 1500, 'refund', null, new Date()))
    expect(await db.transaction((tx) => takeCredit(tx, user.id, 400, 'hold', null, new Date()))).toBe(400)
    expect(await creditBalance(user.id)).toBe(1100)
  })

  it('never goes negative under two concurrent takes', async () => {
    await db.transaction((tx) => addCredit(tx, user.id, 1500, 'refund', null, new Date()))
    const take = () => db.transaction((tx) => takeCredit(tx, user.id, 1000, 'hold', null, new Date()))
    const got = await Promise.all([take(), take()])
    expect(got.sort((a, b) => a - b)).toEqual([500, 1000])
    expect(await creditBalance(user.id)).toBe(0)
  })
})
