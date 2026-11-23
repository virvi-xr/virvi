import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import type { ShowView } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { config } from '../src/config.js'
import { giveawayItems, giveaways, giveawayScenes } from '../src/db/schema.js'
import { TOOLS } from '../src/assistant/tools/index.js'
import { runTool, toolsForModel } from '../src/assistant/tools/run.js'
import type { ToolCtx } from '../src/assistant/tools/types.js'
import { sweepShowWearables } from '../src/assistant/show-wearables.js'
import { RULES } from '../src/assistant/prompt.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { giveawaysOn, type FakeMarketplace } from './helpers/giveaways-fake.js'

const CONTRACT = '0x' + 'c0'.repeat(20)

function ctxFor(app: FastifyInstance, user: TestUser): ToolCtx {
  const request = { headers: { authorization: `Bearer ${tokenFor(user)}` }, ip: '198.51.100.24' } as unknown as FastifyRequest
  return { app, request, user: { id: user.id, email: user.email, role: user.role, orgId: null }, self: { email: user.email, wallets: [] }, walletRefs: [] }
}

describe('assistant: automatic giveaways (LIV-194)', () => {
  let app: FastifyInstance
  let host: TestUser
  let ctx: ToolCtx
  let sceneId: string
  let market: FakeMarketplace
  let off: () => void

  beforeAll(async () => { app = await testApp() })
  afterAll(async () => { await app.close() })
  beforeEach(async () => {
    await resetDb()
    ;({ market, off } = giveawaysOn())
    host = await createUser({ wallet: randomWallet() })
    ctx = ctxFor(app, host)
    sceneId = (await createScene(host, 'Venue')).scene.id
    market.add(host.wallet!, { contractAddress: CONTRACT, itemId: '0', name: 'Prize hat' })
  })
  afterEach(() => off())

  it('is a normal write, with no paid card and no enable, delete or send-back tool', () => {
    expect(TOOLS.create_giveaway.effect).toBe('write')
    expect(TOOLS.create_giveaway.before).toBeTypeOf('function')
    expect(Object.keys(TOOLS).filter((n) => /giveaway/.test(n))).toEqual(['create_giveaway'])
  })

  it('creates a giveaway switched off, with its items and scene, and tells the host the wallet and the Builder step', async () => {
    const r = await runTool(ctx, 'create_giveaway', { name: 'Launch party', sceneId, items: [{ contractAddress: CONTRACT, itemId: '0' }] })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const [g] = await db.select().from(giveaways)
    expect(g).toMatchObject({ name: 'Launch party', enabled: false, ownerId: host.id })
    expect((await db.select().from(giveawayItems).where(eq(giveawayItems.giveawayId, g.id))).map((i) => [i.contractAddress?.toLowerCase(), i.itemId])).toEqual([[CONTRACT, '0']])
    expect((await db.select().from(giveawayScenes).where(eq(giveawayScenes.giveawayId, g.id))).map((s) => s.sceneId)).toEqual([sceneId])
    if (!r.ok) return
    const text = JSON.stringify(r.summary)
    expect(text).toContain(g.walletAddress)
    expect(text).toContain('Add it as a minter on your collection in the Builder, then switch the giveaway on in Drops.')
    expect(r.undo).toBeNull()
  })

  it('works without items, and never switches anything on', async () => {
    const r = await runTool(ctx, 'create_giveaway', { name: 'No items yet', sceneId })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const [g] = await db.select().from(giveaways)
    expect(g.enabled).toBe(false)
    expect(await db.select().from(giveawayItems)).toHaveLength(0)
  })

  it("refuses a scene the user can't run events in, and an item that isn't theirs, with the route's words", async () => {
    const other = await createUser({ wallet: randomWallet() })
    const theirs = (await createScene(other, 'Theirs')).scene.id
    const a = await runTool(ctx, 'create_giveaway', { name: 'Nope', sceneId: theirs })
    expect(a.ok).toBe(false)
    const b = await runTool(ctx, 'create_giveaway', { name: 'Nope', sceneId, items: [{ contractAddress: '0x' + 'd0'.repeat(20), itemId: '3' }] })
    expect(b).toMatchObject({ ok: false, status: 400 })
    expect(await db.select().from(giveaways)).toHaveLength(0)
  })

  it('is not offered while giveaways are off', () => {
    expect(toolsForModel().map((t) => t.name)).toContain('create_giveaway')
    off()
    expect(toolsForModel().map((t) => t.name)).not.toContain('create_giveaway')
  })

  describe("the show's wearable step", () => {
    const WALLET = '0x' + 'cd'.repeat(20)
    const prev = { enabled: config.assistantEnabled, audience: config.assistantAudience, studio: config.studioEnabled }
    const set = (k: string, v: unknown) => { ;(config as any)[k] = v }
    let owner: TestUser
    beforeEach(() => {
      set('assistantEnabled', true); set('assistantAudience', 'paid'); set('studioEnabled', true)
    })
    afterEach(() => { set('assistantEnabled', prev.enabled); set('assistantAudience', prev.audience); set('studioEnabled', prev.studio) })

    const noteWith = async () => {
      owner = await createUser({ wallet: WALLET })
      const headers = { authorization: `Bearer ${tokenFor(owner)}` }
      const made = await app.inject({ method: 'POST', url: '/api/assistant/shows', headers, payload: { title: 'Launch', items: [{ kind: 'wearable_published', label: 'Publish the cap' }] } })
      const find = async () => [{ contract: CONTRACT, itemId: '0', name: 'Neon Cap', createdAt: new Date(Date.now() + 60_000), reviewedAt: new Date() }]
      await sweepShowWearables(find)
      const view = (await app.inject({ method: 'GET', url: `/api/assistant/shows/${made.json().id}`, headers })).json() as ShowView
      return view.items[0].note
    }

    it('offers an automatic giveaway first, then the raffle, when giveaways are on', async () => {
      const note = await noteWith()
      expect(note).toContain('Found on Decentraland: "Neon Cap"')
      expect(note).toMatch(/automatic giveaway.*raffle/i)
      expect(note!.indexOf('automatic giveaway')).toBeLessThan(note!.indexOf('raffle'))
    })

    it('offers only the raffle when giveaways are off', async () => {
      off()
      const note = await noteWith()
      expect(note).toBe('Found on Decentraland: "Neon Cap". If it isn\'t the one, paste the right Marketplace link.')
    })

    it('the rules tell the assistant to prefill the found item', () => {
      expect(RULES).toMatch(/create_giveaway/)
    })
  })
})
