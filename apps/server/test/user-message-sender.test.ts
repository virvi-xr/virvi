import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

/** LIV-158: the room stamps every user_message with its sender; a claimed `from` is replaced. */
describe('user_message sender', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); gs = await startGameServer(); app = await testApp() })
  afterEach(async () => { await app.close(); await gs.stop() })

  it('says who sent it and whether they are staff, and keeps a sender’s order', async () => {
    const owner = await createUser()
    const visitor = await createUser()
    const { scene } = await createScene(owner)
    const host = await joinScene(gs.url, scene.id, tokenFor(owner))
    const guest = await joinScene(gs.url, scene.id, tokenFor(visitor))
    const anon = await joinScene(gs.url, scene.id)
    await Promise.all([host, guest, anon].map((c) => c.waitFor('scene_preset_update')))

    host.room.send('user_message', { messageId: 'door', data: 1, from: { staff: false, userId: 'forged' } })
    host.room.send('user_message', { messageId: 'door', data: 2 })
    const first = await guest.waitFor('user_message')
    expect(first).toMatchObject({ messageId: 'door', data: 1, from: { sessionId: host.room.sessionId, userId: owner.id, guest: false, staff: true } })
    expect((await guest.waitFor('user_message')).data).toBe(2)

    guest.room.send('user_message', { messageId: 'wave', data: null })
    expect((await host.waitFor('user_message')).from).toMatchObject({ userId: visitor.id, guest: false, staff: false })

    anon.room.send('user_message', { messageId: 'wave', data: null })
    expect((await host.waitFor('user_message')).from).toEqual({ sessionId: anon.room.sessionId, userId: null, wallet: null, guest: true, staff: false })
  })
})
