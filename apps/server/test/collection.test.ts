import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setCollectionFetchForTests, itemFromMarketplace, MAX_PER_WALLET } from '../src/collection/collection.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, randomWallet } from './helpers/factories.js'

/** The Collection page (LIV-160): what an account's own wallets hold on Decentraland. */

const nft = (owner: string, over: Record<string, unknown> = {}) => ({
  nft: {
    category: 'wearable', contractAddress: '0xF6D8E606C862143556B342149A7FE0558C220375', tokenId: String(Math.floor(Math.random() * 1e12)),
    name: 'Polygon Thunder Earrings', image: 'https://peer.decentraland.org/x/thumbnail', network: 'MATIC', owner,
    data: { wearable: { category: 'earring', rarity: 'common' } }, ...over,
  },
})

describe('collection', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const calls: string[] = []
  let pages: Record<string, unknown[]> = {}
  let failing = new Set<string>()
  beforeEach(async () => {
    await resetDb()
    calls.length = 0
    pages = {}
    failing = new Set()
    setCollectionFetchForTests(async (input) => {
      const url = new URL(String(input))
      calls.push(url.search)
      const owner = url.searchParams.get('owner')!
      if (failing.has(owner)) return new Response('busy', { status: 503 })
      const skip = Number(url.searchParams.get('skip'))
      const first = Number(url.searchParams.get('first'))
      return new Response(JSON.stringify({ data: (pages[owner] ?? []).slice(skip, skip + first), total: (pages[owner] ?? []).length }))
    })
    app = await testApp()
  })
  afterEach(async () => { setCollectionFetchForTests(null); await app.close() })
  const get = (u: Parameters<typeof tokenFor>[0]) => app.inject({ method: 'GET', url: '/api/collection', headers: { authorization: `Bearer ${tokenFor(u)}` } })

  it('reads a Marketplace row into an item, and drops what the page does not show', () => {
    const w = '0x' + 'a'.repeat(40)
    expect(itemFromMarketplace(nft(w, { tokenId: '42' }), w)).toEqual({
      id: '0xf6d8e606c862143556b342149a7fe0558c220375-42', kind: 'wearable', name: 'Polygon Thunder Earrings', image: 'https://peer.decentraland.org/x/thumbnail',
      rarity: 'common', slot: 'earring', network: 'MATIC', contractAddress: '0xf6d8e606c862143556b342149a7fe0558c220375', tokenId: '42', wallet: w,
      url: 'https://decentraland.org/marketplace/contracts/0xf6d8e606c862143556b342149a7fe0558c220375/tokens/42',
    })
    expect(itemFromMarketplace(nft(w, { category: 'ens', name: 'Sam', network: 'ETHEREUM', data: { ens: { subdomain: 'Sam' } } }), w)).toMatchObject({ kind: 'ens', name: 'Sam.dcl.eth', rarity: null, slot: null })
    expect(itemFromMarketplace(nft(w, { image: 'javascript:alert(1)' }), w)!.image).toBeNull()
    expect(itemFromMarketplace(nft(w, { category: 'something' }), w)).toBeNull()
    expect(itemFromMarketplace(nft(w, { contractAddress: 'nope' }), w)).toBeNull()
    expect(itemFromMarketplace({ nope: 1 }, w)).toBeNull()
  })

  it("lists every verified wallet's items, pages through the Marketplace, and caches", async () => {
    const [w1, w2] = [randomWallet(), randomWallet()]
    const user = await createUser({ wallet: w1 })
    // a second verified wallet on the same account
    const { db } = await import('../src/db/connection.js')
    const { userAuthMethods } = await import('../src/db/schema.js')
    await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: w2.toLowerCase(), metadata: { verified: true } })
    pages[w1.toLowerCase()] = Array.from({ length: 150 }, () => nft(w1.toLowerCase()))
    pages[w2.toLowerCase()] = [nft(w2.toLowerCase(), { category: 'emote', name: 'Wave', data: { emote: { category: 'dance', rarity: 'rare' } } })]
    const body = (await get(user)).json()
    expect(body.wallets.sort()).toEqual([w1.toLowerCase(), w2.toLowerCase()].sort())
    expect(body.items).toHaveLength(151)
    expect(body.items.find((i: any) => i.kind === 'emote')).toMatchObject({ name: 'Wave', wallet: w2.toLowerCase(), rarity: 'rare', slot: 'dance' })
    expect(body.unavailable).toEqual([])
    const n = calls.length
    expect(n).toBe(3) // 2 pages for the first wallet, 1 for the second
    await get(user)
    expect(calls.length).toBe(n) // cached
  })

  it("never shows another owner's item, and a wallet the Marketplace can't answer for is listed as unavailable", async () => {
    const [w1, w2] = [randomWallet(), randomWallet()]
    const user = await createUser({ wallet: w1 })
    const { db } = await import('../src/db/connection.js')
    const { userAuthMethods } = await import('../src/db/schema.js')
    await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: w2.toLowerCase(), metadata: { verified: true } })
    pages[w1.toLowerCase()] = [nft(w1.toLowerCase()), nft('0x' + 'b'.repeat(40))]
    failing.add(w2.toLowerCase())
    const body = (await get(user)).json()
    expect(body.items).toHaveLength(1)
    expect(body.unavailable).toEqual([w2.toLowerCase()])
  })

  it('stops at the per-wallet cap and says so', async () => {
    const w = randomWallet().toLowerCase()
    const user = await createUser({ wallet: w })
    pages[w] = Array.from({ length: MAX_PER_WALLET + 50 }, () => nft(w))
    const body = (await get(user)).json()
    expect(body.items).toHaveLength(MAX_PER_WALLET)
    expect(body.truncated).toEqual([w])
  })

  it('an account with no wallet has an empty collection; signed out is refused', async () => {
    const user = await createUser()
    expect((await get(user)).json()).toEqual({ wallets: [], items: [], unavailable: [], truncated: [] })
    expect((await app.inject({ method: 'GET', url: '/api/collection' })).statusCode).toBe(401)
    expect(calls).toEqual([])
  })
})
