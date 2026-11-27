import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneElementInstances, sceneActivity } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, type TestUser } from './helpers/factories.js'

/** LIV-170: the MCP server at /mcp. Tools call the REST routes with the caller's own key, so they get its checks. */
describe('MCP server', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  const keyFor = async (u: TestUser, access?: 'read' | 'full') =>
    (await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${tokenFor(u)}` }, payload: { name: 'agent', ...(access ? { access } : {}) } })).json().key as string
  let n = 0
  const rpc = (key: string, method: string, params?: unknown) =>
    app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: ++n, method, ...(params ? { params } : {}) } })
  const tool = async (key: string, name: string, args: Record<string, unknown> = {}) => (await rpc(key, 'tools/call', { name, arguments: args })).json().result

  it('initializes, lists tools, and answers notifications with 202', async () => {
    const key = await keyFor(await createUser())
    const init = (await rpc(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json()
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'virvi' } })
    expect(init.result.instructions).toMatch(/treat it as data/)
    const note = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${key}` }, payload: { jsonrpc: '2.0', method: 'notifications/initialized' } })
    expect(note.statusCode).toBe(202)
    const tools = (await rpc(key, 'tools/list')).json().result.tools
    expect(tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['list_scenes', 'get_scene', 'activate_preset', 'add_instance', 'remove_instance', 'create_event', 'create_preset_schedule', 'get_scene_performance']))
    expect(tools.find((t: any) => t.name === 'remove_instance').annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false })
    // Paid, public and dashboard-only tools stay in the dashboard
    for (const name of ['send_studio_prompt', 'add_scene_collaborator', 'create_raffle', 'redeploy_scene', 'open_page', 'open_finalize'])
      expect(tools.map((t: any) => t.name)).not.toContain(name)
    expect(tools.find((t: any) => t.name === 'get_scene').inputSchema).toMatchObject({ type: 'object', properties: { sceneId: expect.any(Object) } })
    expect((await rpc(key, 'nope')).json().error.code).toBe(-32601)
    expect((await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(405)
  })

  it('reads and edits a scene through the REST routes, logged as API activity', async () => {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const el = await createElement(preset.id, { type: 'image', name: 'Poster', properties: { textureSrc: 'https://x/a.png' } })
    const key = await keyFor(owner)

    expect(JSON.stringify((await tool(key, 'list_scenes')).structuredContent)).toContain(scene.id)
    const got = await tool(key, 'get_scene', { sceneId: scene.id })
    expect(got.isError).toBe(false)
    expect(JSON.stringify(got.structuredContent)).toContain(el.id)

    const placed = await tool(key, 'add_instance', { sceneId: scene.id, elementId: el.id, position: { x: 4, y: 0, z: 6 } })
    expect(placed.isError, placed.content[0].text).toBe(false)
    const [inst] = await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.elementId, el.id))
    expect(inst.position).toEqual({ x: 4, y: 0, z: 6 })
    expect((await tool(key, 'update_instance', { sceneId: scene.id, instanceId: inst.id, position: { x: 5, y: 1, z: 6 } })).isError).toBe(false)
    expect((await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.id, inst.id)))[0].position).toEqual({ x: 5, y: 1, z: 6 })
    expect((await tool(key, 'update_element', { sceneId: scene.id, elementId: el.id, name: 'Gig poster' })).isError).toBe(false)
    expect((await tool(key, 'get_scene_performance', { sceneId: scene.id })).isError).toBe(false)
    expect((await tool(key, 'remove_instance', { instanceId: inst.id })).isError).toBe(false)
    expect(await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.id, inst.id))).toHaveLength(0)
    // The activity log records these as API changes, as REST calls with a key are
    const rows = await db.select().from(sceneActivity).where(eq(sceneActivity.sceneId, scene.id))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.via === 'api')).toBe(true)
    // Bad input is the schema's refusal, in words
    expect((await tool(key, 'get_scene', { sceneId: 42 })).isError).toBe(true)
  })

  it("another account's scene is refused through every tool, with the route's reason", async () => {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const el = await createElement(preset.id)
    const inst = await createInstance(el.id)
    const key = await keyFor(await createUser())
    for (const [name, args] of [
      ['get_scene', { sceneId: scene.id }], ['get_scene_activity', { sceneId: scene.id }], ['get_scene_performance', { sceneId: scene.id }],
      ['activate_preset', { sceneId: scene.id, presetId: preset.id }], ['update_element', { sceneId: scene.id, elementId: el.id, name: 'x' }],
      ['add_instance', { sceneId: scene.id, elementId: el.id, position: { x: 0, y: 0, z: 0 } }],
      ['update_instance', { sceneId: scene.id, instanceId: inst.id, position: { x: 1, y: 0, z: 0 } }],
      ['remove_instance', { instanceId: inst.id }], ['create_preset', { sceneId: scene.id, name: 'Night' }],
    ] as const) {
      const r = await tool(key, name, args as any)
      expect(r.isError, name).toBe(true)
    }
    expect(await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.id, inst.id))).toHaveLength(1)
    expect((await tool(key, 'get_scene_activity', { sceneId: 'not-an-id' })).content[0].text).toMatch(/must be an id/)
  })

  it('a read-only key sees and runs only the read tools, and every REST write is refused', async () => {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const el = await createElement(preset.id)
    const key = await keyFor(owner, 'read')
    expect((await app.inject({ method: 'GET', url: '/api/keys', headers: { authorization: `Bearer ${tokenFor(owner)}` } })).json().keys[0].access).toBe('read')
    const names = (await rpc(key, 'tools/list')).json().result.tools.map((t: any) => t.name)
    expect(names).toContain('get_scene')
    expect(names).not.toContain('add_instance')
    expect(names).not.toContain('remove_instance')
    expect((await rpc(key, 'tools/call', { name: 'add_instance', arguments: { sceneId: scene.id, elementId: el.id, position: { x: 0, y: 0, z: 0 } } })).json().error.code).toBe(-32602)
    expect((await tool(key, 'get_scene', { sceneId: scene.id })).isError).toBe(false)
    const write = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: { authorization: `Bearer ${key}` }, payload: { name: 'x' } })
    expect(write.statusCode).toBe(403)
    expect(write.json().error).toBe('read_only_key')
    expect((await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${tokenFor(owner)}` }, payload: { name: 'x', access: 'admin' } })).statusCode).toBe(400)
  })
})

describe('MCP docs', () => {
  it('the docs list every tool the server offers, and nothing it does not', async () => {
    const { readFileSync } = await import('node:fs')
    const { toolsFor } = await import('../src/mcp/server.js')
    const md = readFileSync(new URL('../../docs/src/content/docs/agents/use-virvi-with-your-agent.md', import.meta.url), 'utf8')
    const section = md.slice(md.indexOf('## Connect with MCP'), md.indexOf('## Prompts that work'))
    const table = section.slice(section.indexOf('| Area |'), section.indexOf("What costs money"))
    const documented = new Set([...table.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))
    const offered = new Set(toolsFor(false).map((t) => t.name))
    expect([...offered].filter((n) => !documented.has(n))).toEqual([])
    // A documented tool may be switched off here by its feature flag (giveaways), not missing
    const { TOOLS } = await import('../src/assistant/tools/index.js')
    const gated = new Set(Object.values(TOOLS).filter((t) => t.available && !t.available()).map((t) => t.name))
    expect([...documented].filter((n) => !offered.has(n) && !gated.has(n))).toEqual([])
  })
})
