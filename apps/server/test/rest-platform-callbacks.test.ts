import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/integrations/platform-hooks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/integrations/platform-hooks.js')>()),
  dispatchPlatformCallbacks: vi.fn(async () => {}),
}))

import { db } from '../src/db/connection.js'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { scenePresets, platformCallbacks, sceneRoles, streamingServers } from '../src/db/schema.js'
import { dispatchPlatformCallbacks } from '../src/integrations/platform-hooks.js'
import { MAX_CALLBACKS_PER_SCENE } from '../src/routes/hooks.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor, testApp } from './helpers/factories.js'

const dispatch = vi.mocked(dispatchPlatformCallbacks)
const until = async (n: number) => {
  for (let i = 0; i < 100 && dispatch.mock.calls.length < n; i++) await new Promise((r) => setTimeout(r, 10))
}

describe('REST element/instance writes dispatch platform callbacks', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    dispatch.mockClear()
  })
  afterEach(() => app.close())

  it('one config_update per write with the compact element config; delete flagged', async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    const headers = { authorization: `Bearer ${tokenFor(host)}` }
    const created = await app.inject({
      method: 'POST', url: `/api/presets/${preset.id}/elements`, headers,
      payload: { type: 'image', name: 'Poster', properties: { textureSrc: 'https://cdn.virvi.io/u1/a.png' } },
    })
    const elementId = created.json().element.id
    await until(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const [sceneId, payload] = dispatch.mock.calls[0] as [string, Record<string, unknown>]
    expect(sceneId).toBe(scene.id)
    expect(payload).toMatchObject({ action: 'config_update', elementId, element: 'image', name: 'Poster', textureSrc: 'https://cdn.virvi.io/u1/a.png' })
    expect(payload).not.toHaveProperty('instances')
    expect(payload).not.toHaveProperty('sk')

    const inst = await app.inject({ method: 'POST', url: `/api/elements/${elementId}/instances`, headers, payload: { position: { x: 1, y: 2, z: 3 } } })
    await until(2)
    await app.inject({ method: 'PUT', url: `/api/instances/${inst.json().instance.id}`, headers, payload: { position: { x: 4, y: 2, z: 3 } } })
    await until(3)
    await app.inject({ method: 'PUT', url: `/api/elements/${elementId}`, headers, payload: { enabled: false } })
    await until(4)
    expect((dispatch.mock.calls[3] as any)[1]).toMatchObject({ action: 'config_update', elementId, enabled: false })
    await app.inject({ method: 'DELETE', url: `/api/elements/${elementId}`, headers })
    await until(5)
    expect(dispatch).toHaveBeenCalledTimes(5)
    expect((dispatch.mock.calls[4] as any)[1]).toEqual({ action: 'config_update', elementId, element: 'image', deleted: true })
  })

  it('edits to a non-active preset are not dispatched, and dispatcher failures do not fail the write', async () => {
    const host = await createUser()
    const { scene } = await createScene(host)
    const [other] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Other' }).returning()
    const res = await app.inject({
      method: 'POST', url: `/api/presets/${other.id}/elements`, headers: { authorization: `Bearer ${tokenFor(host)}` },
      payload: { type: 'image', name: 'Hidden' },
    })
    expect(res.statusCode).toBe(201)
    await new Promise((r) => setTimeout(r, 100))
    expect(dispatch).not.toHaveBeenCalled()

    dispatch.mockRejectedValueOnce(new Error('boom'))
    const { preset } = await createScene(host)
    const ok = await app.inject({
      method: 'POST', url: `/api/presets/${preset.id}/elements`, headers: { authorization: `Bearer ${tokenFor(host)}` },
      payload: { type: 'image', name: 'Shown' },
    })
    expect(ok.statusCode).toBe(201)
  })
})

