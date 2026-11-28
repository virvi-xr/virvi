import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { webhooks } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'
import { signature, webhookSecret } from '../src/webhooks/webhooks.js'
import { VirviApiError, VirviClient, verifyWebhook } from '../../../packages/sdk/src/index.js'

/** LIV-39: @virvixr/sdk against the real routes (its fetch goes through app.inject), so its types match what they return. */
describe('@virvixr/sdk against the API', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  const injectFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const res = await app.inject({ method: (init?.method ?? 'GET') as any, url: url.pathname + url.search, headers: init?.headers as any, payload: init?.body as any })
    return new Response(res.body || null, { status: res.statusCode, headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') } })
  }) as typeof fetch

  async function client(access: 'full' | 'read' = 'full') {
    const u = await createUser()
    const key = (await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${tokenFor(u)}` }, payload: { name: 'sdk', access } })).json().key
    return { u, v: new VirviClient({ apiKey: key, baseUrl: 'http://api.test', fetch: injectFetch }) }
  }

  it('builds a scene end to end: scene, preset, element, placement, live preset', async () => {
    const { u, v } = await client()
    const made = (await app.inject({ method: 'POST', url: '/api/scenes', headers: { authorization: `Bearer ${tokenFor(u)}` }, payload: { name: 'Club' } })).json()
    const sceneId = made.scene?.id ?? made.id
    expect((await v.scenes.list()).map((s) => s.id)).toContain(sceneId)
    const scene = await v.scenes.get(sceneId)
    expect(scene.presets.length).toBeGreaterThan(0)
    const night = await v.presets.create(sceneId, 'Night')
    expect(night.name).toBe('Night')
    expect((await v.presets.rename(night.id, 'Late night')).name).toBe('Late night')
    const el = await v.elements.create(night.id, { type: 'image', name: 'Poster', properties: { textureSrc: 'https://x/a.png' } })
    const inst = await v.instances.create(el.id, { position: { x: 4, y: 0, z: 6 } })
    expect(inst.position).toEqual({ x: 4, y: 0, z: 6 })
    expect((await v.instances.update(inst.id, { position: { x: 5, y: 0, z: 6 } })).position).toEqual({ x: 5, y: 0, z: 6 })
    expect((await v.presets.activate(sceneId, night.id)).activePresetId).toBe(night.id)
    const again = await v.scenes.get(sceneId)
    expect(again.presets.find((p) => p.id === night.id)?.elements?.[0]?.instances?.[0]?.id).toBe(inst.id)
    await v.instances.delete(inst.id)
    await v.elements.delete(el.id)
    expect(Array.isArray(await v.events.list())).toBe(true)
    expect(Array.isArray(await v.media.list())).toBe(true)
  })

  it("a read-only key's write is a VirviApiError with the route's code", async () => {
    const { v } = await client('read')
    await expect(v.events.create({ name: 'x' })).rejects.toMatchObject({ status: 403, code: 'read_only_key' })
    await expect(v.scenes.get('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(VirviApiError)
  })

  it("verifyWebhook accepts exactly what the server signs", async () => {
    const { v } = await client()
    const { webhook, secret } = await v.webhooks.create('https://example.com/hook', ['deployment.finished'])
    const row = await db.query.webhooks.findFirst({ where: eq(webhooks.id, webhook.id) })
    expect(secret).toBe(webhookSecret(webhook.id, row!.salt))
    const body = JSON.stringify({ id: 'd1', type: 'deployment.finished', createdAt: new Date().toISOString(), data: { status: 'deployed' } })
    const header = signature(secret, body, new Date())
    expect((await verifyWebhook(body, header, secret))?.data).toEqual({ status: 'deployed' })
    expect(await verifyWebhook(body, header, 'whsec_wrong')).toBeNull()
    expect((await v.webhooks.list()).map((w) => w.id)).toEqual([webhook.id])
  })
})
