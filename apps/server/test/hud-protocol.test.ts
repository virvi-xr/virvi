import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { sceneElements } from '../src/db/schema.js'
import { HUD_PROTOCOL_HEADER } from '@virvixr/shared'

// A Decentraland scene pass (no `via`), as /api/auth/platform issues it
const dclPass = (u: any, sceneId: string) => tokenFor(u, { kind: 'scene', sceneId, locationId: null, orgId: null })

describe('Decentraland HUD protocol minimum (426 redeploy_required)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prevMin = config.minDclHudProtocol
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { config.minDclHudProtocol = prevMin; await app.close() })

  async function fixture() {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const element = await createElement(preset.id)
    const instance = await createInstance(element.id)
    return { owner, scene, element, instance }
  }

  const enabledOf = async (id: string) => (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!.enabled

  it('by default (minimum 0) every HUD edits, including one without the header', async () => {
    const f = await fixture()
    const res = await app.inject({ method: 'PUT', url: `/api/elements/${f.element.id}`, headers: { authorization: `Bearer ${dclPass(f.owner, f.scene.id)}` }, payload: { enabled: false } })
    expect(res.statusCode).toBe(200)
  })

  it('a HUD below the minimum gets 426 on writes, and nothing changes', async () => {
    config.minDclHudProtocol = 2
    const f = await fixture()
    const before = await enabledOf(f.element.id)
    const auth = { authorization: `Bearer ${dclPass(f.owner, f.scene.id)}` }
    for (const headers of [auth, { ...auth, [HUD_PROTOCOL_HEADER]: '1' }, { ...auth, [HUD_PROTOCOL_HEADER]: 'junk' }]) {
      const cases: Array<[string, string, object | undefined]> = [
        ['PUT', `/api/elements/${f.element.id}`, { enabled: !before }],
        ['PUT', `/api/instances/${f.instance.id}`, { position: { x: 2, y: 2, z: 2 } }],
        ['DELETE', `/api/elements/${f.element.id}`, undefined],
      ]
      for (const [method, url, payload] of cases) {
        const res = await app.inject({ method: method as any, url, headers, payload })
        expect([res.statusCode, res.json().error], `${method} ${url} ${headers[HUD_PROTOCOL_HEADER as keyof typeof headers]}`).toEqual([426, 'redeploy_required'])
      }
    }
    expect(await enabledOf(f.element.id)).toBe(before)
  })

  it('a HUD at or above the minimum edits', async () => {
    config.minDclHudProtocol = 2
    const f = await fixture()
    for (const v of ['2', '3']) {
      const res = await app.inject({ method: 'PUT', url: `/api/elements/${f.element.id}`, headers: { authorization: `Bearer ${dclPass(f.owner, f.scene.id)}`, [HUD_PROTOCOL_HEADER]: v }, payload: { enabled: false } })
      expect(res.statusCode, v).toBe(200)
    }
  })

  it('reads still work for an old HUD, so the scene keeps showing', async () => {
    config.minDclHudProtocol = 2
    const f = await fixture()
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${f.scene.id}`, headers: { authorization: `Bearer ${dclPass(f.owner, f.scene.id)}` } })
    expect(res.statusCode).toBe(200)
  })

  it('the dashboard (account token) is never checked', async () => {
    config.minDclHudProtocol = 2
    const f = await fixture()
    const res = await app.inject({ method: 'PUT', url: `/api/elements/${f.element.id}`, headers: { authorization: `Bearer ${tokenFor(f.owner)}` }, payload: { enabled: false } })
    expect(res.statusCode).toBe(200)
  })

  it('a browser may send the header (CORS preflight allows it)', async () => {
    const res = await app.inject({
      method: 'OPTIONS', url: '/api/elements/00000000-0000-0000-0000-000000000000',
      headers: { origin: 'https://play.decentraland.org', 'access-control-request-method': 'PUT', 'access-control-request-headers': `authorization,content-type,${HUD_PROTOCOL_HEADER}` },
    })
    expect(res.statusCode).toBeLessThan(300)
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(HUD_PROTOCOL_HEADER)
  })

  it("a pass that isn't allowed on the route still gets its 403, not 426", async () => {
    config.minDclHudProtocol = 2
    const f = await fixture()
    const other = await createScene(f.owner, 'Other')
    const res = await app.inject({ method: 'PUT', url: `/api/elements/${f.element.id}`, headers: { authorization: `Bearer ${dclPass(f.owner, other.scene.id)}` }, payload: { enabled: false } })
    expect([res.statusCode, res.json().error]).toEqual([403, 'scene_pass_not_allowed'])
  })
})
