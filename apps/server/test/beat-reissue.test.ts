import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { Wallet, getAddress, id as keccakText, parseEther } from 'ethers'
import { BEAT_RETENTION_DAYS, type BeatChain } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatClaims, beatPayments, beatReissueItems, beatReissueRequests, beats, userAuthMethods } from '../src/db/schema.js'
import { setBeatChainClientForTests } from '../src/beats/chain.js'
import { resetBeatJobState, runBeatTick } from '../src/beats/job.js'
import { deleteMyBeatData, scrubBeats } from '../src/beats/retention.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { fakeBeatChain, type FakeBeatChain } from './helpers/fake-beat-chain.js'

vi.mock('../src/errors/record.js', async (orig) => ({
  ...(await orig<typeof import('../src/errors/record.js')>()),
  recordJobFailure: vi.fn(),
}))

const H = 3_600_000
const DAY = 24 * H
const CONTRACT = '0x00000000000000000000000000000000000b3a75'
const SAFE = getAddress('0x5afe00000000000000000000000000000000beef')
const wallet = () => Wallet.createRandom().address.toLowerCase()
let nextToken = 7000

/** Safe's Transaction Builder checksum (safe-react-apps apps/tx-builder/src/lib/checksum.ts), written out again here so
 * the test checks the server's copy against an independent one. */
function txBuilderChecksum(file: any): string {
  const ser = (j: any): string => {
    if (Array.isArray(j)) return `[${j.map(ser).join(',')}]`
    if (typeof j === 'object' && j !== null) {
      const keys = Object.keys(j).sort()
      let acc = `{${JSON.stringify(keys)}`
      for (const k of keys) acc += `${ser(j[k])},`
      return `${acc}}`
    }
    return JSON.stringify(j === undefined ? null : j)
  }
  const { checksum: _c, ...meta } = file.meta
  return keccakText(ser({ ...file, meta: { ...meta, name: null } }))
}

/** The Safe runs a batch: each transaction's reissue on the fake chain, decoded from contractInputsValues. */
function runBatch(fake: FakeBeatChain, file: any) {
  return file.transactions.map((t: any) => {
    const v = t.contractInputsValues
    const ids = v.ids.replace(/^\[|\]$/g, '').split(',').map((x: string) => BigInt(x))
    return fake.reissue(v.from, v.to, ids)
  })
}

