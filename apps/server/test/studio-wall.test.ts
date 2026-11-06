import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getAddress } from 'ethers'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioRenders, userAuthMethods } from '../src/db/schema.js'
import { resolveVerifiedWalletUser, linkVerifiedWallet } from '../src/auth/wallet-users.js'
import { config } from '../src/config.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { _resetWallNamesCache } from '../src/studio/wall.js'
import { verifyRenderFrame } from '../src/studio/render-urls.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign, entitle } from './helpers/studio.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

const S = '/api/studio'
const WALLET = '0x01d8a0f0c2a1b4e5d6f708192a3b4c5d6e7fb38b'
const MARKET = 'https://decentraland.org/marketplace/contracts/0xabc/items/1'

describe('studio wall of fame', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let dir: FakeDclDirectory
  const prev = config.studioEnabled
  beforeAll(() => { ;(config as any).studioEnabled = true })
  afterAll(() => { ;(config as any).studioEnabled = prev; setDclDirectory(null) })
  beforeEach(async () => {
    await resetDb()
    _resetWallNamesCache()
    dir = new FakeDclDirectory()
    setDclDirectory(dir)
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const studioPass = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u, { kind: 'scene', via: 'studio', sceneId: null, locationId: null })}` })
  const put = (u: TestUser, id: string, body: Record<string, unknown>, headers = as(u)) =>
    app.inject({ method: 'PUT', url: `${S}/designs/${id}/wall`, headers, payload: body as any })
  const wall = (q = '') => app.inject({ method: 'GET', url: `${S}/wall${q}` })

  /** Marks a revision's view ready with `frames` frames. */
  const ready = (rev: { id: string; jobId: string }, viewKey: string, frames: number, status = 'ready') =>
    db.insert(studioRenders).values({ revisionId: rev.id, viewKey, jobId: rev.jobId, frames, status })

  /** A finalized design with a ready spin view, shown on the wall. */
  async function shown(u: TestUser, opts: { name?: string; kind?: string; category?: string; view?: string; frames?: number; at?: Date } = {}) {
    const kind = opts.kind ?? 'wearable'
    const d = await createDesign(u, { name: opts.name ?? 'Neon cap', kind })
    const rev = await addRevision(d, opts.category ?? (kind === 'emote' ? 'emote' : kind === 'scene' ? 'building' : 'hat'))
    await entitle(d, rev)
    await ready(rev, opts.view ?? (kind === 'emote' ? 'emote-male-default' : kind === 'scene' ? 'orbit-scene' : 'spin-male-default'), opts.frames ?? 36)
    await db.update(studioDesigns).set({ wallShownAt: opts.at ?? new Date() }).where(eq(studioDesigns.id, d.id))
    return { d, rev }
  }

  it('refuses to show a design that is not finalized', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    const res = await put(u, d.id, { shown: true })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'not_finalized' })
  })

  it('shows a finalized design, and the design detail says so', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await entitle(d, await addRevision(d, 'hat'))
    const res = await put(u, d.id, { shown: true })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ shown: true, hidden: false, marketplaceUrl: null })
    const detail = await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(u) })
    expect(detail.json().wall).toEqual({ shown: true, hidden: false, marketplaceUrl: null })
    expect((await put(u, d.id, { shown: false })).json()).toEqual({ shown: false, hidden: false, marketplaceUrl: null })
  })

  it('keeps a Decentraland marketplace link, refuses anything else, and null clears it', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await entitle(d, await addRevision(d, 'hat'))
    expect((await put(u, d.id, { shown: true, marketplaceUrl: MARKET })).json().marketplaceUrl).toBe(MARKET)
    for (const bad of ['http://evil.example', 'javascript:x', 'https://decentraland.org/' + 'a'.repeat(290), 'https://decentraland.org/a b']) {
      const res = await put(u, d.id, { shown: true, marketplaceUrl: bad })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'bad_marketplace_url' })
    }
    expect((await put(u, d.id, { shown: true })).json().marketplaceUrl).toBe(MARKET)
    expect((await put(u, d.id, { shown: true, marketplaceUrl: null })).json().marketplaceUrl).toBeNull()
  })

  it('works with the studio pass, and only for the owner', async () => {
    const u = await createUser()
    const other = await createUser()
    const d = await createDesign(u)
    await entitle(d, await addRevision(d, 'hat'))
    expect((await put(u, d.id, { shown: true }, studioPass(u))).statusCode).toBe(200)
    expect((await put(other, d.id, { shown: true })).statusCode).toBe(404)
    expect((await put(other, d.id, { shown: true }, studioPass(other))).statusCode).toBe(404)
    expect((await put(u, d.id, { shown: 'yes' })).statusCode).toBe(400)
  })

  it('lists entries publicly with signed frames and nothing private', async () => {
    const u = await createUser({ email: 'secret-owner@example.com' })
    const { d } = await shown(u)
    const res = await wall()
    expect(res.statusCode).toBe(200)
    const { entries } = res.json()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ designId: d.id, name: 'Neon cap', kind: 'wearable', creator: 'A Virvi creator', marketplaceUrl: null })
    expect(entries[0].frames).toHaveLength(12)
    for (const f of entries[0].frames) expect(f.startsWith(`${config.publicUrl}/api/studio/render-frames/`)).toBe(true)
    expect(res.body).not.toContain(u.id)
    expect(res.body).not.toContain('ownerId')
    expect(res.body).not.toContain('secret-owner@example.com')
  })

  it('orders newest shown first and pages with a clamped limit', async () => {
    const u = await createUser()
    for (let i = 0; i < 3; i++) await shown(u, { name: `Design ${i}`, at: new Date(Date.UTC(2026, 0, 1 + i)) })
    const names = async (q: string) => (await wall(q)).json().entries.map((e: any) => e.name)
    expect(await names('')).toEqual(['Design 2', 'Design 1', 'Design 0'])
    expect(await names('?limit=2&offset=1')).toEqual(['Design 1', 'Design 0'])
    expect(await names('?limit=0')).toEqual(['Design 2'])
    expect(await names('?limit=999')).toHaveLength(3)
    expect(await names('?limit=abc&offset=-4')).toHaveLength(3)
  })

  it('leaves out opted-out, hidden and unrendered designs', async () => {
    const u = await createUser()
    await shown(u, { name: 'Visible' })
    const out = await shown(u, { name: 'Opted out' })
    await db.update(studioDesigns).set({ wallShownAt: null }).where(eq(studioDesigns.id, out.d.id))
    const hidden = await shown(u, { name: 'Hidden' })
    await db.update(studioDesigns).set({ wallHiddenAt: new Date() }).where(eq(studioDesigns.id, hidden.d.id))
    const d = await createDesign(u, { name: 'Unrendered' })
    const rev = await addRevision(d, 'hat')
    await entitle(d, rev)
    await ready(rev, 'spin-male-default', 36, 'queued')
    await db.update(studioDesigns).set({ wallShownAt: new Date() }).where(eq(studioDesigns.id, d.id))
    expect((await wall()).json().entries.map((e: any) => e.name)).toEqual(['Visible'])
  })

  it('takes frames from the newest ready entitlement, not a newer unpaid revision', async () => {
    const u = await createUser()
    const { d, rev } = await shown(u)
    const newer = await addRevision(d, 'hat')
    await ready(newer, 'spin-male-default', 36)
    const { entries } = (await wall()).json()
    const tokens = entries[0].frames.map((f: string) => f.split('/render-frames/')[1])
    for (const t of tokens) expect(verifyRenderFrame(t, new Date())?.revisionId).toBe(rev.id)
    // once the newer revision is paid for, it takes over
    await entitle(d, newer, { paidAt: new Date(Date.now() + 1000) })
    const after = (await wall()).json().entries[0].frames.map((f: string) => f.split('/render-frames/')[1])
    for (const t of after) expect(verifyRenderFrame(t, new Date())?.revisionId).toBe(newer.id)
  })

  it('picks the view per kind and spaces the 12 frames evenly', async () => {
    const u = await createUser()
    await shown(u, { name: 'Hat', frames: 36, at: new Date(Date.UTC(2026, 0, 1)) })
    await shown(u, { name: 'Dance', kind: 'emote', frames: 30, at: new Date(Date.UTC(2026, 0, 2)) })
    await shown(u, { name: 'Sofa', kind: 'scene', frames: 122, at: new Date(Date.UTC(2026, 0, 3)) })
    const { entries } = (await wall()).json()
    const by = (name: string) => entries.find((e: any) => e.name === name)
    const decode = (e: any) => e.frames.map((f: string) => verifyRenderFrame(f.split('/render-frames/')[1], new Date())!)
    const hat = decode(by('Hat'))
    expect(hat.map((f: any) => f.viewKey)).toEqual(Array(12).fill('spin-male-default'))
    expect(hat.map((f: any) => f.frame)).toEqual(Array.from({ length: 12 }, (_, i) => Math.floor(i * 36 / 12)))
    const dance = decode(by('Dance'))
    expect(dance[0].viewKey).toBe('emote-male-default')
    expect(dance.map((f: any) => f.frame)).toEqual(Array.from({ length: 12 }, (_, i) => Math.floor(i * 30 / 12)))
    const sofa = decode(by('Sofa'))
    expect(sofa[0].viewKey).toBe('orbit-scene')
    expect(sofa.map((f: any) => f.frame)).toEqual(Array.from({ length: 12 }, (_, i) => Math.floor(i * 24 / 12)))
  })

  it('names the creator by DCL name, short wallet or a plain label', async () => {
    const named = await createUser({ wallet: '0x1111111111111111111111111111111111111111' })
    const bare = await createUser({ wallet: WALLET })
    const none = await createUser()
    dir.ownedNames.set('0x1111111111111111111111111111111111111111', ['virvi.dcl.eth'])
    await shown(named, { name: 'A', at: new Date(Date.UTC(2026, 0, 1)) })
    await shown(bare, { name: 'B', at: new Date(Date.UTC(2026, 0, 2)) })
    await shown(none, { name: 'C', at: new Date(Date.UTC(2026, 0, 3)) })
    const { entries } = (await wall()).json()
    const creator = (n: string) => entries.find((e: any) => e.name === n).creator
    expect(creator('A')).toBe('virvi')
    const checksummed = getAddress(WALLET)
    expect(creator('B')).toBe(`${checksummed.slice(0, 6)}…${checksummed.slice(-4)}`)
    expect(creator('C')).toBe('A Virvi creator')
  })

  describe('an owner with several wallets', () => {
    const OLD = '0x2222222222222222222222222222222222222222'
    const short = (w: string) => { const c = getAddress(w); return `${c.slice(0, 6)}…${c.slice(-4)}` }
    async function twoWallets() {
      const u = await createUser({ wallet: OLD })
      await db.update(userAuthMethods).set({ createdAt: new Date(Date.UTC(2025, 0, 1)), updatedAt: new Date(Date.UTC(2025, 0, 1)) }).where(eq(userAuthMethods.identifier, OLD))
      expect(await linkVerifiedWallet(u.id, WALLET)).toBe('linked')
      return u
    }

    it("names the wallet the owner last signed in with, never another wallet's DCL name", async () => {
      const u = await twoWallets()
      dir.ownedNames.set(OLD, ['someone-else.dcl.eth'])
      await shown(u)
      expect((await wall()).json().entries[0].creator).toBe(short(WALLET))
    })

    it("uses the last-used wallet's DCL name when it has one", async () => {
      const u = await twoWallets()
      dir.ownedNames.set(OLD, ['old.dcl.eth'])
      dir.ownedNames.set(WALLET, ['mine.dcl.eth'])
      await shown(u)
      expect((await wall()).json().entries[0].creator).toBe('mine')
    })

    it('signing in with an older wallet makes it the one the wall names', async () => {
      const u = await twoWallets()
      dir.ownedNames.set(OLD, ['old.dcl.eth'])
      expect((await resolveVerifiedWalletUser(OLD, 'x', 'visitor')).id).toBe(u.id)
      await shown(u)
      expect((await wall()).json().entries[0].creator).toBe('old')
    })

    it('with no verified wallet, falls back to any linked wallet', async () => {
      const u = await createUser()
      await db.insert(userAuthMethods).values({ userId: u.id, type: 'wallet', identifier: OLD, metadata: { verified: false } })
      dir.ownedNames.set(OLD, ['legacy.dcl.eth'])
      await shown(u)
      expect((await wall()).json().entries[0].creator).toBe('legacy')
    })
  })

  it('falls back to the short wallet when the directory is down', async () => {
    const u = await createUser({ wallet: WALLET })
    dir.down = true
    await shown(u)
    const c = getAddress(WALLET)
    expect((await wall()).json().entries[0].creator).toBe(`${c.slice(0, 6)}…${c.slice(-4)}`)
  })

  describe('admin hide', () => {
    const A = '/api/admin/studio/wall'
    const adminReq = (u: TestUser, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, headers = as(u)) =>
      app.inject({ method, url, headers, payload: payload as any })

    it('lists every shown entry for an admin, hidden ones included, with the owner email', async () => {
      const admin = await createUser({ role: 'admin' })
      const u = await createUser({ email: 'owner@example.com' })
      await shown(u, { name: 'Visible', at: new Date(Date.UTC(2026, 0, 2)) })
      const h = await shown(u, { name: 'Hidden', at: new Date(Date.UTC(2026, 0, 1)) })
      await db.update(studioDesigns).set({ wallHiddenAt: new Date() }).where(eq(studioDesigns.id, h.d.id))
      const opted = await shown(u, { name: 'Opted out' })
      await db.update(studioDesigns).set({ wallShownAt: null }).where(eq(studioDesigns.id, opted.d.id))
      const res = await adminReq(admin, 'GET', A)
      expect(res.statusCode).toBe(200)
      const { entries } = res.json()
      expect(entries.map((e: any) => [e.name, e.hidden, e.ownerEmail])).toEqual([
        ['Visible', false, 'owner@example.com'], ['Hidden', true, 'owner@example.com'],
      ])
      expect(entries[0].frames).toHaveLength(12)
    })

    it('hiding removes an entry from the public wall and unhiding restores it', async () => {
      const admin = await createUser({ role: 'admin' })
      const u = await createUser()
      const { d } = await shown(u)
      expect((await adminReq(admin, 'POST', `${A}/${d.id}/hide`, { hidden: true })).json()).toEqual({ hidden: true })
      expect((await wall()).json().entries).toEqual([])
      expect((await adminReq(admin, 'POST', `${A}/${d.id}/hide`, { hidden: false })).json()).toEqual({ hidden: false })
      expect((await wall()).json().entries).toHaveLength(1)
    })

    it('rejects a bad body or an unknown design', async () => {
      const admin = await createUser({ role: 'admin' })
      const u = await createUser()
      const { d } = await shown(u)
      expect((await adminReq(admin, 'POST', `${A}/${d.id}/hide`, { hidden: 'yes' })).statusCode).toBe(400)
      expect((await adminReq(admin, 'POST', `${A}/00000000-0000-4000-8000-000000000000/hide`, { hidden: true })).statusCode).toBe(404)
      expect((await adminReq(admin, 'POST', `${A}/nope/hide`, { hidden: true })).statusCode).toBe(404)
    })

    it('refuses a non-admin', async () => {
      const u = await createUser()
      const { d } = await shown(u)
      expect((await adminReq(u, 'GET', A)).statusCode).toBe(403)
      expect((await adminReq(u, 'POST', `${A}/${d.id}/hide`, { hidden: true })).statusCode).toBe(403)
    })

    it('refuses the studio pass, even an admin\'s', async () => {
      const admin = await createUser({ role: 'admin' })
      const u = await createUser()
      const { d } = await shown(u)
      const get = await adminReq(admin, 'GET', A, undefined, studioPass(admin))
      expect(get.statusCode).toBe(403)
      expect(get.json().error).toBe('studio_pass_not_allowed')
      const post = await adminReq(admin, 'POST', `${A}/${d.id}/hide`, { hidden: true }, studioPass(admin))
      expect(post.statusCode).toBe(403)
      expect(post.json().error).toBe('studio_pass_not_allowed')
    })

    it('an owner opting out and back in does not clear an admin hide', async () => {
      const admin = await createUser({ role: 'admin' })
      const u = await createUser()
      const { d } = await shown(u)
      await adminReq(admin, 'POST', `${A}/${d.id}/hide`, { hidden: true })
      await put(u, d.id, { shown: false })
      const back = await put(u, d.id, { shown: true })
      expect(back.json()).toMatchObject({ shown: true, hidden: true })
      expect((await wall()).json().entries).toEqual([])
    })
  })
})
