import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { Wallet, getAddress, id as keccakText, parseEther } from 'ethers'
import { BEAT_RETENTION_DAYS, type BeatChain } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import {
  accountWalletEvents, beatClaims, beatPayments, beatReissueFiles, beatReissueItems, beatReissueRequests, beats, userAuthMethods, walletBlocks,
} from '../src/db/schema.js'
import { setBeatChainClientForTests } from '../src/beats/chain.js'
import { resetBeatJobState, runBeatTick } from '../src/beats/job.js'
import { deleteMyBeatData, scrubBeats } from '../src/beats/retention.js'
import { linkVerifiedWallet } from '../src/auth/wallet-users.js'
import { recordJobFailure } from '../src/errors/record.js'
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

/** The Safe runs one file (one Safe transaction): its single reissue on the fake chain, from contractInputsValues. */
function runFile(fake: FakeBeatChain, file: any) {
  expect(file.transactions).toHaveLength(1)
  const v = file.transactions[0].contractInputsValues
  const ids = v.ids.replace(/^\[|\]$/g, '').split(',').map((x: string) => BigInt(x))
  return fake.reissue(v.from, v.to, ids)
}
const runFiles = (fake: FakeBeatChain, files: any[]) => files.map((f) => runFile(fake, f.file))

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
    vi.mocked(recordJobFailure).mockClear()
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

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, u: TestUser | null = me, payload?: unknown, claims: Record<string, unknown> = {}) =>
    app.inject({ method, url, payload: payload as any, headers: u ? { authorization: `Bearer ${tokenFor(u, claims)}` } : {} })

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

  const ask = (body: Record<string, unknown> = {}, u: TestUser = me, claims: Record<string, unknown> = {}) =>
    call('POST', '/api/beats/reissue-requests', u, { oldWallet: oldW, newWallet: newW, reason: 'My wallet was drained.', ...body }, claims)

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

  const propose = (id: string, chain: string = config.beats.chain) => call('POST', `/api/admin/beats/reissue-requests/${id}/propose`, admin, { chain })
  const proposedFiles = async (id: string, chain?: string) => {
    const res = await propose(id, chain)
    expect(res.statusCode, res.body).toBe(200)
    return res.json().files as any[]
  }
  const request = async (id: string) => (await db.select().from(beatReissueRequests).where(eq(beatReissueRequests.id, id)))[0]
  const claim = async (claimId: string) => (await db.select().from(beatClaims).where(eq(beatClaims.id, claimId)))[0]
  const refresh = (u: TestUser, w: string | null) =>
    app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${tokenFor(u, { wallet: w, refresh: true })}` } })

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

    it('refuses a session signed in with the old wallet, and records how the filing session signed in', async () => {
      await minted()
      const res = await ask({}, me, { wallet: oldW })
      expect([res.statusCode, res.json().error]).toEqual([403, 'signed_in_with_old_wallet'])
      // By email (a password session): fine, and recorded
      const ok = await ask({}, me, { wallet: null, am: 'email' })
      expect(ok.statusCode).toBe(201)
      const r = await request(ok.json().id)
      expect(r.filedVia).toEqual({ method: 'email', wallet: null, email: 'me@test.dev' })
    })

    it('needs the new wallet verified on this account, and minted (not just claimed) BEATs of this account on the old one', async () => {
      const unverified = wallet()
      await db.insert(userAuthMethods).values({ userId: me.id, type: 'wallet', identifier: unverified, metadata: { verified: false } })
      await minted()
      expect((await ask({ newWallet: unverified })).json().error).toBe('wallet_not_linked')

      const theirs = wallet()
      await minted({ holder: other, w: theirs })
      expect((await ask({ oldWallet: theirs })).json().error).toBe('no_beats_on_wallet')
      const unsent = wallet()
      const { claim: c } = await minted({ w: unsent })
      await db.update(beatClaims).set({ status: 'claimed' }).where(eq(beatClaims.id, c.id))
      expect((await ask({ oldWallet: unsent })).json().error).toBe('no_beats_on_wallet')

      const res = await ask({ reason: 'y'.repeat(1000), oldWallet: getAddress(oldW), newWallet: getAddress(newW) })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ oldWallet: oldW, newWallet: newW, status: 'pending', reviewNote: null })
      expect((await request(res.json().id)).filedVia).toEqual({ method: 'wallet', wallet: newW, email: null })
    })

    it('allows one open request per account at a time', async () => {
      await minted()
      const first = await ask()
      expect(first.statusCode).toBe(201)
      expect(first.json().beats).toHaveLength(1)
      expect((await ask()).json().error).toBe('request_open')
      expect((await ask()).statusCode).toBe(409)
      await expect(db.insert(beatReissueRequests).values({ userId: me.id, oldWallet: oldW, newWallet: newW, reason: 'x', status: 'approved' })).rejects.toThrow()

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
      await minted({ holder: other, w: otherOld })
      const theirs = (await call('POST', '/api/beats/reissue-requests', other, { oldWallet: otherOld, newWallet: other.wallet, reason: 'stolen' })).json()

      const list = (await call('GET', '/api/beats/reissue-requests')).json()
      expect(list.map((r: any) => r.id)).toEqual([mine.id])
      expect(list[0]).toMatchObject({ status: 'pending', reason: 'My wallet was drained.', beats: [{ chain: 'polygon-amoy', state: null }] })

      expect((await call('DELETE', `/api/beats/reissue-requests/${theirs.id}`)).statusCode).toBe(404)
      expect((await call('DELETE', '/api/beats/reissue-requests/not-a-uuid')).statusCode).toBe(404)
      expect((await request(theirs.id)).status).toBe('pending')

      await call('POST', `/api/admin/beats/reissue-requests/${mine.id}/approve`, admin, {})
      const res = await call('DELETE', `/api/beats/reissue-requests/${mine.id}`)
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_pending'])
    })

    it('lets only a session signed in the same way as the filer cancel, and records the cancel', async () => {
      await minted()
      const id = (await ask()).json().id // filed with the new wallet's session
      for (const claims of [{ wallet: null, am: 'email' }, { wallet: oldW }, { wallet: wallet() }]) {
        const res = await call('DELETE', `/api/beats/reissue-requests/${id}`, me, undefined, claims)
        expect([res.statusCode, res.json().error], JSON.stringify(claims)).toEqual([403, 'cancel_not_allowed'])
      }
      expect((await call('DELETE', `/api/beats/reissue-requests/${id}`)).statusCode).toBe(200)
      expect((await request(id))).toMatchObject({ status: 'cancelled', cancelledVia: { method: 'wallet', wallet: newW } })

      // Filed by email: cancelled by the same email session only
      const byEmail = (await ask({}, me, { wallet: null, am: 'email' })).json().id
      expect((await call('DELETE', `/api/beats/reissue-requests/${byEmail}`)).json().error).toBe('cancel_not_allowed')
      expect((await call('DELETE', `/api/beats/reissue-requests/${byEmail}`, me, undefined, { wallet: null, am: 'email' })).statusCode).toBe(200)
    })

    it('takes only a normal web sign-in session: no API key, pass, trial or signed-out caller', async () => {
      expect((await call('GET', '/api/beats/reissue-requests', null)).statusCode).toBe(401)
      expect((await call('POST', '/api/beats/reissue-requests', null, {})).statusCode).toBe(401)
      const key = (await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${tokenFor(me)}` }, payload: { name: 'k' } })).json().key
      const viaKey = await app.inject({ method: 'GET', url: '/api/beats/reissue-requests', headers: { authorization: `Bearer ${key}` } })
      expect([viaKey.statusCode, viaKey.json().error]).toEqual([403, 'account_required'])
      for (const claims of [{ via: 'studio' }, { via: 'ar', deviceId: '00000000-0000-4000-8000-000000000001' }, { kind: 'scene', sceneId: '00000000-0000-4000-8000-000000000001' }]) {
        const res = await call('GET', '/api/beats/reissue-requests', me, undefined, claims)
        expect([401, 403], JSON.stringify(claims)).toContain(res.statusCode)
      }
    })
  })

  describe('the admin review queue', () => {
    it('shows the account, the wallets and each BEAT with a live chain read and what blocks it', async () => {
      const plain = await minted({ name: 'Plain' })
      await minted({ name: 'Held', tradeable: true })
      const moved = await minted({ name: 'Moved', tradeable: true })
      fake.moveOut(BigInt(moved.tokenId), oldW)
      const replaced = await minted({ name: 'Replaced' })
      expect(fake.reissue(oldW, wallet(), [BigInt(replaced.tokenId)])).toHaveProperty('hash')
      const has = await minted({ name: 'Has' })
      fake.createdBeat(BigInt(has.tokenId), { minted: [oldW, newW] })
      await minted({ name: 'Open', open: true })
      const clash = await minted({ name: 'Clash' })
      await db.insert(beatClaims).values({ beatId: clash.beat.id, wallet: newW, consentVersion: 1, status: 'failed', failReason: 'given_up' })
      const id = (await ask()).json().id

      const [r] = await queue()
      expect(r).toMatchObject({
        id, status: 'pending', oldWallet: oldW, newWallet: newW, reason: 'My wallet was drained.',
        account: { id: me.id, displayName: 'Me', email: 'me@test.dev' }, reviewer: null, filedVia: { method: 'wallet', wallet: newW },
        otherSignIns: { email: true, password: false, oauth: false }, files: [], history: [],
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
      expect(by.Has).toMatchObject({ chainState: { newMinted: true }, blockers: ['AlreadyMinted'] })
      expect(by.Open.blockers).toEqual(['BeatOpen'])
      expect(by.Clash.blockers).toEqual(['ClaimOnNewWallet'])
    })

    it("shows the account's wallet links with who linked them, its request history and the red flags", async () => {
      await minted()
      // The thief, signed in with the old wallet, links their own wallet T, then (signed in with T) cancels and files
      const thief = wallet()
      expect(await linkVerifiedWallet(me.id, thief, { method: 'wallet', wallet: oldW })).toBe('linked')
      const first = (await ask()).json().id
      expect((await call('DELETE', `/api/beats/reissue-requests/${first}`)).statusCode).toBe(200)
      const id = (await ask({ newWallet: thief }, me, { wallet: thief })).json().id

      const [r] = await queue()
      expect(r.id).toBe(id)
      expect(r.flags.sort()).toEqual(['new_wallet_linked_by_old_wallet', 'new_wallet_recent', 'recent_cancel'])
      const links = Object.fromEntries(r.wallets.map((w: any) => [w.wallet, w]))
      expect(links[thief]).toMatchObject({ linked: true, blocked: false, linkedBy: { method: 'wallet', wallet: oldW, how: 'link' } })
      expect(links[newW]).toMatchObject({ linked: true, linkedBy: { method: 'unknown' } })
      expect(links[newW].linkedAt).toEqual(expect.any(String))
      expect(r.history).toEqual([expect.objectContaining({ id: first, status: 'cancelled', filedVia: expect.objectContaining({ wallet: newW }), cancelledVia: expect.objectContaining({ wallet: newW }) })])
      expect(r.filedVia).toMatchObject({ method: 'wallet', wallet: thief })
    })

    it('flags an earlier reissue, and a follow-up from the new wallet of a reissue done in the last 30 days', async () => {
      await minted()
      const id = await approved()
      runFiles(fake, await proposedFiles(id))
      fake.mine(5)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('done')

      const next = wallet()
      await linkVerifiedWallet(me.id, next, { method: 'email', email: 'me@test.dev' })
      const res = await ask({ oldWallet: newW, newWallet: next }, me, { wallet: next })
      expect(res.statusCode).toBe(201)
      const [r] = await queue()
      expect(r.flags).toEqual(expect.arrayContaining(['earlier_reissue', 'follow_up_reissue']))
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
      expect((await call('GET', '/api/admin/beats/reissue-requests?status=all&offset=1', admin)).json()).toEqual([])
      expect((await call('GET', '/api/admin/beats/reissue-requests?offset=-1', admin)).statusCode).toBe(400)
    })

    it('isolates a failed chain read to its own BEAT', async () => {
      const a = await minted()
      const b = await minted()
      await ask()
      fake.failReplacedBy(BigInt(a.tokenId))
      const [r] = await queue()
      const by = Object.fromEntries(r.beats.map((x: any) => [x.tokenId, x]))
      expect(by[String(a.tokenId)].blockers).toEqual(['ChainUnavailable'])
      expect(by[String(b.tokenId)]).toMatchObject({ eligible: true, blockers: [] })
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
      expect(res.json().audit).toEqual([expect.objectContaining({ by: admin.id, action: 'rejected', note: 'We could not confirm it was you.' })])
      const [mine] = (await call('GET', '/api/beats/reissue-requests')).json()
      expect(mine).toMatchObject({ status: 'rejected', reviewNote: 'We could not confirm it was you.' })
      expect(mine.reviewer).toBeUndefined()
      expect(mine.audit).toBeUndefined()
      res = await call('POST', `/api/admin/beats/reissue-requests/${id}/approve`, admin, {})
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_pending'])
      expect((await call('POST', '/api/admin/beats/reissue-requests/00000000-0000-4000-8000-000000000001/approve', admin, {})).statusCode).toBe(404)
    })

    it('re-checks the request at approval: the new wallet still linked, the claims still there', async () => {
      const { claim: c } = await minted()
      const id = (await ask()).json().id
      await db.update(beatClaims).set({ wallet: wallet() }).where(eq(beatClaims.id, c.id))
      let res = await call('POST', `/api/admin/beats/reissue-requests/${id}/approve`, admin, {})
      expect([res.statusCode, res.json().error]).toEqual([409, 'no_beats_on_wallet'])
      await db.update(beatClaims).set({ wallet: oldW }).where(eq(beatClaims.id, c.id))
      await db.delete(userAuthMethods).where(eq(userAuthMethods.identifier, newW))
      res = await call('POST', `/api/admin/beats/reissue-requests/${id}/approve`, admin, {})
      expect([res.statusCode, res.json().error]).toEqual([409, 'wallet_not_linked'])
      expect((await request(id)).status).toBe('pending')
    })

    it('is for site admins only, and dark with the rest of BEAT', async () => {
      await minted()
      const id = (await ask()).json().id
      const routes: Array<['GET' | 'POST', string, unknown?]> = [
        ['GET', '/api/admin/beats/reissue-requests'],
        ['POST', `/api/admin/beats/reissue-requests/${id}/approve`, {}],
        ['POST', `/api/admin/beats/reissue-requests/${id}/reject`, { note: 'x' }],
        ['GET', `/api/admin/beats/reissue-requests/${id}/safe-batch?chain=polygon-amoy`],
        ['POST', `/api/admin/beats/reissue-requests/${id}/propose`, { chain: 'polygon-amoy' }],
        ['GET', `/api/admin/beats/reissue-requests/${id}/files/00000000-0000-4000-8000-000000000001`],
        ['POST', `/api/admin/beats/reissue-requests/${id}/withdraw`, {}],
        ['POST', `/api/admin/beats/reissue-requests/${id}/unlink-wallet`, { wallet: newW }],
      ]
      for (const [m, url, body] of routes) {
        expect((await call(m, url, me, body)).statusCode, `${m} ${url} account`).toBe(403)
        expect((await call(m, url, null, body)).statusCode, `${m} ${url} anon`).toBe(401)
      }
      expect((await request(id)).status).toBe('pending')
      ;(config as any).beats = { ...config.beats, enabled: false }
      for (const [m, url, body] of [...routes, ['GET', '/api/beats/reissue-requests'] as ['GET', string]]) {
        expect((await call(m, url, admin, body)).statusCode, `${m} ${url} dark`).toBe(404)
      }
    })
  })

  describe('blocking the old wallet', () => {
    it('at approval: the old wallet can no longer sign in, link, or use or refresh its sessions; a rejection lifts it', async () => {
      await db.insert(userAuthMethods).values({ userId: me.id, type: 'wallet', identifier: oldW, metadata: { verified: true } })
      await minted()
      const id = (await ask()).json().id
      const oldSession = await call('GET', '/api/beats/reissue-requests', me, undefined, { wallet: oldW })
      expect(oldSession.statusCode).toBe(200)
      expect((await refresh(me, oldW)).statusCode).toBe(200)

      await call('POST', `/api/admin/beats/reissue-requests/${id}/approve`, admin, {})
      const blocked = await call('GET', '/api/beats/reissue-requests', me, undefined, { wallet: oldW })
      expect([blocked.statusCode, blocked.json().error]).toEqual([401, 'wallet_blocked'])
      const r = await refresh(me, oldW)
      expect([r.statusCode, r.json().error]).toEqual([401, 'wallet_blocked'])
      // The new wallet's session is untouched
      expect((await call('GET', '/api/beats/reissue-requests')).statusCode).toBe(200)
      expect((await refresh(me, newW)).statusCode).toBe(200)
      // Nobody can link it
      expect(await db.select().from(walletBlocks)).toEqual([expect.objectContaining({ wallet: oldW, requestId: id, reason: 'reissue', byUserId: admin.id })])
      const [q] = await queue()
      expect(q.wallets.find((w: any) => w.wallet === oldW)).toMatchObject({ linked: true, blocked: true })

      await call('POST', `/api/admin/beats/reissue-requests/${id}/reject`, admin, { note: 'Not you after all.' })
      expect(await db.select().from(walletBlocks)).toEqual([])
      expect((await call('GET', '/api/beats/reissue-requests', me, undefined, { wallet: oldW })).statusCode).toBe(200)
      const events = await db.select().from(accountWalletEvents).where(eq(accountWalletEvents.userId, me.id))
      expect(events.map((e) => e.event)).toEqual(['blocked', 'unblocked'])
    })

    it('a refresh token whose wallet is no longer on the account is refused', async () => {
      const gone = wallet()
      expect((await refresh(me, gone)).json().error).toBe('wallet_unlinked')
      expect((await refresh(me, null)).statusCode).toBe(200)
    })

    it('at done: the old wallet is unlinked from the account and stays blocked', async () => {
      await db.insert(userAuthMethods).values({ userId: me.id, type: 'wallet', identifier: oldW, metadata: { verified: true } })
      await minted()
      const id = await approved()
      runFiles(fake, await proposedFiles(id))
      fake.mine(5)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('done')
      expect(await db.select().from(userAuthMethods).where(eq(userAuthMethods.identifier, oldW))).toEqual([])
      expect((await db.select().from(walletBlocks)).map((b) => b.wallet)).toEqual([oldW])
      const [q] = await queue('done')
      expect(q.wallets.find((w: any) => w.wallet === oldW)).toMatchObject({ linked: false, blocked: true })
      expect(q.walletEvents.map((e: any) => e.event)).toEqual(['blocked', 'unlinked'])
    })

    it('an admin can unlink (and block) another wallet on the account, but not the new wallet of an open request', async () => {
      await minted()
      const backdoor = wallet()
      await linkVerifiedWallet(me.id, backdoor, { method: 'wallet', wallet: oldW })
      const id = (await ask()).json().id
      let res = await call('POST', `/api/admin/beats/reissue-requests/${id}/unlink-wallet`, admin, { wallet: newW })
      expect([res.statusCode, res.json().error]).toEqual([409, 'is_new_wallet'])
      res = await call('POST', `/api/admin/beats/reissue-requests/${id}/unlink-wallet`, admin, { wallet: wallet() })
      expect([res.statusCode, res.json().error]).toEqual([404, 'wallet_not_on_account'])
      res = await call('POST', `/api/admin/beats/reissue-requests/${id}/unlink-wallet`, admin, { wallet: backdoor })
      expect(res.statusCode).toBe(200)
      expect(res.json().wallets.find((w: any) => w.wallet === backdoor)).toMatchObject({ linked: false, blocked: true, linkedBy: { wallet: oldW } })
      expect(res.json().audit).toEqual([expect.objectContaining({ action: 'unlinked_wallet', note: backdoor, by: admin.id })])
      const sess = await call('GET', '/api/beats/reissue-requests', me, undefined, { wallet: backdoor })
      expect(sess.json().error).toBe('wallet_blocked')
      // A later rejection doesn't lift an admin's unlink block
      await call('POST', `/api/admin/beats/reissue-requests/${id}/reject`, admin, { note: 'x' })
      expect((await db.select().from(walletBlocks)).map((b) => b.wallet)).toEqual([backdoor])
    })
  })

  describe('the Safe transaction files', () => {
    const method = {
      inputs: [
        { internalType: 'address', name: 'from', type: 'address' },
        { internalType: 'address', name: 'to', type: 'address' },
        { internalType: 'uint256[]', name: 'ids', type: 'uint256[]' },
      ],
      name: 'reissue', payable: false,
    }

    it('are one Transaction Builder file per Safe transaction: all the non-tradeable ids, then each tradeable id, blocked ids left out', async () => {
      const a = await minted()
      const b = await minted()
      const t1 = await minted({ tradeable: true })
      const t2 = await minted({ tradeable: true })
      const gone = await minted({ tradeable: true })
      fake.moveOut(BigInt(gone.tokenId), oldW)
      const id = await approved()

      const files = await proposedFiles(id)
      expect(files.map((f) => [f.callIndex, f.kind, f.tokenIds, f.status])).toEqual([
        [0, 'plain', [String(a.tokenId), String(b.tokenId)], 'proposed'],
        [1, 'tradeable', [String(t1.tokenId)], 'proposed'],
        [2, 'tradeable', [String(t2.tokenId)], 'proposed'],
      ])
      const tx = (ids: number[]) => ({
        to: getAddress(CONTRACT), value: '0', data: null, contractMethod: method,
        contractInputsValues: { from: getAddress(oldW), to: getAddress(newW), ids: `[${ids.join(',')}]` },
      })
      const expected = [[a.tokenId, b.tokenId], [t1.tokenId], [t2.tokenId]]
      files.forEach((f, i) => {
        expect(f.file).toEqual({
          version: '1.0', chainId: '80002', createdAt: expect.any(Number),
          meta: {
            name: expect.stringMatching(new RegExp(`^Virvi BEAT reissue [0-9a-f]{8} \\(${i + 1} of 3\\)$`)), description: expect.stringContaining('send the non-tradeable file first'),
            createdFromSafeAddress: SAFE, checksum: expect.stringMatching(/^0x[0-9a-f]{64}$/),
          },
          transactions: [tx(expected[i])],
        })
        expect(f.file.meta.checksum).toBe(txBuilderChecksum(f.file))
        expect(f.checksum).toBe(f.file.meta.checksum)
        expect(f.filename).toMatch(new RegExp(`^virvi-beat-reissue-[0-9a-f]{8}-polygon-amoy-${i + 1}\\.json$`))
        for (const v of Object.values(f.file.transactions[0].contractInputsValues)) expect(typeof v).toBe('string')
      })

      const r = await request(id)
      expect(r.status).toBe('proposed')
      expect(r.audit.map((x) => x.action)).toEqual(['approved', 'proposed'])
      const items = await db.select().from(beatReissueItems).where(eq(beatReissueItems.requestId, id))
      const byToken = Object.fromEntries(items.map((i) => [i.tokenId, i]))
      expect([a, b, t1, t2, gone].map((x) => [byToken[x.tokenId].state, byToken[x.tokenId].fileId, byToken[x.tokenId].blockers])).toEqual([
        ['proposed', files[0].id, []], ['proposed', files[0].id, []], ['proposed', files[1].id, []], ['proposed', files[2].id, []], ['skipped', null, ['NothingToReplace']],
      ])
      const [q] = await queue()
      expect(q.files.map((f: any) => [f.id, f.status])).toEqual(files.map((f) => [f.id, 'proposed']))
      expect(q.beats.find((x: any) => x.tokenId === String(t2.tokenId))).toMatchObject({ state: 'proposed', fileId: files[2].id, callIndex: 2 })

      // Each file downloads again exactly as proposed
      const dl = await call('GET', `/api/admin/beats/reissue-requests/${id}/files/${files[1].id}`, admin)
      expect(dl.statusCode).toBe(200)
      expect(dl.headers['content-disposition']).toBe(`attachment; filename="${files[1].filename}"`)
      expect(dl.json()).toEqual(files[1].file)
    })

    it('GET safe-batch is a read-only preview', async () => {
      const a = await minted()
      const id = await approved()
      const res = await call('GET', `/api/admin/beats/reissue-requests/${id}/safe-batch?chain=polygon-amoy`, admin)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ chain: 'polygon-amoy', proposed: [], files: [{ callIndex: 0, kind: 'plain', tokenIds: [String(a.tokenId)] }] })
      expect(res.json().files[0].file.meta.checksum).toBe(txBuilderChecksum(res.json().files[0].file))
      expect((await request(id)).status).toBe('approved')
      expect(await db.select().from(beatReissueItems)).toEqual([])
      expect(await db.select().from(beatReissueFiles)).toEqual([])
    })

    it('splits the non-tradeable ids into files of at most MAX_BATCH (200)', async () => {
      const ids: number[] = []
      for (let i = 0; i < 201; i++) ids.push((await minted()).tokenId)
      const id = await approved()
      const files = await proposedFiles(id)
      expect(files.map((f) => f.tokenIds.length)).toEqual([200, 1])
      expect(files[0].file.transactions[0].contractInputsValues.ids).toBe(`[${ids.slice(0, 200).join(',')}]`)
      expect(files[1].file.transactions[0].contractInputsValues.ids).toBe(`[${ids[200]}]`)
    }, 60_000)

    it('is only for an approved or proposed request, a known chain and a configured contract, re-checked', async () => {
      await minted()
      const pending = (await ask()).json().id
      let res = await propose(pending)
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_approved'])
      await call('POST', `/api/admin/beats/reissue-requests/${pending}/approve`, admin, {})
      res = await propose(pending, 'ethereum')
      expect([res.statusCode, res.json().error]).toEqual([400, 'bad_chain'])
      res = await propose(pending, 'polygon')
      expect([res.statusCode, res.json().error]).toEqual([409, 'no_contract'])
      await db.delete(userAuthMethods).where(eq(userAuthMethods.identifier, newW))
      res = await propose(pending)
      expect([res.statusCode, res.json().error]).toEqual([409, 'wallet_not_linked'])
    })

    it('on Polygon names chain 137 and omits the Safe when none is set', async () => {
      setChain('polygon')
      ;(config as any).beats.adminSafes = {}
      const m = await minted({ chain: 'polygon' })
      const id = await approved()
      const [f] = await proposedFiles(id, 'polygon')
      expect(f.file.chainId).toBe('137')
      expect(f.file.meta.createdFromSafeAddress).toBeUndefined()
      expect(f.file.meta.checksum).toBe(txBuilderChecksum(f.file))
      expect(f.file.transactions[0].contractInputsValues.ids).toBe(`[${m.tokenId}]`)
    })

    it('with nothing left to reissue, refuses and records why', async () => {
      const gone = await minted({ tradeable: true })
      fake.moveOut(BigInt(gone.tokenId), oldW)
      const id = await approved()
      const res = await propose(id)
      expect([res.statusCode, res.json().error]).toEqual([409, 'nothing_to_reissue'])
      expect((await request(id)).status).toBe('approved')
    })
  })

  describe('completion', () => {
    async function proposedRequest() {
      const a = await minted()
      const b = await minted()
      const t1 = await minted({ tradeable: true })
      const id = await approved()
      const files = await proposedFiles(id)
      return { a, b, t1, id, files }
    }

    it('marks every claim reissued and the request done once all land at the confirmation depth (5 on Amoy)', async () => {
      const { a, b, t1, id, files } = await proposedRequest()
      await runBeatTick(now())
      expect((await request(id)).status).toBe('proposed')

      const out = runFiles(fake, files)
      expect(out.every((o: any) => 'hash' in o)).toBe(true)
      // The Safe's transactions are mined one block apart (the fake mines each reissue in its own block): 101, then 102
      fake.mine(3)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('proposed')
      expect((await claim(a.claim.id)).wallet).toBe(oldW)

      fake.mine(1)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('proposed')
      expect((await claim(a.claim.id)).wallet).toBe(newW)
      expect((await claim(t1.claim.id)).wallet).toBe(oldW)
      const fs = await db.select().from(beatReissueFiles).where(eq(beatReissueFiles.requestId, id)).orderBy(beatReissueFiles.callIndex)
      expect(fs.map((f) => f.status)).toEqual(['done', 'proposed'])

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
      expect((await db.select().from(beatReissueFiles)).every((f) => f.status === 'done')).toBe(true)
      const [mine] = (await call('GET', '/api/beats/reissue-requests')).json()
      expect(mine.status).toBe('done')
      expect(mine.beats.map((x: any) => x.state)).toEqual(['reissued', 'reissued', 'reissued'])
    })

    it('waits for 30 confirmations on Polygon', async () => {
      setChain('polygon')
      const a = await minted({ chain: 'polygon' })
      const id = await approved()
      runFiles(fake, await proposedFiles(id, 'polygon'))
      fake.mine(29)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('proposed')
      fake.mine(1)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('done')
      expect((await claim(a.claim.id)).wallet).toBe(newW)
    })

    it('a moved tradeable copy fails only its own file; the request stays proposed, then closes once nothing is left', async () => {
      const { a, b, t1, id, files } = await proposedRequest()
      fake.moveOut(BigInt(t1.tokenId), oldW)
      const out = runFiles(fake, files)
      expect(out[0]).toHaveProperty('hash')
      expect(out[1]).toEqual({ reason: 'NothingToReplace' })
      fake.mine(5)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('proposed')
      expect((await claim(a.claim.id)).wallet).toBe(newW)
      expect((await claim(b.claim.id)).wallet).toBe(newW)
      expect((await claim(t1.claim.id))).toMatchObject({ wallet: oldW, replacedWallet: null, reissuedAt: null })

      const [q] = await queue()
      expect(q.beats.find((x: any) => x.tokenId === String(t1.tokenId))).toMatchObject({ state: 'proposed', blockers: ['NothingToReplace'], eligible: false })
      expect(q.files.map((f: any) => f.status)).toEqual(['done', 'proposed'])

      // The holder buys a copy back: a new file has only that id, and the old one is voided
      fake.createdBeat(BigInt(t1.tokenId), { tradeable: true, minted: [oldW] })
      const again = await proposedFiles(id)
      expect(again.map((f) => f.tokenIds)).toEqual([[String(t1.tokenId)]])
      const statuses = await db.select({ id: beatReissueFiles.id, status: beatReissueFiles.status }).from(beatReissueFiles).where(eq(beatReissueFiles.requestId, id))
      expect(statuses.find((f) => f.id === files[1].id)?.status).toBe('voided')
      expect((await call('GET', `/api/admin/beats/reissue-requests/${id}/files/${files[1].id}`, admin)).json().error).toBe('file_voided')
      // It moves out again: proposing finds nothing to reissue and closes the request
      fake.moveOut(BigInt(t1.tokenId), oldW)
      const res = await propose(id)
      expect([res.statusCode, res.json().error]).toEqual([409, 'nothing_to_reissue'])
      expect((await request(id)).status).toBe('done')
      const [item] = await db.select().from(beatReissueItems).where(and(eq(beatReissueItems.requestId, id), eq(beatReissueItems.tokenId, t1.tokenId)))
      expect(item).toMatchObject({ state: 'skipped', blockers: ['NothingToReplace'] })
    })

    it('keeps ids that landed but are not yet deep enough proposed when proposing again', async () => {
      const { a, t1, id, files } = await proposedRequest()
      runFiles(fake, files)
      let res = await propose(id)
      expect([res.statusCode, res.json().error]).toEqual([409, 'nothing_to_reissue'])
      const items = await db.select().from(beatReissueItems).where(eq(beatReissueItems.requestId, id))
      expect(items.map((i) => i.state)).toEqual(['proposed', 'proposed', 'proposed'])
      expect((await db.select().from(beatReissueFiles)).every((f) => f.status === 'proposed')).toBe(true)
      const [q] = await queue()
      expect(q.beats.find((x: any) => x.tokenId === String(t1.tokenId))).toMatchObject({ landed: true, blockers: ['AlreadyReplaced', 'AlreadyMinted'], state: 'proposed', eligible: false })
      fake.mine(5)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('done')
      expect((await claim(a.claim.id)).wallet).toBe(newW)
      res = await propose(id)
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_approved'])
    })

    it('a clash gets state clash with one admin alert, and the request stays proposed', async () => {
      const { a, id, files } = await proposedRequest()
      await db.insert(beatClaims).values({ beatId: a.beat.id, wallet: newW, consentVersion: 1, status: 'failed', failReason: 'given_up' })
      runFiles(fake, files)
      fake.mine(6)
      await runBeatTick(now())
      await runBeatTick(now())
      const [item] = await db.select().from(beatReissueItems).where(and(eq(beatReissueItems.requestId, id), eq(beatReissueItems.tokenId, a.tokenId)))
      expect(item).toMatchObject({ state: 'clash', blockers: ['ClaimOnNewWallet'] })
      expect((await claim(a.claim.id)).wallet).toBe(oldW)
      expect((await request(id)).status).toBe('proposed')
      expect(vi.mocked(recordJobFailure).mock.calls.filter(([job]) => job === 'beat_reissue')).toHaveLength(1)
      const [q] = await queue()
      expect(q.flags).toContain('clash')
    })

    it('M5: a claim on the old wallet with no item keeps the request open', async () => {
      const { id, files } = await proposedRequest()
      await minted() // minted to the old wallet after the files were proposed
      runFiles(fake, files)
      fake.mine(6)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('proposed')
    })

    it('one failed read skips only its own BEAT', async () => {
      const { a, b, id, files } = await proposedRequest()
      runFiles(fake, files)
      fake.mine(6)
      fake.failReplacedBy(BigInt(a.tokenId))
      await runBeatTick(now())
      expect((await claim(a.claim.id)).wallet).toBe(oldW)
      expect((await claim(b.claim.id)).wallet).toBe(newW)
      fake.failReplacedBy(null)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('done')
    })

    it('counts a reissued claim once, under its new wallet, with a reissued flag for the host', async () => {
      const { a, files, id } = await proposedRequest()
      runFiles(fake, files)
      fake.mine(6)
      await runBeatTick(now())
      expect((await request(id)).status).toBe('done')

      const host = await call('GET', `/api/beats/${a.beat.id}`, admin)
      expect(host.json().counts).toMatchObject({ minted: 1 })
      const claimants = (await call('GET', `/api/beats/${a.beat.id}/claimants`, admin)).json()
      expect(claimants).toHaveLength(1)
      expect(claimants[0]).toMatchObject({ wallet: newW, status: 'minted', reissued: true, reissueTxUrl: expect.stringMatching(/^https:\/\/amoy\.polygonscan\.com\/tx\/0x/) })
    })
  })

  describe('withdrawing', () => {
    it('an admin withdraws a proposed request that has not landed: files voided, the block lifted, the person may file again, the watcher ignores it', async () => {
      const { claim: c, tokenId } = await minted()
      const id = await approved()
      const files = await proposedFiles(id)
      const res = await call('POST', `/api/admin/beats/reissue-requests/${id}/withdraw`, admin, { note: 'This was the thief.' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'withdrawn', files: [{ status: 'voided' }] })
      expect(res.json().audit.at(-1)).toMatchObject({ action: 'withdrawn', by: admin.id, note: 'This was the thief.' })
      expect(await db.select().from(walletBlocks)).toEqual([])
      const [item] = await db.select().from(beatReissueItems).where(eq(beatReissueItems.requestId, id))
      expect(item.state).toBe('withdrawn')
      expect((await ask()).statusCode).toBe(201)

      // The Safe sends the voided file anyway: the watcher ignores it
      runFile(fake, files[0].file)
      fake.mine(6)
      await runBeatTick(now())
      expect((await claim(c.id)).wallet).toBe(oldW)
      expect(tokenId).toBeGreaterThan(0)
    })

    it('one file can be withdrawn alone; with nothing proposed or reissued left, the request goes back to approved', async () => {
      const a = await minted()
      const t = await minted({ tradeable: true })
      const id = await approved()
      const files = await proposedFiles(id)
      let res = await call('POST', `/api/admin/beats/reissue-requests/${id}/withdraw`, admin, { fileId: files[1].id })
      expect(res.statusCode).toBe(200)
      expect(res.json().status).toBe('proposed')
      expect(res.json().files.map((f: any) => f.status)).toEqual(['proposed', 'voided'])
      expect(res.json().beats.find((x: any) => x.tokenId === String(t.tokenId))).toMatchObject({ state: 'skipped' })
      const [ti] = await db.select().from(beatReissueItems).where(and(eq(beatReissueItems.requestId, id), eq(beatReissueItems.tokenId, t.tokenId)))
      expect(ti.blockers).toEqual(['Withdrawn'])
      res = await call('POST', `/api/admin/beats/reissue-requests/${id}/withdraw`, admin, { fileId: files[1].id })
      expect([res.statusCode, res.json().error]).toEqual([409, 'file_not_proposed'])
      res = await call('POST', `/api/admin/beats/reissue-requests/${id}/withdraw`, admin, { fileId: files[0].id })
      expect(res.json().status).toBe('approved')
      expect(a.tokenId).toBeGreaterThan(0)
    })

    it('refuses once a file has landed, and for a request that is not approved or proposed', async () => {
      await minted()
      const id = await approved()
      const files = await proposedFiles(id)
      runFiles(fake, files)
      let res = await call('POST', `/api/admin/beats/reissue-requests/${id}/withdraw`, admin, {})
      expect([res.statusCode, res.json().error]).toEqual([409, 'already_landed'])
      res = await call('POST', `/api/admin/beats/reissue-requests/${id}/withdraw`, admin, { fileId: files[0].id })
      expect([res.statusCode, res.json().error]).toEqual([409, 'already_landed'])
      fake.mine(6)
      await runBeatTick(now())
      res = await call('POST', `/api/admin/beats/reissue-requests/${id}/withdraw`, admin, {})
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_withdrawable'])
    })
  })

  describe('privacy', () => {
    it("delete-my-data deletes the account's closed and pending requests and nulls replaced_wallet on its unlinked claims", async () => {
      const { claim: c } = await minted()
      const id = await approved()
      runFiles(fake, await proposedFiles(id))
      fake.mine(6)
      await runBeatTick(now())
      const otherOld = wallet()
      await minted({ holder: other, w: otherOld })
      await call('POST', '/api/beats/reissue-requests', other, { oldWallet: otherOld, newWallet: other.wallet, reason: 'stolen' })

      await deleteMyBeatData(me.id, now())
      expect((await db.select().from(beatReissueRequests)).map((r) => r.userId)).toEqual([other.id])
      expect(await db.select().from(beatReissueItems)).toEqual([])
      const [row] = await db.select().from(beatClaims).where(eq(beatClaims.id, c.id))
      expect(row).toMatchObject({ userId: null, wallet: newW, replacedWallet: null })
      expect(row.reissuedAt).not.toBeNull()
    })

    it('during a proposed reissue keeps only the wallets, ids and state until it settles, then deletes it', async () => {
      const { claim: c, tokenId } = await minted()
      const id = await approved()
      const files = await proposedFiles(id)
      await deleteMyBeatData(me.id, now())
      const r = await request(id)
      expect(r).toMatchObject({ userId: null, reason: null, reviewNote: null, filedVia: null, oldWallet: oldW, newWallet: newW, status: 'proposed' })
      expect(r.dataDeletedAt).not.toBeNull()
      expect(r.audit.at(-1)).toMatchObject({ action: 'data_deleted', by: null })
      const [q] = await queue()
      expect(q).toMatchObject({ id, account: null, dataDeletedAt: expect.any(String), beats: [{ tokenId: String(tokenId), state: 'proposed' }] })
      // The person may file again (on another account wallet's claims, say): the kept record isn't theirs any more
      expect((await db.select().from(beatReissueRequests).where(eq(beatReissueRequests.userId, me.id)))).toEqual([])

      runFiles(fake, files)
      fake.mine(6)
      await runBeatTick(now())
      expect(await db.select().from(beatReissueRequests)).toEqual([])
      expect(await db.select().from(beatClaims).where(eq(beatClaims.id, c.id))).toEqual([expect.objectContaining({ userId: null, wallet: newW, replacedWallet: null })])
    })

    it('an approved request whose data was deleted can only be withdrawn, and then goes', async () => {
      await minted()
      const id = await approved()
      await deleteMyBeatData(me.id, now())
      const res = await propose(id)
      expect([res.statusCode, res.json().error]).toEqual([409, 'data_deleted'])
      const w = await call('POST', `/api/admin/beats/reissue-requests/${id}/withdraw`, admin, {})
      expect(w.json()).toEqual({ deleted: true })
      expect(await db.select().from(beatReissueRequests)).toEqual([])
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
