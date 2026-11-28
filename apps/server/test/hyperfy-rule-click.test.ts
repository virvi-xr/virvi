import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { hyperfyWorlds, sceneElements, sceneRules } from '../src/db/schema.js'
import { createWorldKey } from '../src/hyperfy/worlds.js'
import { sceneSnapshot } from '../src/hyperfy/snapshot.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, testApp } from './helpers/factories.js'

/** LIV-196: Hyperfy worlds running the Virvi app pass on their visitors' clicks to click rules. */
describe('POST /api/hyperfy/rule-click', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  async function setup() {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const button = await createElement(preset.id, { type: 'model', name: 'Switch', properties: { modelSrc: 'https://x/s.glb' } })
    const lamp = await createElement(preset.id, { type: 'image', name: 'Lamp' })
    await db.insert(sceneRules).values({ presetId: preset.id, trigger: { type: 'click', elementId: button.id }, actions: [{ type: 'toggle', elementId: lamp.id }] })
    const k = createWorldKey()
    await db.insert(hyperfyWorlds).values({ sceneId: scene.id, ownerId: owner.id, name: 'W', keyHash: k.hash, keyPrefix: k.prefix })
    const click = (elementId: string, key = k.raw) => app.inject({ method: 'POST', url: '/api/hyperfy/rule-click', headers: { authorization: `Bearer ${key}` }, payload: { elementId } })
    return { scene, button, lamp, click }
  }

  it('runs the click rule with the world key, and the feed marks the item', async () => {
    const { scene, button, lamp, click } = await setup()
    const snap = await sceneSnapshot(scene.id)
    expect((snap!.scene as any).models[0].clickEvent).toMatchObject({ ruleElement: button.id })
    const res = await click(button.id)
    expect(res.json()).toEqual({ ran: 1 })
    expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, lamp.id) }))!.enabled).toBe(false)
    // The rule's change is news to the feed
    expect((await sceneSnapshot(scene.id))!.version).not.toBe(snap!.version)
  })

  it('refuses a bad key, an item outside the live preset, and nonsense', async () => {
    const { lamp, click } = await setup()
    const other = await setup()
    expect((await click(lamp.id, 'virviw_nope')).statusCode).toBe(401)
    expect((await click(other.button.id)).statusCode).toBe(404)
    expect((await click('not-an-id')).statusCode).toBe(400)
    expect((await click(lamp.id)).json()).toEqual({ ran: 0 })
  })
})
