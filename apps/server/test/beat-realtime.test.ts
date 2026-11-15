import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { BEAT_CARD_LEAD_MS } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beats, beatScenes } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

const H = 3_600_000
const at = (ms: number) => new Date(Date.now() + ms)

describe('beat_available on join (LIV-11)', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  const prev = config.beats
  beforeEach(async () => {
    await resetDb()
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon-amoy' }
    gs = await startGameServer()
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    await gs.stop()
  })

  let tokenSeq = 500
  async function setup() {
    const host = await createUser({ wallet: randomWallet() })
    const s = await createScene(host)
    return { host, sceneId: s.scene.id }
  }
  async function seed(sceneId: string, ownerUserId: string, over: Partial<typeof beats.$inferInsert> = {}) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon-amoy', ownerUserId, name: 'Opening night', description: 'Thanks', imageUrl: 'https://cdn.example/b.png',
      tokenId: tokenSeq++, status: 'live', minPresentSeconds: 300, supplyCap: 100, startsAt: at(-H), endsAt: at(H), ...over,
    }).returning()
    await db.insert(beatScenes).values({ beatId: b.id, sceneId })
    return b
  }

  it('tells a joining client the BEAT inside the card window: its name and test flag only', async () => {
    const { host, sceneId } = await setup()
    await seed(sceneId, host.id)
    const c = await joinScene(gs.url, sceneId)
    expect(await c.waitFor('beat_available')).toEqual({ beat: { name: 'Opening night', test: true } })
  })

  it('counts the lead time before the start, and a paid BEAT', async () => {
    const { host, sceneId } = await setup()
    await seed(sceneId, host.id, { status: 'paid', startsAt: at(BEAT_CARD_LEAD_MS - 60_000), endsAt: at(2 * H) })
    const c = await joinScene(gs.url, sceneId)
    expect(await c.waitFor('beat_available')).toEqual({ beat: { name: 'Opening night', test: true } })
  })

  it('null outside the window: ended, not yet in the lead time, or in its claim grace', async () => {
    const { host, sceneId } = await setup()
    await seed(sceneId, host.id, { startsAt: at(-3 * H), endsAt: at(-H) })
    await seed(sceneId, host.id, { startsAt: at(BEAT_CARD_LEAD_MS + H), endsAt: at(BEAT_CARD_LEAD_MS + 2 * H) })
    await seed(sceneId, host.id, { status: 'ended', startsAt: at(-H), endsAt: at(H) })
    await seed(sceneId, host.id, { status: 'draft', startsAt: at(-H), endsAt: at(H) })
    const c = await joinScene(gs.url, sceneId)
    expect(await c.waitFor('beat_available')).toEqual({ beat: null })
  })

  it('sends nothing when BEATs are disabled', async () => {
    ;(config as any).beats = { ...config.beats, enabled: false }
    const { host, sceneId } = await setup()
    await seed(sceneId, host.id)
    const c = await joinScene(gs.url, sceneId)
    await c.waitFor('raffle_changed')
    await c.expectNone('beat_available')
  })
})
