import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'colyseus.js'
import { Wallet } from 'ethers'
import { db } from '../src/db/connection.js'
import { events, walletBlocks } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

/** A blocked wallet (LIV-11 reissue: the compromised wallet once approved, or one an admin unlinked) in the game rooms:
 * refused at join, and dropped at its next pass renewal. */
describe('blocked wallets in game rooms', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeAll(async () => { gs = await startGameServer() })
  afterAll(async () => { await gs.stop() })
  beforeEach(async () => { await resetDb() })

  const block = (wallet: string) => db.insert(walletBlocks).values({ wallet: wallet.toLowerCase(), reason: 'reissue' })

  async function setup() {
    const w = Wallet.createRandom().address.toLowerCase()
    const owner = await createUser({ wallet: w })
    const { scene } = await createScene(owner, 'A')
    const pass = () => tokenFor(owner, { kind: 'scene', sceneId: scene.id, orgId: null, wallet: w })
    return { w, owner, scene, pass }
  }

  it("refuses a scene pass or an account session of a blocked wallet at join; others still join", async () => {
    const { w, owner, scene, pass } = await setup()
    await block(w)
    await expect(joinScene(gs.url, scene.id, pass())).rejects.toThrow()
    await expect(joinScene(gs.url, scene.id, tokenFor(owner))).rejects.toThrow()
    // Without the wallet (an email session) and anonymous visitors are unaffected
    const email = await joinScene(gs.url, scene.id, tokenFor(owner, { wallet: null }))
    await email.waitFor('scene_preset_update')
    email.room.leave()
    const anon = await joinScene(gs.url, scene.id)
    await anon.waitFor('scene_preset_update')
    anon.room.leave()
  })

  it('drops a connected client at its next pass renewal once its wallet is blocked', async () => {
    const { w, scene, pass } = await setup()
    const c = await joinScene(gs.url, scene.id, pass())
    await c.waitFor('scene_preset_update') // init
    c.room.send('auth_renew', { sessionToken: pass() })
    await c.waitFor('auth_renew_ack')
    let left: number | null = null
    c.room.onLeave((code) => { left = code })
    await block(w)
    c.room.send('auth_renew', { sessionToken: pass() })
    expect((await c.waitFor('virvi_error')).code).toBe('wallet_blocked')
    const start = Date.now()
    while (left === null && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20))
    expect(left).not.toBeNull()
  })

  it('refuses a blocked wallet in the command center room (the studio room runs the same check)', async () => {
    const { w, owner } = await setup()
    const [event] = await db.insert(events).values({ ownerId: owner.id, name: 'Festival' }).returning()
    const ok = await new Client(gs.url).joinOrCreate('virvi_command_center', { eventId: event.id, sessionToken: tokenFor(owner) })
    await ok.leave()
    await block(w)
    await expect(new Client(gs.url).joinOrCreate('virvi_command_center', { eventId: event.id, sessionToken: tokenFor(owner) })).rejects.toThrow()
  })
})
