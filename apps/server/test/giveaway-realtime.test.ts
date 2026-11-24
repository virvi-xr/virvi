import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { config } from '../src/config.js'
import { issueScenePass } from '../src/auth/scene-pass.js'
import { beatLiveSince } from '../src/beats/live.js'
import { db } from '../src/db/connection.js'
import { giveawayItems, giveaways, giveawayScenes } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'
import { testApp } from './helpers/factories.js'

const H = 3_600_000
const at = (ms: number) => new Date(Date.now() + ms)

describe('giveaway_available on join (LIV-194)', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  const prev = config.giveaways
  const prevBeats = config.beats
  beforeEach(async () => {
    await resetDb()
    ;(config as any).giveaways = { ...config.giveaways, enabled: true }
    // BEATs off: the live mark must run for giveaways alone
    ;(config as any).beats = { ...config.beats, enabled: false }
    gs = await startGameServer()
  })
  afterEach(async () => {
    ;(config as any).giveaways = prev
    ;(config as any).beats = prevBeats
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
  async function visitorPass(sceneId: string) {
    const wallet = randomWallet()
    const user = await createUser({ wallet })
    const app = await testApp()
    const pass = issueScenePass(app, user as any, wallet, { sceneId, locationId: null }).accessToken
    await app.close()
    return { user, pass }
  }
  const waitLive = async (sceneId: string, userId: string, ms = 3000) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if ((await beatLiveSince(sceneId, userId)) !== null) return true
      await new Promise((r) => setTimeout(r, 20))
    }
    return false
  }

  it('marks a signed-in visitor live for check-ins while the scene has an open giveaway (BEATs off)', async () => {
    const sceneId = await setup()
    const v = await visitorPass(sceneId)
    const c = await joinScene(gs.url, sceneId, v.pass)
    await c.waitFor('giveaway_available')
    expect(await waitLive(sceneId, v.user.id)).toBe(true)
    await c.room.leave()
  })

  it('writes no live mark when the scene has no open giveaway', async () => {
    const sceneId = await setup({ enabled: false })
    const v = await visitorPass(sceneId)
    const c = await joinScene(gs.url, sceneId, v.pass)
    await c.waitFor('giveaway_available')
    expect(await waitLive(sceneId, v.user.id, 300)).toBe(false)
    await c.room.leave()
  })

  it("tells a joining client the scene's open giveaway: its name, test flag and id only", async () => {
    const c = await joinScene(gs.url, await setup())
    expect(await c.waitFor('giveaway_available')).toEqual({ giveaway: { name: 'Launch party', test: false, giveawayId: expect.any(String) } })
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
