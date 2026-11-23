import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import type { ShowView } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { assistantShows } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { itemKey, marketplaceFind, pickWearable, sweepShowWearables, type MarketItem } from '../src/assistant/show-wearables.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign } from './helpers/studio.js'

const MIN = 60_000
const C1 = '0x' + '11'.repeat(20)
const C2 = '0x' + '22'.repeat(20)
const item = (o: Partial<MarketItem> & { name: string }): MarketItem => ({ contract: C1, itemId: '0', createdAt: new Date(), reviewedAt: new Date(), ...o })

describe('pickWearable', () => {
  const since = new Date('2031-01-01T00:00:00Z')
  const after = new Date('2031-01-02T00:00:00Z')
  const before = new Date('2030-12-31T00:00:00Z')

  it('takes the one named like the design, whatever the case and spacing', () => {
    const items = [item({ name: 'Other hat', createdAt: after }), item({ name: '  neon   CAP ', itemId: '1', createdAt: after })]
    expect(pickWearable(items, since, 'Neon cap')?.itemId).toBe('1')
  })
  it('with no design, takes the only new one; with a design, only one named like it', () => {
    expect(pickWearable([item({ name: 'Something', createdAt: after })], since, null)?.name).toBe('Something')
    expect(pickWearable([item({ name: 'Something', createdAt: after })], since, 'Neon cap')).toBeNull()
  })
  it('skips items the user cleared or another show has', () => {
    const one = item({ name: 'Neon cap', createdAt: after })
    expect(pickWearable([one], since, 'Neon cap', new Set([`${C1}:0`]))).toBeNull()
  })
  it('ignores ones made before the show and ones not approved', () => {
    expect(pickWearable([item({ name: 'Neon cap', createdAt: before })], since, 'Neon cap')).toBeNull()
    expect(pickWearable([item({ name: 'Neon cap', createdAt: after, reviewedAt: null })], since, 'Neon cap')).toBeNull()
  })
  it('leaves it to the user when several could be it', () => {
    expect(pickWearable([item({ name: 'A', createdAt: after }), item({ name: 'B', itemId: '1', createdAt: after })], since, null)).toBeNull()
    expect(pickWearable([item({ name: 'Neon cap', createdAt: after }), item({ name: 'Neon cap', itemId: '1', createdAt: after })], since, 'Neon cap')).toBeNull()
  })
})

