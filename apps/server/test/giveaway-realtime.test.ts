import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { giveawayItems, giveaways, giveawayScenes } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

const H = 3_600_000
const at = (ms: number) => new Date(Date.now() + ms)

describe('giveaway_available on join (LIV-194)', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  const prev = config.giveaways
  beforeEach(async () => {
    await resetDb()
    ;(config as any).giveaways = { ...config.giveaways, enabled: true }
    gs = await startGameServer()
  })
  afterEach(async () => {
    ;(config as any).giveaways = prev
    await gs.stop()
  })

  async function setup(over: Partial<typeof giveaways.$inferInsert> = {}) {
    const host = await createUser({ wallet: randomWallet() })
    const sceneId = (await createScene(host)).scene.id
    const [g] = await db.insert(giveaways).values({
      ownerId: host.id, name: 'Launch party', enabled: true, startsAt: at(-H), endsAt: at(H), ...over,
    }).returning()
    await db.insert(giveawayItems).values({ giveawayId: g.id, contractAddress: '0x' + 'c0'.repeat(20), itemId: '0', name: 'Hat', mintState: 'ready', remaining: 10 })
    await db.insert(giveawayScenes).values({ giveawayId: g.id, sceneId })
    return sceneId
  }

  it("tells a joining client the scene's open giveaway: its name and test flag only", async () => {
    const c = await joinScene(gs.url, await setup())
    expect(await c.waitFor('giveaway_available')).toEqual({ giveaway: { name: 'Launch party', test: false } })
  })

  it('null when the giveaway is not open', async () => {
    const c = await joinScene(gs.url, await setup({ enabled: false }))
    expect(await c.waitFor('giveaway_available')).toEqual({ giveaway: null })
  })

  it('sends nothing when giveaways are off', async () => {
    ;(config as any).giveaways = { ...config.giveaways, enabled: false }
    const c = await joinScene(gs.url, await setup())
    await c.waitFor('raffle_changed')
    await c.expectNone('giveaway_available')
  })
})