describe('platform hook callback safety', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    dispatch.mockClear()
  })
  afterEach(() => app.close())
  const register = (sceneId: string, callbackUrl: string) =>
    app.inject({ method: 'POST', url: '/hook/register', payload: { sceneId, callbackUrl, platform: 'secondlife' } })

  it('refuses internal callback addresses and stores nothing', async () => {
    const { scene } = await createScene(await createUser())
    const res = await register(scene.id, 'http://169.254.169.254/latest')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'callback_url_not_allowed' })
    expect(await db.select().from(platformCallbacks)).toHaveLength(0)
  })

  it('caps distinct callbacks per scene; re-registering an existing URL still works', async () => {
    const { scene } = await createScene(await createUser())
    await db.insert(platformCallbacks).values(
      Array.from({ length: MAX_CALLBACKS_PER_SCENE }, (_, i) => ({
        sceneId: scene.id, platform: 'secondlife', callbackUrl: `https://93.184.216.${i + 1}/cb`,
      })),
    )
    const over = await register(scene.id, 'https://93.184.216.200/cb')
    expect(over.statusCode).toBe(429)
    expect(over.json()).toEqual({ error: 'too_many_callbacks' })
    const again = await register(scene.id, 'https://93.184.216.1/cb')
    expect(again.statusCode).toBe(200)
  })

  it('stream webhook video_status payloads carry no streamKey', async () => {
    process.env.STREAMING_WEBHOOK_KEY = 'k'
    const host = await createUser()
    const { scene } = await createScene(host)
    await db.insert(streamingServers).values({
      ownerId: host.id, sceneId: scene.id, name: 's', status: 'ready', streamKey: 'secret-key',
      rtmpUrl: 'rtmp://ingest.virvi.io/live/secret-key', hlsPlaylistUrl: 'https://live.virvi.io/streams/x/playlist.m3u8',
    })
    for (const status of ['live', 'offline']) {
      dispatch.mockClear()
      const res = await app.inject({ method: 'POST', url: '/api/streaming/webhook', headers: { 'x-webhook-key': 'k' }, payload: { streamKey: 'secret-key', status } })
      expect(res.statusCode).toBe(200)
      await until(1)
      const payload = (dispatch.mock.calls[0] as any)[1]
      expect(payload.action).toBe('video_status')
      expect(payload).not.toHaveProperty('streamKey')
    }
    delete process.env.STREAMING_WEBHOOK_KEY
  })

  async function listener() {
    const hits: string[] = []
    const server = createServer((req, res) => { hits.push(req.url!); res.end('ok') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    return { hits, port: (server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(r)) }
  }

  it('dispatch refuses a stored private URL: no request, counts as a failure', async () => {
    const { dispatchPlatformCallbacks } = await vi.importActual<typeof import('../src/integrations/platform-hooks.js')>('../src/integrations/platform-hooks.js')
    const { scene } = await createScene(await createUser())
    const l = await listener()
    const [row] = await db.insert(platformCallbacks).values({ sceneId: scene.id, platform: 'secondlife', callbackUrl: `http://127.0.0.1:${l.port}/cb` }).returning()
    await dispatchPlatformCallbacks(scene.id, { action: 'config_update' })
    await l.close()
    expect(l.hits).toHaveLength(0)
    const [after] = await db.select().from(platformCallbacks).where(eq(platformCallbacks.id, row.id))
    expect(after.failureCount).toBe(1)
  })

  it('dispatch refuses a host that resolves public for the check but private for the connection (DNS rebinding)', async () => {
    const { dispatchPlatformCallbacks } = await vi.importActual<typeof import('../src/integrations/platform-hooks.js')>('../src/integrations/platform-hooks.js')
    const { scene } = await createScene(await createUser())
    const l = await listener()
    const [row] = await db.insert(platformCallbacks).values({ sceneId: scene.id, platform: 'secondlife', callbackUrl: `http://rebind.example:${l.port}/cb` }).returning()
    let calls = 0
    const lookup = async () => (++calls === 1 ? ['93.184.216.34'] : ['127.0.0.1'])
    await dispatchPlatformCallbacks(scene.id, { action: 'config_update' }, { lookup })
    await l.close()
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(l.hits).toHaveLength(0)
    const [after] = await db.select().from(platformCallbacks).where(eq(platformCallbacks.id, row.id))
    expect(after.failureCount).toBe(1)
  })

  it('list and delete follow full access: cohost yes, editor 403, stranger 404', async () => {
    const host = await createUser()
    const cohost = await createUser()
    const editor = await createUser()
    const stranger = await createUser()
    const { scene } = await createScene(host)
    await db.insert(sceneRoles).values([
      { sceneId: scene.id, userId: cohost.id, walletAddress: '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0', role: 'cohost' },
      { sceneId: scene.id, userId: editor.id, walletAddress: '0xed0ed0ed0ed0ed0ed0ed0ed0ed0ed0ed0ed0ed0e', role: 'editor' },
    ] as any)
    const [row] = await db.insert(platformCallbacks).values({ sceneId: scene.id, platform: 'secondlife', callbackUrl: 'https://203.0.113.9/cb' }).returning()
    const as = (u: Awaited<ReturnType<typeof createUser>>) => ({ authorization: `Bearer ${tokenFor(u)}` })
    const list = (u: Awaited<ReturnType<typeof createUser>>) => app.inject({ method: 'GET', url: '/api/hooks', headers: as(u) })
    expect((await list(cohost)).json().hooks).toHaveLength(1)
    expect((await list(host)).json().hooks).toHaveLength(1)
    expect((await list(editor)).json().hooks).toHaveLength(0)
    expect((await list(stranger)).json().hooks).toHaveLength(0)
    const del = (u: Awaited<ReturnType<typeof createUser>>) => app.inject({ method: 'DELETE', url: `/api/hooks/${row.id}`, headers: as(u) })
    expect((await del(stranger)).statusCode).toBe(404)
    expect((await del(editor)).statusCode).toBe(403)
    expect((await del(cohost)).statusCode).toBe(204)
  })
})