describe('marketplaceFind', () => {
  it('asks for wearables by every wallet, keeps well-formed rows and cleans names', async () => {
    let asked = ''
    const fake = (async (url: string) => {
      asked = url
      return new Response(JSON.stringify({ data: [
        { contractAddress: C1.toUpperCase().replace('0X', '0x'), itemId: '3', name: 'Neon\u0000 cap\n', category: 'wearable', createdAt: '1794361762', reviewedAt: '1794449898' },
        { contractAddress: 'nope', itemId: '1', name: 'Bad', category: 'wearable', createdAt: '1794361762', reviewedAt: '0' },
        { contractAddress: C2, itemId: '1', name: 'Dance', category: 'emote', createdAt: '1794361762', reviewedAt: '1794449898' },
        { contractAddress: C2, itemId: '2', name: 'Pending', category: 'wearable', createdAt: '1794361762', reviewedAt: '0' },
      ] }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await marketplaceFind(fake)(['0xAAAA' + 'a'.repeat(36), '0x' + 'b'.repeat(40)])
    expect(asked.startsWith(`${config.dclMarketplaceApiUrl}/v1/items?`)).toBe(true)
    const q = new URL(asked).searchParams
    expect(q.getAll('creator')).toEqual(['0x' + 'a'.repeat(40), '0x' + 'b'.repeat(40)])
    expect(q.get('category')).toBe('wearable')
    expect(out).toEqual([
      { contract: C1, itemId: '3', name: 'Neon cap', createdAt: new Date(1794361762000), reviewedAt: new Date(1794449898000) },
      { contract: C2, itemId: '2', name: 'Pending', createdAt: new Date(1794361762000), reviewedAt: null },
    ])
  })
  it('throws when the Marketplace refuses', async () => {
    const fake = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch
    await expect(marketplaceFind(fake)(['0x' + 'a'.repeat(40)])).rejects.toThrow('Marketplace answered 503')
  })
})

describe('sweepShowWearables', () => {
  let app: FastifyInstance
  let owner: TestUser
  const prev = { enabled: config.assistantEnabled, audience: config.assistantAudience, studio: config.studioEnabled }
  const set = (k: string, v: unknown) => { ;(config as any)[k] = v }
  const WALLET = '0x' + 'cd'.repeat(20)

  beforeAll(async () => { app = await testApp() })
  afterAll(async () => { await app.close() })
  beforeEach(async () => {
    await resetDb()
    set('assistantEnabled', true); set('assistantAudience', 'paid'); set('studioEnabled', true)
    owner = await createUser({ wallet: WALLET })
  })
  afterEach(() => { set('assistantEnabled', prev.enabled); set('assistantAudience', prev.audience); set('studioEnabled', prev.studio) })

  const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(owner)}` }, ...(payload === undefined ? {} : { payload: payload as any }) })
    return { status: res.statusCode, json: res.body ? res.json() : null }
  }
  const newShow = async (): Promise<ShowView> => {
    const r = await call('POST', '/api/assistant/shows', { title: 'Launch', items: [{ kind: 'wearable_design', label: 'Design the cap' }, { kind: 'wearable_published', label: 'Publish the cap' }] })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    return r.json
  }
  const published = (s: ShowView) => s.items.find((i) => i.kind === 'wearable_published')!
  const later = (name: string, itemId = '0') => item({ name, itemId, createdAt: new Date(Date.now() + MIN) })

  it("fills in the show's wearable named like its design, and the checklist says what was found", async () => {
    const s = await newShow()
    const design = await createDesign(owner, { name: 'Neon cap' })
    expect((await call('PATCH', `/api/assistant/shows/${s.id}/items/${s.items[0].id}`, { ref: { designId: design.id } })).status).toBe(200)
    let asked: string[] = []
    const find = async (w: string[]) => { asked = w; return [later('Other hat', '1'), later('Neon Cap', '2')] }
    expect(await sweepShowWearables(find)).toEqual({ checked: 1, found: 1 })
    expect(asked).toEqual([WALLET])
    const view = (await call('GET', `/api/assistant/shows/${s.id}`)).json as ShowView
    expect(published(view)).toMatchObject({
      state: 'done',
      note: 'Found on Decentraland: "Neon Cap". If it isn\'t the one, paste the right Marketplace link.',
      wearable: { contract: C1, itemId: '2', url: `https://decentraland.org/marketplace/contracts/${C1}/items/2`, found: { name: 'Neon Cap' } },
    })
    // Already filled: not looked up again
    expect(await sweepShowWearables(async () => { throw new Error('asked again') })).toEqual({ checked: 0, found: 0 })
  })

  it('a pasted link replaces what was found', async () => {
    const s = await newShow()
    await sweepShowWearables(async () => [later('Only one')])
    const url = `https://decentraland.org/marketplace/contracts/${C2}/items/7`
    expect((await call('PATCH', `/api/assistant/shows/${s.id}/items/${published(s).id}`, { wearable: url })).status).toBe(200)
    const view = (await call('GET', `/api/assistant/shows/${s.id}`)).json as ShowView
    expect(published(view)).toMatchObject({ state: 'done', note: null, wearable: { contract: C2, itemId: '7', url } })
    expect(published(view).wearable).not.toHaveProperty('found')
  })

  it('leaves the show waiting when several could be it, the lookup fails, or the user has no verified wallet', async () => {
    const s = await newShow()
    expect(await sweepShowWearables(async () => [later('A', '1'), later('B', '2')])).toEqual({ checked: 1, found: 0 })
    expect(await sweepShowWearables(async () => { throw new Error('down') })).toEqual({ checked: 1, found: 0 })
    const [row] = await db.select().from(assistantShows).where(eq(assistantShows.id, s.id))
    expect(row.items.find((i) => i.kind === 'wearable_published')!.wearable).toBeUndefined()

    owner = await createUser()
    await newShow()
    let asks = 0
    await sweepShowWearables(async () => { asks++; return [] })
    expect(asks).toBe(1)
  })

  it('a wearable cleared from the show is never found again, and one wearable fills only one show', async () => {
    const a = await newShow()
    const b = await newShow()
    expect(await sweepShowWearables(async () => [later('Only one')])).toEqual({ checked: 2, found: 1 })
    const rows = await db.select().from(assistantShows)
    const withIt = rows.filter((r) => r.items.some((i) => i.kind === 'wearable_published' && i.wearable))
    expect(withIt).toHaveLength(1)
    // The user says it's the wrong one: cleared, and remembered
    const s = withIt[0]
    const it = s.items.find((i) => i.kind === 'wearable_published')!
    expect((await call('PATCH', `/api/assistant/shows/${s.id}/items/${it.id}`, { wearable: null })).status).toBe(200)
    const [after] = await db.select().from(assistantShows).where(eq(assistantShows.id, s.id))
    expect(after.items.find((i) => i.id === it.id)!.dismissed).toEqual([itemKey({ contract: C1, itemId: '0' })])
    // Next sweep: the other show takes it, this one doesn't get it back
    await sweepShowWearables(async () => [later('Only one')])
    const [again] = await db.select().from(assistantShows).where(eq(assistantShows.id, s.id))
    expect(again.items.find((i) => i.id === it.id)!.wearable).toBeUndefined()
  })

  it('a show with a design waits for one named like it, and a design that is gone names nothing', async () => {
    const s = await newShow()
    const design = await createDesign(owner, { name: 'Neon cap' })
    await call('PATCH', `/api/assistant/shows/${s.id}/items/${s.items[0].id}`, { ref: { designId: design.id } })
    expect(await sweepShowWearables(async () => [later('Star boots')])).toEqual({ checked: 1, found: 0 })
  })

  it('shows already filled never crowd out one still waiting', async () => {
    for (let i = 0; i < 3; i++) await newShow()
    await sweepShowWearables(async () => [later('First')])
    await sweepShowWearables(async () => [later('Second', '1')])
    await sweepShowWearables(async () => [later('Third', '2')])
    const waiting = await newShow()
    await db.update(assistantShows).set({ updatedAt: new Date(Date.now() + 60 * MIN) }).where(eq(assistantShows.id, waiting.id))
    expect(await sweepShowWearables(async () => [later('Fourth', '3')])).toEqual({ checked: 1, found: 1 })
  })

  it("leaves closed shows, old shows and a wearable made before the show alone", async () => {
    const closed = await newShow()
    await call('POST', `/api/assistant/shows/${closed.id}/close`)
    const old = await newShow()
    await db.update(assistantShows).set({ createdAt: new Date(Date.now() - 91 * 86_400_000) }).where(eq(assistantShows.id, old.id))
    const fresh = await newShow()
    expect(await sweepShowWearables(async () => [item({ name: 'Earlier', createdAt: new Date(Date.now() - 60 * MIN) })])).toEqual({ checked: 1, found: 0 })
    const rows = await db.select().from(assistantShows)
    for (const r of rows) expect(r.items.find((i) => i.kind === 'wearable_published')!.wearable).toBeUndefined()
    expect(rows.map((r) => r.id)).toContain(fresh.id)
  })
})
