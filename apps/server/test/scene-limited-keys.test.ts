import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, type TestUser } from './helpers/factories.js'

/** LIV-170: an API key limited to chosen scenes can touch those scenes and nothing else. */
describe('scene-limited API keys', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  const make = (u: TestUser, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${tokenFor(u)}` }, payload: { name: 'agent', ...body } })
  const as = (key: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: { authorization: `Bearer ${key}` }, ...(payload !== undefined ? { payload: payload as any } : {}) })

  it('works on its scenes, and is refused everywhere else', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'Allowed')
    const b = await createScene(owner, 'Other')
    const elA = await createElement(a.preset.id)
    const elB = await createElement(b.preset.id)
    const instA = await createInstance(elA.id)
    const made = await make(owner, { sceneIds: [a.scene.id] })
    expect(made.statusCode).toBe(201)
    expect(made.json().sceneIds).toEqual([a.scene.id])
    const key = made.json().key

    // Its own scene: reads and writes as the account would
    expect((await as(key, 'GET', `/api/scenes/${a.scene.id}`)).statusCode).toBe(200)
    expect((await as(key, 'PUT', `/api/elements/${elA.id}`, { name: 'Renamed' })).statusCode).toBe(200)
    expect((await as(key, 'PUT', `/api/instances/${instA.id}`, { position: { x: 2, y: 0, z: 2 } })).statusCode).toBe(200)
    // The scene list shows only it
    expect((await as(key, 'GET', '/api/scenes')).json().scenes.map((s: any) => s.id)).toEqual([a.scene.id])

    // The account's other scene, by any id that names it
    for (const [m, url, body] of [
      ['GET', `/api/scenes/${b.scene.id}`], ['PUT', `/api/elements/${elB.id}`, { name: 'x' }], ['POST', `/api/elements/${elB.id}/instances`, { position: { x: 0, y: 0, z: 0 } }],
      ['POST', `/api/presets/${b.preset.id}/elements`, { type: 'image', name: 'x' }],
    ] as const) {
      const r = await as(key, m, url, body)
      expect(r.statusCode, url).toBe(403)
      expect(r.json().error).toBe('key_scene_limited')
    }
    // Account-wide routes, and ones taking a scene in the body, are refused
    for (const [m, url, body] of [['GET', '/api/media'], ['GET', '/api/events'], ['POST', '/api/events', { name: 'x' }], ['GET', '/api/keys'], ['POST', '/api/scenes', { name: 'x' }]] as const) {
      expect((await as(key, m, url, body)).statusCode, url).toBe(403)
    }
  })

  it('a key can only name scenes the account can open, and lists its scenes', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const theirs = await createScene(stranger)
    const mine = await createScene(owner)
    expect((await make(owner, { sceneIds: [theirs.scene.id] })).statusCode).toBe(404)
    expect((await make(owner, { sceneIds: ['nope'] })).statusCode).toBe(400)
    await make(owner, { sceneIds: [mine.scene.id], access: 'read' })
    const [k] = (await app.inject({ method: 'GET', url: '/api/keys', headers: { authorization: `Bearer ${tokenFor(owner)}` } })).json().keys
    expect(k).toMatchObject({ access: 'read', sceneIds: [mine.scene.id] })
  })

  it('through MCP, a scene-limited key reaches only its scenes', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'Allowed')
    const b = await createScene(owner, 'Other')
    const key = (await make(owner, { sceneIds: [a.scene.id] })).json().key
    const call = async (name: string, args: Record<string, unknown>) => (await app.inject({
      method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${key}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    })).json().result
    expect((await call('get_scene', { sceneId: a.scene.id })).isError).toBe(false)
    const other = await call('get_scene', { sceneId: b.scene.id })
    expect(other.isError).toBe(true)
    expect(other.content[0].text).toMatch(/only be used for the scenes/)
    expect(JSON.stringify((await call('list_scenes', {})).structuredContent)).not.toContain(b.scene.id)
  })
})