describe('BEAT reissue (LIV-11)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let fake: FakeBeatChain
  let admin: TestUser
  let me: TestUser
  let other: TestUser
  let oldW: string
  let newW: string
  const prev = config.beats
  const now = () => new Date()

  const setChain = (chain: BeatChain) => {
    ;(config as any).beats = {
      ...config.beats, enabled: true, chain, minGasWei: parseEther('1'),
      contracts: { [chain]: CONTRACT }, adminSafes: { [chain]: SAFE },
    }
    fake = fakeBeatChain({ chain })
    for (const c of ['polygon', 'polygon-amoy'] as const) setBeatChainClientForTests(c, c === chain ? fake : null)
  }

  beforeEach(async () => {
    await resetDb()
    resetBeatJobState()
    setChain('polygon-amoy')
    app = await testApp()
    admin = await createUser({ role: 'admin', name: 'Admin' })
    newW = wallet()
    oldW = wallet()
    me = await createUser({ wallet: newW, name: 'Me', email: 'me@test.dev' })
    other = await createUser({ wallet: wallet(), name: 'Other' })
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    setBeatChainClientForTests('polygon-amoy', null)
    setBeatChainClientForTests('polygon', null)
    await app.close()
  })

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, u: TestUser | null = me, payload?: unknown) =>
    app.inject({ method, url, payload: payload as any, headers: u ? { authorization: `Bearer ${tokenFor(u)}` } : {} })

  /** An ended BEAT on chain, with `holder`'s minted claim on `w` (on chain too). */
  async function minted(o: { holder?: TestUser | null; w?: string; tradeable?: boolean; open?: boolean; chain?: BeatChain; name?: string } = {}) {
    const tokenId = nextToken++
    const chain = o.chain ?? config.beats.chain
    const t = Date.now()
    const [b] = await db.insert(beats).values({
      chain, ownerUserId: admin.id, name: o.name ?? `Beat ${tokenId}`, description: '', tokenId, imageUrl: 'https://cdn.virvi.test/f.webp', tradeable: o.tradeable ?? false,
      startsAt: new Date(t - 3 * H), endsAt: o.open ? new Date(t + H) : new Date(t - 2 * H), status: o.open ? 'live' : 'ended',
      createdOnChainTx: '0xc', createdOnChainAt: new Date(t - 3 * H),
    }).returning()
    const [p] = await db.insert(beatPayments).values({ beatId: b.id, userId: admin.id, kind: 'create', capFrom: 0, capTo: 100, method: 'test', amountCents: 0, status: 'paid', paidAt: new Date() }).returning()
    await db.update(beats).set({ paymentId: p.id }).where(eq(beats.id, b.id))
    const w = o.w ?? oldW
    const holder = o.holder === undefined ? me : o.holder
    const [c] = await db.insert(beatClaims).values({
      beatId: b.id, userId: holder?.id ?? null, wallet: w, displayName: holder?.displayName ?? null, consentVersion: 1, status: 'minted', mintTx: '0x' + 'aa'.repeat(32), mintedAt: new Date(),
    }).returning()
    if (fake.chain === chain) fake.createdBeat(BigInt(tokenId), { tradeable: o.tradeable ?? false, minted: [w] })
    return { beat: b, claim: c, tokenId }
  }

  const ask = (body: Record<string, unknown> = {}, u: TestUser = me) =>
    call('POST', '/api/beats/reissue-requests', u, { oldWallet: oldW, newWallet: newW, reason: 'My wallet was drained.', ...body })

  async function approved() {
    const res = await ask()
    expect(res.statusCode).toBe(201)
    const id = res.json().id
    expect((await call('POST', `/api/admin/beats/reissue-requests/${id}/approve`, admin, { note: 'Checked on a call.' })).statusCode).toBe(200)
    return id as string
  }

  const queue = async (status?: string) => {
    const res = await call('GET', `/api/admin/beats/reissue-requests${status ? `?status=${status}` : ''}`, admin)
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  const batch = (id: string, chain: string = config.beats.chain) => call('GET', `/api/admin/beats/reissue-requests/${id}/safe-batch?chain=${chain}`, admin)

  describe('requests from the person', () => {
    it('refuses every bad request with its error', async () => {
      await minted()
      const cases: Array<[Record<string, unknown>, number, string]> = [
        [{ oldWallet: 'nope' }, 400, 'bad_wallet'],
        [{ newWallet: 42 }, 400, 'bad_wallet'],
        [{ oldWallet: newW }, 400, 'same_wallet'],
        [{ oldWallet: newW.toUpperCase().replace('0X', '0x') }, 400, 'same_wallet'],
        [{ reason: '' }, 400, 'bad_reason'],
        [{ reason: '   ' }, 400, 'bad_reason'],
        [{ reason: 'x'.repeat(1001) }, 400, 'bad_reason'],
        [{ newWallet: wallet() }, 400, 'wallet_not_linked'],
        [{ newWallet: other.wallet }, 400, 'wallet_not_linked'],
        [{ oldWallet: wallet() }, 400, 'no_beats_on_wallet'],
      ]
      for (const [body, status, error] of cases) {
        const res = await ask(body)
        expect([res.statusCode, res.json().error], JSON.stringify(body)).toEqual([status, error])
      }
      expect(await db.select().from(beatReissueRequests)).toEqual([])
    })

    it('needs the new wallet verified on this account, and minted (not just claimed) BEATs of this account on the old one', async () => {
      const unverified = wallet()
      await db.insert(userAuthMethods).values({ userId: me.id, type: 'wallet', identifier: unverified, metadata: { verified: false } })
      await minted()
      expect((await ask({ newWallet: unverified })).json().error).toBe('wallet_not_linked')

      // Someone else's BEAT on that wallet, and a claim of mine that isn't minted, don't count
      const theirs = wallet()
      await minted({ holder: other, w: theirs })
      expect((await ask({ oldWallet: theirs })).json().error).toBe('no_beats_on_wallet')
      const unsent = wallet()
      const { claim } = await minted({ w: unsent })
      await db.update(beatClaims).set({ status: 'claimed' }).where(eq(beatClaims.id, claim.id))
      expect((await ask({ oldWallet: unsent })).json().error).toBe('no_beats_on_wallet')

      // A 1,000-character reason is fine; wallets in any case are stored lower-case
      const res = await ask({ reason: 'y'.repeat(1000), oldWallet: getAddress(oldW), newWallet: getAddress(newW) })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ oldWallet: oldW, newWallet: newW, status: 'pending', reviewNote: null })
    })

    it('allows one open request per account at a time', async () => {
      await minted()
      const first = await ask()
      expect(first.statusCode).toBe(201)
      expect(first.json().beats).toHaveLength(1)
      expect((await ask()).json().error).toBe('request_open')
      expect((await ask()).statusCode).toBe(409)
      // The database refuses a second open row too, whatever the code checks
      await expect(db.insert(beatReissueRequests).values({ userId: me.id, oldWallet: oldW, newWallet: newW, reason: 'x', status: 'approved' })).rejects.toThrow()

      // Cancelled, the account may ask again; approved still counts as open, rejected doesn't
      expect((await call('DELETE', `/api/beats/reissue-requests/${first.json().id}`)).statusCode).toBe(200)
      const second = await ask()
      expect(second.statusCode).toBe(201)
      await call('POST', `/api/admin/beats/reissue-requests/${second.json().id}/approve`, admin, {})
      expect((await ask()).json().error).toBe('request_open')
      await call('POST', `/api/admin/beats/reissue-requests/${second.json().id}/reject`, admin, { note: 'Not you.' })
      expect((await ask()).statusCode).toBe(201)
    })

    it("lists only the account's own requests, and cancels only its own pending one", async () => {
      await minted()
      const mine = (await ask()).json()
      const otherOld = wallet()
      const otherNew = other.wallet!
      await minted({ holder: other, w: otherOld })
      const theirs = (await call('POST', '/api/beats/reissue-requests', other, { oldWallet: otherOld, newWallet: otherNew, reason: 'stolen' })).json()

      const list = (await call('GET', '/api/beats/reissue-requests')).json()
      expect(list.map((r: any) => r.id)).toEqual([mine.id])
      expect(list[0]).toMatchObject({ status: 'pending', reason: 'My wallet was drained.', beats: [{ chain: 'polygon-amoy', state: null }] })

      expect((await call('DELETE', `/api/beats/reissue-requests/${theirs.id}`)).statusCode).toBe(404)
      expect((await call('DELETE', '/api/beats/reissue-requests/not-a-uuid')).statusCode).toBe(404)
      const [row] = await db.select().from(beatReissueRequests).where(eq(beatReissueRequests.id, theirs.id))
      expect(row.status).toBe('pending')

      await call('POST', `/api/admin/beats/reissue-requests/${mine.id}/approve`, admin, {})
      const res = await call('DELETE', `/api/beats/reissue-requests/${mine.id}`)
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_pending'])
    })

    it('needs a signed-in account', async () => {
      expect((await call('GET', '/api/beats/reissue-requests', null)).statusCode).toBe(401)
      expect((await call('POST', '/api/beats/reissue-requests', null, {})).statusCode).toBe(401)
    })
  })

  describe('the admin review queue', () => {
    it('shows the account, the wallets and each BEAT with a live chain read and what blocks it', async () => {
      const plain = await minted({ name: 'Plain' })
      const held = await minted({ name: 'Held', tradeable: true })
      const moved = await minted({ name: 'Moved', tradeable: true })
      fake.moveOut(BigInt(moved.tokenId), oldW)
      const replaced = await minted({ name: 'Replaced' })
      expect(fake.reissue(oldW, wallet(), [BigInt(replaced.tokenId)])).toHaveProperty('hash')
      const has = await minted({ name: 'Has' })
      fake.createdBeat(BigInt(has.tokenId), { minted: [oldW, newW] })
      const open = await minted({ name: 'Open', open: true })
      const clash = await minted({ name: 'Clash' })
      await db.insert(beatClaims).values({ beatId: clash.beat.id, wallet: newW, consentVersion: 1, status: 'failed', failReason: 'given_up' })
      const id = (await ask()).json().id

      const [r] = await queue()
      expect(r).toMatchObject({
        id, status: 'pending', oldWallet: oldW, newWallet: newW, reason: 'My wallet was drained.',
        account: { id: me.id, displayName: 'Me', email: 'me@test.dev' }, reviewer: null,
      })
      const by = Object.fromEntries(r.beats.map((b: any) => [b.name, b]))
      expect(Object.keys(by).sort()).toEqual(['Clash', 'Has', 'Held', 'Moved', 'Open', 'Plain', 'Replaced'])
      expect(by.Plain).toMatchObject({
        claimId: plain.claim.id, beatId: plain.beat.id, chain: 'polygon-amoy', tokenId: String(plain.tokenId), tradeable: false,
        chainState: { oldBalance: '1', replacedBy: null, newMinted: false }, blockers: [], eligible: true, state: null,
      })
      expect(by.Held).toMatchObject({ tradeable: true, eligible: true, blockers: [] })
      expect(by.Moved).toMatchObject({ chainState: { oldBalance: '0' }, blockers: ['NothingToReplace'], eligible: false })
      expect(by.Replaced.blockers).toEqual(['AlreadyReplaced'])
      expect(by.Replaced.chainState.replacedBy).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(by.Has).toMatchObject({ chainState: { newMinted: true }, blockers: ['AlreadyMinted'] })
      expect(by.Open.blockers).toEqual(['BeatOpen'])
      expect(by.Clash.blockers).toEqual(['ClaimOnNewWallet'])
      expect(held.claim.id).toBeTruthy()
    })

    it('marks every BEAT ChainUnavailable when the chain is down, and lists closed requests only when asked', async () => {
      await minted()
      const id = (await ask()).json().id
      fake.setDown(true)
      const [r] = await queue()
      expect(r.beats[0]).toMatchObject({ chainState: null, blockers: ['ChainUnavailable'], eligible: false })
      fake.setDown(false)
      await call('POST', `/api/admin/beats/reissue-requests/${id}/reject`, admin, { note: 'No.' })
      expect(await queue()).toEqual([])
      expect((await queue('all')).map((x: any) => x.id)).toEqual([id])
      expect((await queue('rejected')).map((x: any) => x.id)).toEqual([id])
      expect((await call('GET', '/api/admin/beats/reissue-requests?status=nope', admin)).statusCode).toBe(400)
    })

    it('approves or rejects a pending request with a note the person sees', async () => {
      await minted()
      const id = (await ask()).json().id
      let res = await call('POST', `/api/admin/beats/reissue-requests/${id}/reject`, admin, {})
      expect([res.statusCode, res.json().error]).toEqual([400, 'bad_note'])
      res = await call('POST', `/api/admin/beats/reissue-requests/${id}/approve`, admin, { note: 'z'.repeat(1001) })
      expect([res.statusCode, res.json().error]).toEqual([400, 'bad_note'])
      res = await call('POST', `/api/admin/beats/reissue-requests/${id}/reject`, admin, { note: 'We could not confirm it was you.' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'rejected', reviewNote: 'We could not confirm it was you.', reviewer: { id: admin.id } })
      const [mine] = (await call('GET', '/api/beats/reissue-requests')).json()
      expect(mine).toMatchObject({ status: 'rejected', reviewNote: 'We could not confirm it was you.' })
      expect(mine.reviewer).toBeUndefined()
      res = await call('POST', `/api/admin/beats/reissue-requests/${id}/approve`, admin, {})
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_pending'])
      expect((await call('POST', '/api/admin/beats/reissue-requests/00000000-0000-4000-8000-000000000001/approve', admin, {})).statusCode).toBe(404)
    })

    it('is for site admins only, and dark with the rest of BEAT', async () => {
      await minted()
      const id = (await ask()).json().id
      const routes: Array<['GET' | 'POST', string, unknown?]> = [
        ['GET', '/api/admin/beats/reissue-requests'],
        ['POST', `/api/admin/beats/reissue-requests/${id}/approve`, {}],
        ['POST', `/api/admin/beats/reissue-requests/${id}/reject`, { note: 'x' }],
        ['GET', `/api/admin/beats/reissue-requests/${id}/safe-batch?chain=polygon-amoy`],
      ]
      for (const [m, url, body] of routes) {
        expect((await call(m, url, me, body)).statusCode, `${m} ${url} account`).toBe(403)
        expect((await call(m, url, null, body)).statusCode, `${m} ${url} anon`).toBe(401)
      }
      const [row] = await db.select().from(beatReissueRequests)
      expect(row.status).toBe('pending')
      ;(config as any).beats = { ...config.beats, enabled: false }
      for (const [m, url, body] of [...routes, ['GET', '/api/beats/reissue-requests'] as ['GET', string]]) {
        expect((await call(m, url, admin, body)).statusCode, `${m} ${url} dark`).toBe(404)
      }
    })
  })

  describe('the Safe transaction batch', () => {
    it("is Safe Transaction Builder JSON: the non-tradeable ids in one reissue, each tradeable id in its own, blocked ids left out", async () => {
      const a = await minted()
      const b = await minted()
      const t1 = await minted({ tradeable: true })
      const t2 = await minted({ tradeable: true })
      const gone = await minted({ tradeable: true })
      fake.moveOut(BigInt(gone.tokenId), oldW)
      const id = await approved()

      const res = await batch(id)
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toMatch(/application\/json/)
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="virvi-beat-reissue-[0-9a-f]{8}-polygon-amoy\.json"$/)
      const file = res.json()
      const method = {
        inputs: [
          { internalType: 'address', name: 'from', type: 'address' },
          { internalType: 'address', name: 'to', type: 'address' },
          { internalType: 'uint256[]', name: 'ids', type: 'uint256[]' },
        ],
        name: 'reissue', payable: false,
      }
      const tx = (ids: number[]) => ({
        to: getAddress(CONTRACT), value: '0', data: null, contractMethod: method,
        contractInputsValues: { from: getAddress(oldW), to: getAddress(newW), ids: `[${ids.join(',')}]` },
      })
      expect(file).toEqual({
        version: '1.0', chainId: '80002', createdAt: expect.any(Number),
        meta: {
          name: expect.stringMatching(/^Virvi BEAT reissue [0-9a-f]{8}$/), description: expect.any(String),
          createdFromSafeAddress: SAFE, checksum: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        },
        transactions: [tx([a.tokenId, b.tokenId]), tx([t1.tokenId]), tx([t2.tokenId])],
      })
      expect(file.meta.checksum).toBe(txBuilderChecksum(file))
      // Every number is a string (Transaction Builder refuses a file with a JSON number in a transaction)
      for (const t of file.transactions) for (const v of Object.values(t.contractInputsValues)) expect(typeof v).toBe('string')

      // The request is proposed, with which id went into which call
      const [r] = await db.select().from(beatReissueRequests).where(eq(beatReissueRequests.id, id))
      expect(r.status).toBe('proposed')
      const items = await db.select().from(beatReissueItems).where(eq(beatReissueItems.requestId, id))
      const byToken = Object.fromEntries(items.map((i) => [i.tokenId, i]))
      expect([a, b, t1, t2, gone].map((x) => [byToken[x.tokenId].state, byToken[x.tokenId].callIndex, byToken[x.tokenId].blockers])).toEqual([
        ['proposed', 0, []], ['proposed', 0, []], ['proposed', 1, []], ['proposed', 2, []], ['skipped', null, ['NothingToReplace']],
      ])
      expect(byToken[a.tokenId].proposedBlock).toBe(fake.block)
      const [q] = await queue()
      expect(q.status).toBe('proposed')
      expect(q.beats.find((x: any) => x.tokenId === String(t2.tokenId))).toMatchObject({ state: 'proposed', callIndex: 2 })
    })

    it('splits the non-tradeable ids into calls of at most MAX_BATCH (200)', async () => {
      const ids: number[] = []
      for (let i = 0; i < 201; i++) ids.push((await minted()).tokenId)
      const id = await approved()
      const file = (await batch(id)).json()
      expect(file.transactions.map((t: any) => t.contractInputsValues.ids.split(',').length)).toEqual([200, 1])
      expect(file.transactions[0].contractInputsValues.ids).toBe(`[${ids.slice(0, 200).join(',')}]`)
      expect(file.transactions[1].contractInputsValues.ids).toBe(`[${ids[200]}]`)
    }, 60_000)

    it('is only for an approved or proposed request, a known chain and a configured contract; Polygon gives chainId 137', async () => {
      await minted()
      const pending = (await ask()).json().id
      let res = await batch(pending)
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_approved'])
      await call('POST', `/api/admin/beats/reissue-requests/${pending}/approve`, admin, {})
      res = await batch(pending, 'ethereum')
      expect([res.statusCode, res.json().error]).toEqual([400, 'bad_chain'])
      res = await batch(pending, 'polygon')
      expect([res.statusCode, res.json().error]).toEqual([409, 'no_contract'])

      // The new wallet unlinked since: refused
      await db.delete(userAuthMethods).where(eq(userAuthMethods.identifier, newW))
      res = await batch(pending)
      expect([res.statusCode, res.json().error]).toEqual([409, 'wallet_not_linked'])
    })

    it('on Polygon names chain 137 and omits the Safe when none is set', async () => {
      setChain('polygon')
      ;(config as any).beats.adminSafes = {}
      const m = await minted({ chain: 'polygon' })
      const id = await approved()
      const file = (await batch(id, 'polygon')).json()
      expect(file.chainId).toBe('137')
      expect(file.meta.createdFromSafeAddress).toBeUndefined()
      expect(file.meta.checksum).toBe(txBuilderChecksum(file))
      expect(file.transactions[0].contractInputsValues.ids).toBe(`[${m.tokenId}]`)
    })

    it('with nothing left to reissue, refuses and records why, so a request whose last ids are blocked can close', async () => {
      const gone = await minted({ tradeable: true })
      fake.moveOut(BigInt(gone.tokenId), oldW)
      const id = await approved()
      const res = await batch(id)
      expect([res.statusCode, res.json().error]).toEqual([409, 'nothing_to_reissue'])
      const [r] = await db.select().from(beatReissueRequests).where(eq(beatReissueRequests.id, id))
      expect(r.status).toBe('approved')
    })
  })

  describe('completion', () => {
    async function proposed() {
      const a = await minted()
      const b = await minted()
      const t1 = await minted({ tradeable: true })
      const id = await approved()
      const file = (await batch(id)).json()
      return { a, b, t1, id, file }
    }
    const request = async (id: string) => (await db.select().from(beatReissueRequests).where(eq(beatReissueRequests.id, id)))[0]
    const claim = async (claimId: string) => (await db.select().from(beatClaims).where(eq(beatClaims.id, claimId)))[0]

    it('marks every claim reissued and the request done once all land at the confirmation depth (5 on Amoy)', async () => {
      const { a, b, t1, id, file } = await proposed()
      await runBeatTick(now())
      expect((await request(id)).status).toBe('proposed')

      const out = runBatch(fake, file)
      expect(out.every((o: any) => 'hash' in o)).toBe(true)
      // The Safe's calls are mined one block apart (the fake mines each reissue in its own block): 101, then 102
      fake.mine(3)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('proposed')
      expect((await claim(a.claim.id)).wallet).toBe(oldW)

      // 5 blocks after the first call: its ids are done, the tradeable one's call isn't deep enough yet
      fake.mine(1)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('proposed')
      expect((await claim(a.claim.id)).wallet).toBe(newW)
      expect((await claim(t1.claim.id)).wallet).toBe(oldW)

      fake.mine(1)
      await runBeatTick(now())
      const r = await request(id)
      expect(r.status).toBe('done')
      expect(r.doneAt).not.toBeNull()
      for (const [x, o] of [[a, out[0]], [b, out[0]], [t1, out[1]]] as const) {
        const c = await claim(x.claim.id)
        expect(c).toMatchObject({ wallet: newW, replacedWallet: oldW, reissueTx: (o as any).hash, status: 'minted', userId: me.id })
        expect(c.reissuedAt).not.toBeNull()
      }
      const items = await db.select().from(beatReissueItems).where(eq(beatReissueItems.requestId, id))
      expect(items.every((i) => i.state === 'reissued' && i.txHash)).toBe(true)
      const [mine] = (await call('GET', '/api/beats/reissue-requests')).json()
      expect(mine.status).toBe('done')
      expect(mine.beats.map((x: any) => x.state)).toEqual(['reissued', 'reissued', 'reissued'])
    })

    it('waits for 30 confirmations on Polygon', async () => {
      setChain('polygon')
      const a = await minted({ chain: 'polygon' })
      const id = await approved()
      runBatch(fake, (await batch(id, 'polygon')).json())
      fake.mine(29)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('proposed')
      fake.mine(1)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('done')
      expect((await claim(a.claim.id)).wallet).toBe(newW)
    })

    it('keeps a request proposed with per-id state when a tradeable copy moved before the Safe signed, then closes it', async () => {
      const { a, b, t1, id, file } = await proposed()
      fake.moveOut(BigInt(t1.tokenId), oldW)
      const out = runBatch(fake, file)
      expect(out[1]).toEqual({ reason: 'NothingToReplace' })
      fake.mine(5)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('proposed')
      expect((await claim(a.claim.id)).wallet).toBe(newW)
      expect((await claim(b.claim.id)).wallet).toBe(newW)
      expect((await claim(t1.claim.id))).toMatchObject({ wallet: oldW, replacedWallet: null, reissuedAt: null })

      const [q] = await queue()
      const t = q.beats.find((x: any) => x.tokenId === String(t1.tokenId))
      expect(t).toMatchObject({ state: 'proposed', blockers: ['NothingToReplace'], eligible: false })
      expect(q.beats.filter((x: any) => x.state === 'reissued')).toHaveLength(2)

      // The holder buys a copy back: a new batch has only that id
      const again = async () => (await batch(id)).json()
      fake.createdBeat(BigInt(t1.tokenId), { tradeable: true, minted: [oldW] })
      const file2 = await again()
      expect(file2.transactions.map((x: any) => x.contractInputsValues.ids)).toEqual([`[${t1.tokenId}]`])
      // It moves out again: preparing now finds nothing to reissue and closes the request
      fake.moveOut(BigInt(t1.tokenId), oldW)
      const res = await batch(id)
      expect([res.statusCode, res.json().error]).toEqual([409, 'nothing_to_reissue'])
      expect((await request(id)).status).toBe('done')
      const [item] = await db.select().from(beatReissueItems).where(and(eq(beatReissueItems.requestId, id), eq(beatReissueItems.tokenId, t1.tokenId)))
      expect(item).toMatchObject({ state: 'skipped', blockers: ['NothingToReplace'] })
    })

    it('keeps ids that landed but are not yet deep enough proposed when the batch is prepared again', async () => {
      const { a, t1, id, file } = await proposed()
      runBatch(fake, file)
      let res = await batch(id)
      expect([res.statusCode, res.json().error]).toEqual([409, 'nothing_to_reissue'])
      const items = await db.select().from(beatReissueItems).where(eq(beatReissueItems.requestId, id))
      expect(items.map((i) => i.state)).toEqual(['proposed', 'proposed', 'proposed'])
      const [q] = await queue()
      expect(q.beats.find((x: any) => x.tokenId === String(t1.tokenId))).toMatchObject({ landed: true, blockers: ['AlreadyReplaced', 'AlreadyMinted'], state: 'proposed', eligible: false })
      fake.mine(5)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('done')
      expect((await claim(a.claim.id)).wallet).toBe(newW)
      res = await batch(id)
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_approved'])
    })

    it('counts a reissued claim once, under its new wallet, with a reissued flag for the host', async () => {
      const { a, file, id } = await proposed()
      runBatch(fake, file)
      fake.mine(5)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('done')

      const host = await call('GET', `/api/beats/${a.beat.id}`, admin)
      expect(host.json().counts).toMatchObject({ minted: 1 })
      const claimants = (await call('GET', `/api/beats/${a.beat.id}/claimants`, admin)).json()
      expect(claimants).toHaveLength(1)
      expect(claimants[0]).toMatchObject({ wallet: newW, status: 'minted', reissued: true, reissueTxUrl: expect.stringMatching(/^https:\/\/amoy\.polygonscan\.com\/tx\/0x/) })
      const counts = (await call('GET', '/api/admin/beats', admin)).json().counts
      expect(counts).toMatchObject({ minting: 0 })
      const [mintedCount] = await db.select().from(beatClaims).where(eq(beatClaims.beatId, a.beat.id))
      expect(mintedCount.wallet).toBe(newW)
    })
  })

  describe('privacy', () => {
    it("delete-my-data deletes the account's reissue requests and nulls replaced_wallet on its unlinked claims", async () => {
      const { claim } = await minted()
      const id = await approved()
      runBatch(fake, (await batch(id)).json())
      fake.mine(5)
      await runBeatTick(now())
      const otherOld = wallet()
      await minted({ holder: other, w: otherOld })
      await call('POST', '/api/beats/reissue-requests', other, { oldWallet: otherOld, newWallet: other.wallet, reason: 'stolen' })

      await deleteMyBeatData(me.id, now())
      expect((await db.select().from(beatReissueRequests)).map((r) => r.userId)).toEqual([other.id])
      expect(await db.select().from(beatReissueItems)).toEqual([])
      const [c] = await db.select().from(beatClaims).where(eq(beatClaims.id, claim.id))
      expect(c).toMatchObject({ userId: null, wallet: newW, replacedWallet: null })
      expect(c.reissuedAt).not.toBeNull()
    })

    it('the 30-day scrub deletes requests closed that long ago and leaves open ones', async () => {
      await minted()
      const old = (await ask()).json().id
      await call('POST', `/api/admin/beats/reissue-requests/${old}/reject`, admin, { note: 'No.' })
      const open = (await ask()).json().id
      const later = new Date(Date.now() + (BEAT_RETENTION_DAYS + 1) * DAY)
      expect(await scrubBeats(later)).toMatchObject({ reissueRequests: 1 })
      expect((await db.select().from(beatReissueRequests)).map((r) => r.id)).toEqual([open])
      expect(await scrubBeats(new Date(Date.now() + (BEAT_RETENTION_DAYS + 9) * DAY))).toMatchObject({ reissueRequests: 0 })
    })
  })
})
