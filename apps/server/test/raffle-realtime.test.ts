import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { raffleEntries, raffles } from '../src/db/schema.js'
import { drawRaffle, enterRaffle, takeSnapshot } from '../src/raffles/service.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

describe('raffle realtime fan-out (LIV-55)', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  async function setup() {
    const host = await createUser({ wallet: randomWallet() })
    const s = await createScene(host)
    const other = await createScene(host)
    return { host, sceneId: s.scene.id, otherSceneId: other.scene.id }
  }
  async function openRaffle(sceneId: string, hostId: string) {
    const [r] = await db.insert(raffles).values({
      sceneId, createdBy: hostId, name: 'Friday raffle', prize: 'A wearable', winnersCount: 1, mode: 'one_per_person', status: 'open',
      hostTermsAcceptedAt: new Date(), openedAt: new Date(),
    }).returning()
    return r
  }
  async function presentEntrant(raffleId: string) {
    const u = await createUser({ wallet: randomWallet() })
    await db.insert(raffleEntries).values({
      raffleId, userId: u.id, wallet: u.wallet, displayName: 'Entrant', consentVersion: 1, secondsPresent: 600, lastSeenAt: new Date(Date.now() - 5_000),
    })
    return u
  }

  it('sends raffle_draw to everyone in the scene and nobody in another scene', async () => {
    const { host, sceneId, otherSceneId } = await setup()
    const a = await joinScene(gs.url, sceneId)
    const b = await joinScene(gs.url, sceneId)
    const t = await joinScene(gs.url, otherSceneId)
    const r = await openRaffle(sceneId, host.id)
    await presentEntrant(r.id)
    await takeSnapshot(r.id, 'manual')
    const { draw } = await drawRaffle(r.id, host.id)
    for (const c of [a, b]) {
      const msg = await c.waitFor('raffle_draw')
      expect(msg).toMatchObject({ drawId: draw.id, raffleId: r.id, winners: [{ displayName: 'Entrant' }] })
    }
    await t.expectNone('raffle_draw')
  })

  it('sends raffle_changed after an entry, to its own scene only', async () => {
    const { host, sceneId, otherSceneId } = await setup()
    const r = await openRaffle(sceneId, host.id)
    const a = await joinScene(gs.url, sceneId)
    const t = await joinScene(gs.url, otherSceneId)
    await a.waitFor('raffle_changed') // the join message
    await t.waitFor('raffle_changed')
    const u = await createUser({ wallet: randomWallet() })
    await enterRaffle(r, { userId: u.id, wallet: u.wallet!, signInName: 'Visitor' }, 1)
    const msg = await a.waitFor('raffle_changed')
    expect(msg.raffle).toMatchObject({ id: r.id, entryCount: 1, status: 'open' })
    await t.expectNone('raffle_changed')
  })

  it('tells a client that joins later the running raffle, and null when there is none', async () => {
    const { host, sceneId, otherSceneId } = await setup()
    const r = await openRaffle(sceneId, host.id)
    const late = await joinScene(gs.url, sceneId)
    expect((await late.waitFor('raffle_changed')).raffle).toMatchObject({ id: r.id, name: 'Friday raffle', status: 'open', entryCount: 0 })
    const none = await joinScene(gs.url, otherSceneId)
    expect(await none.waitFor('raffle_changed')).toEqual({ raffle: null })
  })
})
