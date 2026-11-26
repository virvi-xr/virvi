import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getAddress, parseEther } from 'ethers'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { events, eventGiveawayLinks, giveawayClaims, giveawayClaimMints, giveawayItems, giveaways, giveawayScenes, giveawayTxs, sceneCollaborators, users } from '../src/db/schema.js'
import { issueScenePass } from '../src/auth/scene-pass.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { creatorItems, setCreatorItemsFetchForTests } from '../src/giveaways/marketplace.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { giveawaysOn, type FakeGiveawayChain, type FakeMarketplace } from './helpers/giveaways-fake.js'

const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
const CONTRACT = '0x' + 'c0'.repeat(20)
const OTHER_CONTRACT = '0x' + 'd0'.repeat(20)
const pol = (s: string) => parseEther(s)

describe('giveaway host API (LIV-194)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let stranger: TestUser
  let sceneId: string
  let chain: FakeGiveawayChain
  let market: FakeMarketplace
  let off: () => void

  beforeEach(async () => {
    await resetDb()
    ;({ chain, market, off } = giveawaysOn())
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    stranger = await createUser({ wallet: randomWallet() })
    sceneId = (await createScene(host, 'Venue')).scene.id
    market.add(host.wallet!, { contractAddress: CONTRACT, itemId: '0', name: 'Prize hat' })
    market.add(host.wallet!, { contractAddress: CONTRACT, itemId: '1', name: 'Prize dance', category: 'emote' })
    market.add(stranger.wallet!, { contractAddress: OTHER_CONTRACT, itemId: '0', name: 'Not yours' })
  })
  afterEach(async () => {
    off()
    await app.close()
  })

  const call = (method: string, url: string, user: TestUser = host, payload?: unknown, headers = as(user)) =>
    app.inject({ method: method as any, url, headers, payload: payload as any })
  async function create(user: TestUser = host, body: Record<string, unknown> = { name: 'Launch party' }) {
    const res = await call('POST', '/api/giveaways', user, body)
    expect(res.statusCode).toBe(201)
    return res.json().giveaway as { id: string; walletAddress: string }
  }
  /** A giveaway with one ready item and one scene, still off. */
  async function ready() {
    const g = await create()
    expect((await call('PUT', `/api/giveaways/${g.id}/items`, host, { items: [{ contractAddress: CONTRACT, itemId: '0' }] })).statusCode).toBe(200)
    expect((await call('PUT', `/api/giveaways/${g.id}/scenes`, host, { sceneIds: [sceneId] })).statusCode).toBe(200)
    return g
  }

  describe('create and read', () => {
    it('makes a wallet and never returns its key', async () => {
      const res = await call('POST', '/api/giveaways', host, { name: 'Launch party' })
      expect(res.statusCode).toBe(201)
      expect(res.body).not.toMatch(/keyEnc|walletKeyEnc/i)
      const g = res.json().giveaway
      expect(g).toMatchObject({ name: 'Launch party', chain: 'polygon', enabled: false })
      expect(g.walletAddress).toBe(getAddress(g.walletAddress))
      const [row] = await db.select().from(giveaways).where(eq(giveaways.id, g.id))
      expect(row.walletKeyEnc).toMatch(/^v1:/)
      expect(row.walletAddress).toBe(g.walletAddress)

      const view = await call('GET', `/api/giveaways/${g.id}`)
      expect(view.statusCode).toBe(200)
      expect(view.body).not.toMatch(/keyEnc/i)
      expect(view.json()).toMatchObject({
        id: g.id, walletAddress: g.walletAddress, builderUrl: 'https://decentraland.org/builder/collections', items: [], sceneIds: [],
        counts: { present: 0, waiting: 0, minting: 0, sent: 0, failed: 0 },
        // Billing is off in tests, so the owner counts as paid; with no gas key the host funds the wallet
        funding: { balanceWei: '0', withdrawableWei: '0', claimsCovered: 0, covered: false, tankMissing: true, lowGas: true },
      })

      const list = await call('GET', '/api/giveaways')
      expect(list.statusCode).toBe(200)
      expect(list.body).not.toMatch(/keyEnc/i)
      expect(list.json().giveaways.map((x: any) => x.id)).toEqual([g.id])
    })

    it('refuses a missing name', async () => {
      const res = await call('POST', '/api/giveaways', host, { name: '  ' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'bad_name' })
    })

    it('is 404 to anyone but the owner or an admin', async () => {
      const g = await create()
      for (const [method, url, body] of [
        ['GET', `/api/giveaways/${g.id}`], ['PATCH', `/api/giveaways/${g.id}`, { name: 'x' }], ['DELETE', `/api/giveaways/${g.id}`],
        ['PUT', `/api/giveaways/${g.id}/items`, { items: [] }], ['PUT', `/api/giveaways/${g.id}/scenes`, { sceneIds: [] }],
        ['GET', `/api/giveaways/${g.id}/claims`], ['POST', `/api/giveaways/${g.id}/send-back`, { toWallet: stranger.wallet }],
      ] as const) {
        const res = await call(method, url, stranger, body)
        expect(res.statusCode, `${method} ${url}`).toBe(404)
        expect(res.json()).toMatchObject({ error: 'not_found' })
      }
      expect((await call('GET', '/api/giveaways', stranger)).json().giveaways).toEqual([])
      const admin = await createUser({ role: 'admin' })
      expect((await call('GET', `/api/giveaways/${g.id}`, admin)).statusCode).toBe(200)
      expect((await call('GET', '/api/giveaways/not-a-uuid')).statusCode).toBe(404)
    })

    it('Amoy is for Virvi admins only', async () => {
      const res = await call('POST', '/api/giveaways', host, { name: 'Test', chain: 'polygon-amoy' })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ error: 'forbidden' })
      const admin = await createUser({ role: 'admin' })
      const ok = await create(admin, { name: 'Test', chain: 'polygon-amoy' })
      expect((await call('GET', `/api/giveaways/${ok.id}`, admin)).json()).toMatchObject({ chain: 'polygon-amoy', builderUrl: 'https://decentraland.zone/builder/collections' })
      expect((await call('POST', '/api/giveaways', host, { name: 'x', chain: 'ethereum' })).statusCode).toBe(400)
    })
  })

  describe('passes, trials and the switch', () => {
    it('refuses scene passes and trials', async () => {
      const g = await create()
      const pass = issueScenePass(app, host as any, host.wallet!, { sceneId, locationId: null }).accessToken
      for (const url of ['/api/giveaways', `/api/giveaways/${g.id}`]) {
        expect((await call('GET', url, host, undefined, { authorization: `Bearer ${pass}` })).statusCode).toBe(403)
      }
      const t = await createUser({ email: null })
      await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
      const { accessToken } = issueTrialSession(app, { id: t.id, displayName: t.displayName, role: 'creator', trialLastActiveAt: new Date() })
      const res = await call('POST', '/api/giveaways', host, { name: 'x' }, { authorization: `Bearer ${accessToken}` })
      expect(res.statusCode).toBe(403)
    })

    it('answers 503 giveaways_off when switched off, except availability', async () => {
      const g = await create()
      ;(config as any).giveaways = { ...config.giveaways, enabled: false }
      for (const url of ['/api/giveaways', `/api/giveaways/${g.id}`, '/api/giveaways/creator-items']) {
        const res = await call('GET', url)
        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({ error: 'giveaways_off', message: "Automatic giveaways aren't switched on for this server yet." })
      }
      const av = await call('GET', '/api/giveaways/availability')
      expect(av.statusCode).toBe(200)
      expect(av.json()).toEqual({ enabled: false, gasCovered: false })
    })

    it('availability says whether gas is covered for the caller', async () => {
      expect((await call('GET', '/api/giveaways/availability')).json()).toEqual({ enabled: true, gasCovered: false })
      ;(config as any).giveaways = { ...config.giveaways, gasKey: '0x' + '11'.repeat(32) }
      const admin = await createUser({ role: 'admin' })
      expect((await call('GET', '/api/giveaways/availability', admin)).json()).toEqual({ enabled: true, gasCovered: true })
    })
  })

  describe('creator items', () => {
    it("lists the caller's published wearables and emotes", async () => {
      market.add(host.wallet!, { contractAddress: CONTRACT, itemId: '2', name: 'Draft', reviewedAt: null })
      market.add(host.wallet!, { contractAddress: CONTRACT, itemId: '3', name: 'On Ethereum', network: 'ETHEREUM' })
      const res = await call('GET', '/api/giveaways/creator-items?chain=polygon')
      expect(res.statusCode).toBe(200)
      expect(res.json().items).toEqual([
        { contractAddress: getAddress(CONTRACT), itemId: '0', name: 'Prize hat', thumbnail: 'https://peer.example/thumb.png', rarity: 'rare', available: 50 },
        { contractAddress: getAddress(CONTRACT), itemId: '1', name: 'Prize dance', thumbnail: 'https://peer.example/thumb.png', rarity: 'rare', available: 50 },
      ])
      expect(market.calls.every((u) => u.startsWith('https://marketplace-api.decentraland.org/v1/items?') || u === 'https://subgraph.decentraland.org/collections-matic-mainnet')).toBe(true)
      expect((await call('GET', '/api/giveaways/creator-items?chain=polygon-amoy')).statusCode).toBe(403)
    })

    it('caches per chain and wallet for a minute', async () => {
      await creatorItems('polygon', [host.wallet!])
      const n = market.calls.length
      expect(n).toBe(3) // wearables, emotes and minting rights (none, so no collection lookups)
      await creatorItems('polygon', [host.wallet!])
      expect(market.calls.length).toBe(n)
      await creatorItems('polygon', [host.wallet!, stranger.wallet!])
      expect(market.calls.length).toBe(n + 3)
    })

    it("lists items the caller's wallets may mint without having created them: whole collections and single items", async () => {
      const THIRD = '0x' + '33'.repeat(20)
      const FOURTH = '0x' + '44'.repeat(20)
      const maker = randomWallet()
      market.add(stranger.wallet!, { contractAddress: OTHER_CONTRACT, itemId: '1', name: 'Also theirs', category: 'emote' })
      market.add(stranger.wallet!, { contractAddress: OTHER_CONTRACT, itemId: '2', name: 'Their draft', reviewedAt: null })
      market.add(maker, { contractAddress: THIRD, itemId: '0', name: 'Granted on its own' })
      market.add(maker, { contractAddress: THIRD, itemId: '1', name: 'Not granted' })
      market.add(maker, { contractAddress: FOURTH, itemId: '0', name: 'Unapproved collection' })
      market.grantCollection(host.wallet!, OTHER_CONTRACT)
      market.grantItem(host.wallet!, THIRD, '0')
      market.grantItem(host.wallet!, FOURTH, '0', false)
      const res = await call('GET', '/api/giveaways/creator-items?chain=polygon')
      expect(res.statusCode).toBe(200)
      expect(res.json().items.map((i: any) => i.name).sort()).toEqual(['Also theirs', 'Granted on its own', 'Not yours', 'Prize dance', 'Prize hat'])

      // And they can be given away
      const g = await create()
      const put = await call('PUT', `/api/giveaways/${g.id}/items`, host, { items: [{ contractAddress: OTHER_CONTRACT, itemId: '0' }, { contractAddress: THIRD, itemId: '0' }] })
      expect(put.statusCode, put.body).toBe(200)
      expect((await call('PUT', `/api/giveaways/${g.id}/items`, host, { items: [{ contractAddress: THIRD, itemId: '1' }] })).json()).toMatchObject({ error: 'not_your_item' })
    })

    it('a subgraph that is down is marketplace_down, not an empty list', async () => {
      const real = market.fetch
      market.fetch = async (input, init) => new URL(String(input)).hostname === 'subgraph.decentraland.org' ? new Response('nope', { status: 503 }) : real(input, init)
      setCreatorItemsFetchForTests(market.fetch)
      const res = await call('GET', '/api/giveaways/creator-items?chain=polygon')
      expect(res.statusCode).toBe(502)
      expect(res.json()).toMatchObject({ error: 'marketplace_down' })
    })
  })

  describe('final review minors', () => {
    it('M-1: the list carries claim counts per status', async () => {
      const g = await create()
      const other = await create()
      for (const status of ['waiting', 'sent', 'sent'] as const) {
        await db.insert(giveawayClaims).values({ giveawayId: g.id, wallet: randomWallet().toLowerCase(), consentVersion: 1, status })
      }
      const list = (await call('GET', '/api/giveaways')).json().giveaways
      expect(list.find((x: any) => x.id === g.id).counts).toEqual({ present: 0, waiting: 1, minting: 0, sent: 2, failed: 0 })
      expect(list.find((x: any) => x.id === other.id).counts).toEqual({ present: 0, waiting: 0, minting: 0, sent: 0, failed: 0 })
    })

    it('M-13: creator items are paged past the first 100 per category', async () => {
      for (let i = 2; i < 152; i++) market.add(host.wallet!, { contractAddress: CONTRACT, itemId: String(i), name: `Hat ${i}` })
      const res = await call('GET', '/api/giveaways/creator-items?chain=polygon')
      expect(res.statusCode).toBe(200)
      expect(res.json().items).toHaveLength(152)
    })

    it("M-14: an admin acting on someone else's giveaway sees the owner's items and send-back wallets", async () => {
      const g = await create()
      const admin = await createUser({ role: 'admin', wallet: randomWallet() })
      market.add(admin.wallet!, { contractAddress: OTHER_CONTRACT, itemId: '5', name: 'Admin hat' })
      const items = await call('GET', `/api/giveaways/creator-items?giveawayId=${g.id}`, admin)
      expect(items.statusCode, items.body).toBe(200)
      expect(items.json().items.map((i: any) => i.name).sort()).toEqual(['Prize dance', 'Prize hat'])
      const wallets = await call('GET', `/api/giveaways/${g.id}/send-back-wallets`, admin)
      expect(wallets.json()).toEqual({ wallets: [getAddress(host.wallet!)] })
      // Someone else's giveaway stays 404 to a non-admin
      expect((await call('GET', `/api/giveaways/${g.id}/send-back-wallets`, stranger)).statusCode).toBe(404)
      expect((await call('GET', `/api/giveaways/creator-items?giveawayId=${g.id}`, stranger)).statusCode).toBe(404)
    })
  })

  describe('items and scenes', () => {
    it("caches the item's name, thumbnail and rarity, and refuses someone else's item", async () => {
      const g = await create()
      const bad = await call('PUT', `/api/giveaways/${g.id}/items`, host, { items: [{ contractAddress: OTHER_CONTRACT, itemId: '0' }] })
      expect(bad.statusCode).toBe(400)
      expect(bad.json()).toMatchObject({ error: 'not_your_item' })

      const ok = await call('PUT', `/api/giveaways/${g.id}/items`, host, { items: [{ contractAddress: CONTRACT, itemId: '0' }, { contractAddress: CONTRACT, itemId: '1' }] })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().items).toMatchObject([
        { contractAddress: getAddress(CONTRACT), itemId: '0', name: 'Prize hat', thumbnail: 'https://peer.example/thumb.png', rarity: 'rare', mintState: 'ready', remaining: 100 },
        { contractAddress: getAddress(CONTRACT), itemId: '1', name: 'Prize dance' },
      ])
      expect((await call('PUT', `/api/giveaways/${g.id}/items`, host, { items: [] })).statusCode).toBe(400)
      const eleven = Array.from({ length: 11 }, (_, i) => ({ contractAddress: CONTRACT, itemId: String(i) }))
      expect((await call('PUT', `/api/giveaways/${g.id}/items`, host, { items: eleven })).statusCode).toBe(400)
    })

    it('refuses new items once a claim is past present', async () => {
      const g = await ready()
      await db.insert(giveawayClaims).values({ giveawayId: g.id, wallet: randomWallet(), consentVersion: 1, status: 'present' })
      expect((await call('PUT', `/api/giveaways/${g.id}/items`, host, { items: [{ contractAddress: CONTRACT, itemId: '1' }] })).statusCode).toBe(200)
      await db.insert(giveawayClaims).values({ giveawayId: g.id, wallet: randomWallet(), consentVersion: 1, status: 'waiting' })
      const res = await call('PUT', `/api/giveaways/${g.id}/items`, host, { items: [{ contractAddress: CONTRACT, itemId: '0' }] })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'has_claims' })
    })

    it('takes only scenes the caller can run events in', async () => {
      const g = await create()
      const theirs = (await createScene(stranger, 'Theirs')).scene.id
      const res = await call('PUT', `/api/giveaways/${g.id}/scenes`, host, { sceneIds: [sceneId, theirs] })
      expect(res.statusCode).toBe(403)
      expect(await db.select().from(giveawayScenes)).toEqual([])
      await db.insert(sceneCollaborators).values({ sceneId: theirs, userId: host.id, role: 'editor' })
      const ok = await call('PUT', `/api/giveaways/${g.id}/scenes`, host, { sceneIds: [sceneId, theirs] })
      expect(ok.statusCode).toBe(200)
      expect([...ok.json().sceneIds].sort()).toEqual([sceneId, theirs].sort())
      expect((await call('PUT', `/api/giveaways/${g.id}/scenes`, host, { sceneIds: ['nope'] })).statusCode).toBe(400)
    })
  })

  describe('switching on', () => {
    it('needs items, a scene, and every item passing the minter check', async () => {
      const g = await create()
      const empty = await call('PATCH', `/api/giveaways/${g.id}`, host, { enabled: true })
      expect(empty.statusCode).toBe(409)
      expect(empty.json()).toMatchObject({ error: 'not_ready' })

      await call('PUT', `/api/giveaways/${g.id}/items`, host, { items: [{ contractAddress: CONTRACT, itemId: '0' }, { contractAddress: CONTRACT, itemId: '1' }] })
      await call('PUT', `/api/giveaways/${g.id}/scenes`, host, { sceneIds: [sceneId] })
      chain.items.set(`${CONTRACT}:1`, { canMint: false })
      const res = await call('PATCH', `/api/giveaways/${g.id}`, host, { enabled: true })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'not_ready', items: [{ contractAddress: getAddress(CONTRACT), itemId: '1', state: 'not_minter' }] })
      expect((await db.select().from(giveaways).where(eq(giveaways.id, g.id)))[0].enabled).toBe(false)

      chain.items.set(`${CONTRACT}:1`, { approved: false })
      expect((await call('PATCH', `/api/giveaways/${g.id}`, host, { enabled: true })).json().items[0].state).toBe('not_approved')
      chain.items.set(`${CONTRACT}:1`, { remaining: 0n })
      expect((await call('PATCH', `/api/giveaways/${g.id}`, host, { enabled: true })).json().items[0].state).toBe('sold_out')

      chain.items.delete(`${CONTRACT}:1`)
      const on = await call('PATCH', `/api/giveaways/${g.id}`, host, { enabled: true })
      expect(on.statusCode).toBe(200)
      expect(on.json()).toMatchObject({ enabled: true })
    })

    it('checks the other fields', async () => {
      const g = await create()
      const patch = (body: unknown) => call('PATCH', `/api/giveaways/${g.id}`, host, body)
      expect((await patch({ minPresentSeconds: 7201 })).statusCode).toBe(400)
      expect((await patch({ minPresentSeconds: -1 })).statusCode).toBe(400)
      expect((await patch({ claimCap: 0 })).statusCode).toBe(400)
      expect((await patch({ startsAt: '2030-01-02T00:00:00Z', endsAt: '2030-01-01T00:00:00Z' })).json()).toMatchObject({ error: 'bad_window' })
      const ok = await patch({ name: 'Renamed', minPresentSeconds: 7200, claimCap: 5, startsAt: '2030-01-01T00:00:00Z', endsAt: '2030-01-02T00:00:00Z' })
      expect(ok.statusCode).toBe(200)
      expect(ok.json()).toMatchObject({ name: 'Renamed', minPresentSeconds: 7200, claimCap: 5, startsAt: '2030-01-01T00:00:00.000Z' })
      // endsAt must stay after the stored start
      expect((await patch({ endsAt: '2029-12-31T00:00:00Z' })).statusCode).toBe(400)
      expect((await patch({ claimCap: null, startsAt: null })).json()).toMatchObject({ claimCap: null, startsAt: null })
    })
  })

  describe('claims list', () => {
    it('never skips a claim created in the same millisecond as the last one on a page', async () => {
      const g = await create()
      const wallets = Array.from({ length: 51 }, () => randomWallet())
      // 49 newer claims, then two in one millisecond (.123456 and .123200): the page boundary falls between them
      for (const [i, w] of wallets.slice(0, 49).entries()) {
        await db.insert(giveawayClaims).values({ giveawayId: g.id, wallet: w, consentVersion: 1, createdAt: new Date(Date.UTC(2030, 0, 1, 1, 0, i)) })
      }
      for (const [w, at] of [[wallets[49], '2030-01-01T00:00:00.123456Z'], [wallets[50], '2030-01-01T00:00:00.123200Z']]) {
        await db.insert(giveawayClaims).values({ giveawayId: g.id, wallet: w, consentVersion: 1, createdAt: sql`${at}::timestamptz` as any })
      }
      const first = (await call('GET', `/api/giveaways/${g.id}/claims`)).json()
      expect(first.claims).toHaveLength(50)
      expect(first.claims[49].wallet).toBe(`${wallets[49].slice(0, 6)}…${wallets[49].slice(-4)}`)
      const rest = (await call('GET', `/api/giveaways/${g.id}/claims?cursor=${encodeURIComponent(first.nextCursor)}`)).json()
      expect(rest.claims.map((c: any) => c.wallet)).toEqual([`${wallets[50].slice(0, 6)}…${wallets[50].slice(-4)}`])
      expect(rest.nextCursor).toBeNull()
      expect((await call('GET', `/api/giveaways/${g.id}/claims?cursor=nonsense`)).statusCode).toBe(400)
    })

    it('shows short wallets, status, times and tx links, 50 a page', async () => {
      const g = await create()
      const hash = '0x' + 'ab'.repeat(32)
      const [t] = await db.insert(giveawayTxs).values({ giveawayId: g.id, chain: 'polygon', kind: 'mint', fromAddress: g.walletAddress, toAddress: CONTRACT, txHash: hash, status: 'confirmed' }).returning()
      const wallets = Array.from({ length: 51 }, () => randomWallet())
      for (const [i, w] of wallets.entries()) {
        const [c] = await db.insert(giveawayClaims).values({
          giveawayId: g.id, wallet: w, consentVersion: 1, status: i === 0 ? 'sent' : 'waiting',
          createdAt: new Date(Date.now() - (51 - i) * 1000), sentAt: i === 0 ? new Date() : null, claimedAt: new Date(),
        }).returning()
        if (i === 0) await db.insert(giveawayClaimMints).values({ claimId: c.id, contractAddress: CONTRACT, status: 'sent', txId: t.id })
      }
      const first = await call('GET', `/api/giveaways/${g.id}/claims`)
      expect(first.statusCode).toBe(200)
      const page = first.json()
      expect(page.claims).toHaveLength(50)
      expect(first.body).not.toContain(wallets[0].slice(10, 30))
      expect(page.nextCursor).toEqual(expect.any(String))
      const rest = (await call('GET', `/api/giveaways/${g.id}/claims?cursor=${encodeURIComponent(page.nextCursor)}`)).json()
      expect(rest.nextCursor).toBeNull()
      expect(rest.claims).toHaveLength(1)
      expect(rest.claims[0]).toMatchObject({
        wallet: `${wallets[0].slice(0, 6)}…${wallets[0].slice(-4)}`, status: 'sent', txUrl: `https://polygonscan.com/tx/${hash}`,
        claimedAt: expect.any(String), sentAt: expect.any(String),
      })
      expect(page.claims[0]).toMatchObject({ status: 'waiting', txUrl: null })
      expect((await call('GET', `/api/giveaways/${g.id}`)).json().counts).toMatchObject({ waiting: 50, sent: 1 })
    })
  })

  describe('send back', () => {
    it('sends the withdrawable POL less one transfer of gas to a verified wallet only', async () => {
      const g = await create()
      chain.setBalance(g.walletAddress, pol('2'))
      await db.insert(giveawayTxs).values({ giveawayId: g.id, chain: 'polygon', kind: 'topup', fromAddress: randomWallet(), toAddress: g.walletAddress, status: 'confirmed', valueWei: pol('1').toString() })
      await db.insert(giveawayTxs).values({ giveawayId: g.id, chain: 'polygon', kind: 'mint', fromAddress: g.walletAddress, toAddress: CONTRACT, status: 'confirmed', feeWei: pol('0.3').toString(), covered: true })

      const bad = await call('POST', `/api/giveaways/${g.id}/send-back`, host, { toWallet: stranger.wallet })
      expect(bad.statusCode).toBe(400)
      expect(bad.json()).toMatchObject({ error: 'not_your_wallet' })

      const ok = await call('POST', `/api/giveaways/${g.id}/send-back`, host, { toWallet: host.wallet })
      expect(ok.statusCode).toBe(202)
      const value = pol('1.3') - 21_000n * chain.maxFeePerGas
      expect(ok.json()).toMatchObject({ valueWei: value.toString() })
      const rows = await db.select().from(giveawayTxs).where(eq(giveawayTxs.kind, 'withdraw'))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        giveawayId: g.id, chain: 'polygon', fromAddress: g.walletAddress, toAddress: getAddress(host.wallet!), status: 'sending',
        valueWei: value.toString(), rawTx: null, nonce: null,
      })

      const busy = await call('POST', `/api/giveaways/${g.id}/send-back`, host, { toWallet: host.wallet })
      expect(busy.statusCode).toBe(409)
      expect(busy.json()).toEqual({ error: 'busy', message: 'Try again in a minute.' })
    })

    it('has nothing to send when withdrawable does not cover the transfer', async () => {
      const g = await create()
      chain.setBalance(g.walletAddress, 21_000n * chain.maxFeePerGas)
      const res = await call('POST', `/api/giveaways/${g.id}/send-back`, host, { toWallet: host.wallet })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'nothing_to_send' })
    })
  })

  describe('unsettled top-ups and replaced holds', () => {
    const topup = (g: { id: string; walletAddress: string }, status: 'sending' | 'sent' | 'replaced', value = '0.5') =>
      db.insert(giveawayTxs).values({ giveawayId: g.id, chain: 'polygon', kind: 'topup', fromAddress: randomWallet(), toAddress: g.walletAddress, status, valueWei: pol(value).toString() })

    it('I-2: send back is refused (busy) while a top-up into the wallet is unsettled', async () => {
      const g = await create()
      chain.setBalance(g.walletAddress, pol('7'))
      await topup(g, 'sent', '5')
      const res = await call('POST', `/api/giveaways/${g.id}/send-back`, host, { toWallet: host.wallet })
      expect([res.statusCode, res.json().error]).toEqual([409, 'busy'])
      expect(await db.select().from(giveawayTxs).where(eq(giveawayTxs.kind, 'withdraw'))).toHaveLength(0)
    })

    it('I-3: delete is refused (busy) while a top-up into the wallet is unsettled', async () => {
      const g = await create()
      await topup(g, 'sending')
      const res = await call('DELETE', `/api/giveaways/${g.id}`)
      expect([res.statusCode, res.json().error]).toEqual([409, 'busy'])
      expect((await db.select().from(giveaways).where(eq(giveaways.id, g.id)))[0].deleteState).toBeNull()
    })

    it('M-5: send back and delete are refused (replaced_hold) while a replaced transfer is unresolved; nothing shows as withdrawable', async () => {
      const g = await create()
      chain.setBalance(g.walletAddress, pol('3'))
      await topup(g, 'replaced')
      const res = await call('POST', `/api/giveaways/${g.id}/send-back`, host, { toWallet: host.wallet })
      expect([res.statusCode, res.json().error]).toEqual([409, 'replaced_hold'])
      expect(res.json().message).toBe('A transaction from this wallet is being checked. Virvi support will sort it out.')
      const del = await call('DELETE', `/api/giveaways/${g.id}`)
      expect([del.statusCode, del.json().error]).toEqual([409, 'replaced_hold'])
      expect((await call('GET', `/api/giveaways/${g.id}`)).json().funding).toMatchObject({ balanceWei: pol('3').toString(), withdrawableWei: '0' })
    })
  })

  describe('delete', () => {
    it('refuses while the host has POL to send back, then hands the float to the job', async () => {
      const g = await ready()
      await call('PATCH', `/api/giveaways/${g.id}`, host, { enabled: true })
      chain.setBalance(g.walletAddress, pol('1'))
      const res = await call('DELETE', `/api/giveaways/${g.id}`)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'send_back_first' })

      // Only Virvi's float left: not the host's to send back
      await db.insert(giveawayTxs).values({ giveawayId: g.id, chain: 'polygon', kind: 'topup', fromAddress: randomWallet(), toAddress: g.walletAddress, status: 'confirmed', valueWei: pol('1').toString() })
      const ok = await call('DELETE', `/api/giveaways/${g.id}`)
      expect(ok.statusCode).toBe(202)
      const [row] = await db.select().from(giveaways).where(eq(giveaways.id, g.id))
      expect(row).toMatchObject({ enabled: false, deleteState: 'returning', deletedAt: null })
      expect((await call('PATCH', `/api/giveaways/${g.id}`, host, { name: 'x' })).statusCode).toBe(409)
    })
  })

  it('event links never show the wallet key', async () => {
    const g = await create()
    const [event] = await db.insert(events).values({ ownerId: host.id, name: 'Festival' }).returning()
    await db.insert(eventGiveawayLinks).values({ eventId: event.id, giveawayId: g.id })
    const res = await call('GET', `/api/events/${event.id}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().event.giveawayLinks[0].giveaway.id).toBe(g.id)
    expect(res.body).not.toMatch(/keyEnc|v1:/)
  })

  it('items without a contract (old rows) are not ready', async () => {
    const g = await create()
    await db.insert(giveawayItems).values({ giveawayId: g.id, name: 'Old' })
    const view = (await call('GET', `/api/giveaways/${g.id}`)).json()
    expect(view.items[0]).toMatchObject({ name: 'Old', mintState: null })
  })
})
