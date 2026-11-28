import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { events, webhookDeliveries } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { deliverDue, emitDeploymentFinished, RETRY_MS, signature, sweepEventStarts } from '../src/webhooks/webhooks.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

/** LIV-39: webhooks, signed and retried. A local receiver stands in for the customer's endpoint. */
describe('webhooks', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let server: Server
  let url = ''
  let got: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = []
  let answer = 200
  const allowPrivate = config.allowPrivateCallbackUrls

  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    got = []
    answer = 200
    ;(config as { allowPrivateCallbackUrls: boolean }).allowPrivateCallbackUrls = true
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { got.push({ headers: req.headers, body }); res.statusCode = answer; res.end('ok') })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`
  })
  afterEach(async () => {
    ;(config as { allowPrivateCallbackUrls: boolean }).allowPrivateCallbackUrls = allowPrivate
    await new Promise<void>((r) => server.close(() => r()))
    await app.close()
  })

  const as = (u: TestUser, method: string, path: string, payload?: unknown) =>
    app.inject({ method: method as any, url: path, headers: { authorization: `Bearer ${tokenFor(u)}` }, ...(payload ? { payload: payload as any } : {}) })
  const settle = async (n: number) => { for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 20)) }

  it('makes a webhook, shows the secret once, and signs a test delivery with it', async () => {
    const u = await createUser()
    const made = await as(u, 'POST', '/api/webhooks', { url, events: ['deployment.finished'] })
    expect(made.statusCode).toBe(201)
    const { webhook, secret } = made.json()
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/)
    expect((await as(u, 'GET', '/api/webhooks')).json().webhooks).toEqual([expect.not.objectContaining({ secret: expect.anything() })])

    const test = await as(u, 'POST', `/api/webhooks/${webhook.id}/test`)
    expect(test.json().delivery).toMatchObject({ event: 'webhook.test', status: 'delivered', responseStatus: 200 })
    expect(got).toHaveLength(1)
    const h = got[0].headers
    expect(h['virvi-event']).toBe('webhook.test')
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(h['virvi-signature']))!
    expect(createHmac('sha256', secret).update(`${t}.${got[0].body}`).digest('hex')).toBe(v1)
    expect(JSON.parse(got[0].body)).toMatchObject({ id: h['virvi-delivery'], type: 'webhook.test', data: { message: 'A test from Virvi' } })
  })

  it("deployment.finished reaches the scene owner's webhooks once, not someone else's", async () => {
    const owner = await createUser()
    const other = await createUser()
    const { scene } = await createScene(owner, 'Club')
    await as(owner, 'POST', '/api/webhooks', { url, events: ['deployment.finished'] })
    await as(other, 'POST', '/api/webhooks', { url, events: ['deployment.finished'] })
    const id = crypto.randomUUID()
    await emitDeploymentFinished({ deploymentId: id, sceneId: scene.id, status: 'deployed', entityId: 'bafy' })
    await emitDeploymentFinished({ deploymentId: id, sceneId: scene.id, status: 'deployed', entityId: 'bafy' }) // repeated: deduped
    await settle(1)
    await new Promise((r) => setTimeout(r, 100))
    expect(got).toHaveLength(1)
    expect(JSON.parse(got[0].body)).toMatchObject({ type: 'deployment.finished', data: { deploymentId: id, sceneId: scene.id, sceneName: 'Club', status: 'deployed', entityId: 'bafy' } })
  })

  it('retries a failed delivery with backoff, then gives up', async () => {
    const u = await createUser()
    const { webhook } = (await as(u, 'POST', '/api/webhooks', { url, events: ['event.started'] })).json()
    answer = 500
    const start = new Date(Date.now() - 60_000)
    const [e] = await db.insert(events).values({ ownerId: u.id, name: 'Gig', startTime: start }).returning()
    expect(await sweepEventStarts()).toBe(1)
    await settle(1)
    await new Promise((r) => setTimeout(r, 100))
    let [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, webhook.id))
    expect(d).toMatchObject({ event: 'event.started', status: 'pending', attempts: 1, responseStatus: 500, lastError: 'HTTP 500' })
    expect(d.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(RETRY_MS[0] - 5_000)
    // A second sweep doesn't make another delivery for the same start
    await sweepEventStarts()
    expect(await db.select().from(webhookDeliveries)).toHaveLength(1)
    // Each due retry is tried; after the last it stays failed
    let t = Date.now()
    for (const wait of RETRY_MS) { t += wait + 1000; await deliverDue(new Date(t)) }
    ;[d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, webhook.id))
    expect(d).toMatchObject({ status: 'failed', attempts: RETRY_MS.length + 1, nextAttemptAt: null })
    expect(JSON.parse(got[0].body).data).toMatchObject({ eventId: e.id, name: 'Gig' })
    // The owner sees the history
    const list = (await as(u, 'GET', `/api/webhooks/${webhook.id}/deliveries`)).json().deliveries
    expect(list[0]).toMatchObject({ event: 'event.started', status: 'failed' })
  })

  it('refuses private or non-https addresses, unknown events, and another account', async () => {
    const u = await createUser()
    ;(config as { allowPrivateCallbackUrls: boolean }).allowPrivateCallbackUrls = false
    expect((await as(u, 'POST', '/api/webhooks', { url: 'http://example.com/h', events: ['deployment.finished'] })).json().error).toBe('bad_url')
    expect((await as(u, 'POST', '/api/webhooks', { url: 'https://127.0.0.1/h', events: ['deployment.finished'] })).json().error).toBe('bad_url')
    ;(config as { allowPrivateCallbackUrls: boolean }).allowPrivateCallbackUrls = true
    expect((await as(u, 'POST', '/api/webhooks', { url, events: ['asset.sold'] })).json().error).toBe('bad_events')
    const { webhook } = (await as(u, 'POST', '/api/webhooks', { url, events: ['deployment.finished'] })).json()
    const other = await createUser()
    for (const [m, p] of [['DELETE', `/api/webhooks/${webhook.id}`], ['POST', `/api/webhooks/${webhook.id}/test`], ['GET', `/api/webhooks/${webhook.id}/deliveries`]] as const) {
      expect((await as(other, m, p)).statusCode, p).toBe(404)
    }
    expect((await as(u, 'DELETE', `/api/webhooks/${webhook.id}`)).statusCode).toBe(204)
  })

  it('signature() matches the documented scheme', () => {
    const at = new Date('2026-11-28T00:00:00Z')
    expect(signature('whsec_x', '{"a":1}', at)).toBe(`t=${at.getTime() / 1000},v1=${createHmac('sha256', 'whsec_x').update(`${at.getTime() / 1000}.{"a":1}`).digest('hex')}`)
  })
})
