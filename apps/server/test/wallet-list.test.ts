import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { userAuthMethods, walletBlocks } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('GET /api/auth/wallets', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function link(wallet: Wallet, bearer: string) {
    const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: wallet.address } })
    const { nonce, message } = ch.json()
    return app.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      payload: { address: wallet.address, nonce, signature: await wallet.signMessage(message) },
      headers: { authorization: `Bearer ${bearer}` },
    })
  }

  it('lists the verified wallets linked to the signed-in user, and only theirs', async () => {
    const me = await createUser()
    const other = await createUser()
    const w = Wallet.createRandom()
    expect((await link(w, tokenFor(me))).json()).toMatchObject({ linked: true })
    await link(Wallet.createRandom(), tokenFor(other))
    // a legacy unverified record is not a linked wallet
    await db.insert(userAuthMethods).values({ userId: me.id, type: 'wallet', identifier: '0x' + '1'.repeat(40), metadata: { verified: false } })

    const res = await app.inject({ method: 'GET', url: '/api/auth/wallets', headers: { authorization: `Bearer ${tokenFor(me)}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json().wallets).toEqual([{ address: w.address.toLowerCase(), linkedAt: expect.any(String), blocked: false }])
  })

  it('M-8: marks a blocked wallet, and gives when it was linked (linked_at, else when its record was made)', async () => {
    const me = await createUser()
    const blocked = '0x' + '2'.repeat(40)
    const absorbed = '0x' + '3'.repeat(40)
    const linkedAt = new Date('2026-11-01T10:00:00Z')
    await db.insert(userAuthMethods).values([
      { userId: me.id, type: 'wallet', identifier: blocked, metadata: { verified: true }, createdAt: new Date('2026-10-01T10:00:00Z') },
      { userId: me.id, type: 'wallet', identifier: absorbed, metadata: { verified: true }, createdAt: new Date('2026-09-01T10:00:00Z'), linkedAt },
    ])
    await db.insert(walletBlocks).values({ wallet: blocked, userId: me.id, reason: 'reissue' })
    const res = await app.inject({ method: 'GET', url: '/api/auth/wallets', headers: { authorization: `Bearer ${tokenFor(me, { wallet: null })}` } })
    expect(res.statusCode).toBe(200)
    const by = Object.fromEntries(res.json().wallets.map((x: any) => [x.address, x]))
    expect(by[blocked]).toEqual({ address: blocked, linkedAt: '2026-10-01T10:00:00.000Z', blocked: true })
    expect(by[absorbed]).toEqual({ address: absorbed, linkedAt: linkedAt.toISOString(), blocked: false })
  })

  it('LIV-11: a blocked wallet still on its account neither signs in nor refreshes there; once unlinked it signs up as a new account, never links back, and its new account is not refused', async () => {
    const me = await createUser()
    const w = Wallet.createRandom()
    const addr = w.address.toLowerCase()
    expect((await link(w, tokenFor(me))).json()).toMatchObject({ linked: true })
    await db.insert(walletBlocks).values({ wallet: addr, userId: me.id, reason: 'reissue' })

    const signIn = async (bearer?: string) => {
      const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: w.address } })
      const { nonce, message } = ch.json()
      return app.inject({ method: 'POST', url: '/api/auth/wallet/verify', payload: { address: w.address, nonce, signature: await w.signMessage(message) }, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} })
    }
    const refuse = await signIn()
    expect([refuse.statusCode, refuse.json().error]).toEqual([403, 'wallet_blocked'])
    const old = await app.inject({ method: 'GET', url: '/api/auth/wallets', headers: { authorization: `Bearer ${tokenFor(me, { wallet: addr })}` } })
    expect([old.statusCode, old.json().error]).toEqual([401, 'wallet_blocked'])

    // Unlinked (a reissue done, or an admin unlink): a new, separate account
    await db.delete(userAuthMethods).where(eq(userAuthMethods.identifier, addr))
    const fresh = await signIn()
    expect(fresh.statusCode, fresh.body).toBe(200)
    expect(fresh.json().user.id).not.toBe(me.id)
    const mine = await app.inject({ method: 'GET', url: '/api/auth/wallets', headers: { authorization: `Bearer ${fresh.json().accessToken}` } })
    expect(mine.statusCode).toBe(200)
    expect(mine.json().wallets).toEqual([{ address: addr, linkedAt: expect.any(String), blocked: true }])
    // The old account's sessions carrying it stay refused, and it can't be linked back there
    expect((await app.inject({ method: 'GET', url: '/api/auth/wallets', headers: { authorization: `Bearer ${tokenFor(me, { wallet: addr })}` } })).statusCode).toBe(401)
    await db.delete(userAuthMethods).where(eq(userAuthMethods.identifier, addr))
    const back = await link(w, tokenFor(me, { wallet: null }))
    expect([back.statusCode, back.json().error]).toEqual([403, 'wallet_blocked'])
  })

  it('requires a signed-in user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/wallets' })
    expect(res.statusCode).toBe(401)
  })
})
