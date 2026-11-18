import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getAddress } from 'ethers'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatClaims, beatHoldings, beats, userAuthMethods } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const H = 3_600_000
const at = (ms: number) => new Date(Date.now() + ms)
const CONTRACT = '0x00000000000000000000000000000000000b3a75'

describe('BEAT collection (LIV-185)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  const prev = config.beats

  beforeEach(async () => {
    await resetDb()
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon' }
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    await app.close()
  })

  let tokenSeq = 500
  async function seed(over: Partial<typeof beats.$inferInsert> = {}) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon', ownerUserId: host.id, name: 'Opening night', description: 'x', imageUrl: 'https://cdn.example/frozen.png',
      tokenId: tokenSeq++, status: 'ended', contractAddress: getAddress(CONTRACT), locationLabel: 'The Stage',
      startsAt: at(-3 * H), endsAt: at(-2 * H), ...over,
    }).returning()
    return b
  }
  const hold = (b: { chain: string; tokenId: number | null }, wallet: string, over: Partial<typeof beatHoldings.$inferInsert> = {}) =>
    db.insert(beatHoldings).values({
      chain: b.chain as any, contract: CONTRACT, tokenId: BigInt(b.tokenId!), wallet: wallet.toLowerCase(), balance: '1', updatedBlock: 1, ...over,
    })
  const minted = (b: { id: string }, wallet: string, over: Partial<typeof beatClaims.$inferInsert> = {}) =>
    db.insert(beatClaims).values({
      beatId: b.id, wallet: wallet.toLowerCase(), consentVersion: 1, status: 'minted', mintTx: '0xabc', claimedAt: at(-H), mintedAt: at(-H), ...over,
    })
  const mine = (u: TestUser) => app.inject({ method: 'GET', url: '/api/beats/collection', headers: { authorization: `Bearer ${tokenFor(u)}` } })
  const pub = (address: string) => app.inject({ method: 'GET', url: `/api/wallets/${address}/beats` })

  it("the signed-in collection lists every linked wallet's BEATs with the holder, Earned or Held, newest first", async () => {
    const w2 = randomWallet()
    const user = await createUser({ wallet: randomWallet() })
    await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: w2, metadata: { verified: true } })
    const older = await seed({ name: 'Older', startsAt: at(-10 * H), endsAt: at(-9 * H) })
    const newer = await seed({ name: 'Newer' })
    await hold(older, user.wallet!)
    await hold(newer, w2, { balance: '2' })
    await minted(older, user.wallet!)
    const res = await mine(user)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.wallets.map((w: string) => w.toLowerCase()).sort()).toEqual([user.wallet!, w2].sort())
    expect(body.wallets).toContain(getAddress(w2))
    expect(body.beats.map((b: any) => b.name)).toEqual(['Newer', 'Older'])
    expect(body.beats[0]).toMatchObject({
      tokenId: String(newer.tokenId), contract: getAddress(CONTRACT), chain: 'polygon', kind: 'basic', wallet: getAddress(w2), quantity: 2,
      earned: false, place: 'The Stage', imageUrl: 'https://cdn.example/frozen.png', mintTxUrl: null, claimedAt: null,
    })
    expect(body.beats[0].tokenUrl).toContain(`/token/${getAddress(CONTRACT)}?a=${newer.tokenId}`)
    expect(body.beats[1]).toMatchObject({ earned: true, wallet: getAddress(user.wallet!) })
    expect(body.beats[1].mintTxUrl).toContain('/tx/0xabc')
    expect(body.beats[1].claimedAt).toEqual(expect.any(String))
  })

  it('Earned needs a minted claim by that same wallet; a bought BEAT is Held', async () => {
    const a = randomWallet()
    const user = await createUser({ wallet: randomWallet() })
    await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: a, metadata: { verified: true } })
    const b = await seed()
    await minted(b, a)
    await hold(b, user.wallet!)
    const beatsOut = (await mine(user)).json().beats
    expect(beatsOut).toHaveLength(1)
    expect(beatsOut[0]).toMatchObject({ wallet: getAddress(user.wallet!), earned: false, mintTxUrl: null, claimedAt: null })
  })

  it('a reissued claim is Earned for the new wallet', async () => {
    const user = await createUser({ wallet: randomWallet() })
    const oldW = randomWallet()
    const b = await seed()
    await hold(b, user.wallet!)
    await minted(b, user.wallet!, { replacedWallet: oldW.toLowerCase(), reissueTx: '0xdef' })
    expect((await mine(user)).json().beats[0]).toMatchObject({ earned: true, wallet: getAddress(user.wallet!) })
  })

  it('a reissued-away token (replaced_by set) does not show on the old wallet; the new wallet shows it as Earned', async () => {
    const oldUser = await createUser({ wallet: randomWallet() })
    const newUser = await createUser({ wallet: randomWallet() })
    const b = await seed()
    await hold(b, oldUser.wallet!, { replacedBy: newUser.wallet })
    await hold(b, newUser.wallet!)
    await minted(b, newUser.wallet!, { replacedWallet: oldUser.wallet })
    expect((await mine(oldUser)).json().beats).toEqual([])
    expect((await pub(oldUser.wallet!)).json().beats).toEqual([])
    expect((await mine(newUser)).json().beats[0]).toMatchObject({ earned: true, wallet: getAddress(newUser.wallet!) })
  })

  it('an unlinked minted claim is still Earned but has no claimedAt', async () => {
    const user = await createUser({ wallet: randomWallet() })
    const b = await seed()
    await hold(b, user.wallet!)
    await minted(b, user.wallet!, { claimedAt: null, consentedAt: null })
    expect((await mine(user)).json().beats[0]).toMatchObject({ earned: true, claimedAt: null })
  })

  it('Amoy BEATs and tokens without a beats row never show on polygon', async () => {
    const user = await createUser({ wallet: randomWallet() })
    const amoy = await seed({ chain: 'polygon-amoy', name: 'Amoy' })
    await hold(amoy, user.wallet!)
    await db.insert(beatHoldings).values({ chain: 'polygon', contract: CONTRACT, tokenId: 99999n, wallet: user.wallet!, balance: '1', updatedBlock: 1 })
    const ok = await seed({ name: 'Real' })
    await hold(ok, user.wallet!)
    expect((await mine(user)).json().beats.map((b: any) => b.name)).toEqual(['Real'])
  })

  it('refuses a trial or a scene pass and a signed-out caller', async () => {
    const user = await createUser({ wallet: randomWallet() })
    expect((await mine(user)).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/beats/collection' })).statusCode).toBe(401)
    const scene = await app.inject({ method: 'GET', url: '/api/beats/collection', headers: { authorization: `Bearer ${tokenFor(user, { kind: 'scene', sceneId: crypto.randomUUID() })}` } })
    expect(scene.statusCode).toBeGreaterThanOrEqual(403)
    const trial = await app.inject({ method: 'GET', url: '/api/beats/collection', headers: { authorization: `Bearer ${tokenFor(user, { trial: true })}` } })
    expect(trial.statusCode).toBe(403)
  })

  it('the public page: mixed-case address works, an invalid one is 404, an empty wallet is 200 with beats [] and the same keys as a full one', async () => {
    const user = await createUser({ wallet: randomWallet(), email: 'secret-person@example.com' })
    const other = randomWallet()
    await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: other, metadata: { verified: true } })
    const b = await seed()
    await hold(b, user.wallet!)
    await minted(b, user.wallet!)
    const full = await pub(getAddress(user.wallet!))
    expect(full.statusCode, full.body).toBe(200)
    const body = full.json()
    expect(body.wallet).toBe(getAddress(user.wallet!))
    expect(body.beats).toHaveLength(1)
    expect(body.beats[0].earned).toBe(true)
    expect(body.beats[0].claimedAt).toBeNull()
    expect(full.body).not.toContain('userId')
    expect(full.body).not.toContain('secret-person')
    expect(full.body.toLowerCase()).not.toContain(other.toLowerCase())
    expect((await pub(user.wallet!.toUpperCase().replace('0X', '0x'))).statusCode).toBe(200)
    expect((await pub('not-an-address')).statusCode).toBe(404)
    expect((await pub('not-an-address')).json()).toMatchObject({ error: 'not_found' })
    const empty = await pub(getAddress(randomWallet()))
    expect(empty.statusCode).toBe(200)
    expect(empty.json().beats).toEqual([])
    expect(Object.keys(empty.json()).sort()).toEqual(Object.keys(body).sort())
  })

  it('the public response is cacheable', async () => {
    const res = await pub(getAddress(randomWallet()))
    expect(res.headers['cache-control']).toBe('public, max-age=60')
  })

  it('the public page is 404 when BEATs are off', async () => {
    ;(config as any).beats = { ...config.beats, enabled: false }
    expect((await pub(getAddress(randomWallet()))).statusCode).toBe(404)
  })

})
