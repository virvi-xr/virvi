import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { VirviClient, VirviApiError, verifyWebhook } from '../dist/index.js'

function fakeFetch(answers) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init })
    const [status, body] = answers.shift() ?? [200, {}]
    return new Response(body === undefined ? '' : JSON.stringify(body), { status })
  }
  return { f, calls }
}

test('calls the route with the key and unwraps the answer', async () => {
  const { f, calls } = fakeFetch([[200, { scenes: [{ id: 's1', name: 'Club', activePresetId: 'p1' }] }]])
  const v = new VirviClient({ apiKey: 'virvi_k1_x', baseUrl: 'https://api.example/', fetch: f })
  assert.deepEqual(await v.scenes.list(), [{ id: 's1', name: 'Club', activePresetId: 'p1' }])
  assert.equal(calls[0].url, 'https://api.example/api/v1/scenes')
  assert.equal(calls[0].init.headers.authorization, 'Bearer virvi_k1_x')
  assert.equal(calls[0].init.body, undefined)
})

test('sends JSON bodies and escapes ids', async () => {
  const { f, calls } = fakeFetch([[201, { instance: { id: 'i1', position: { x: 1, y: 0, z: 2 } } }]])
  const v = new VirviClient({ apiKey: 'k', fetch: f })
  const i = await v.instances.create('a/b', { position: { x: 1, y: 0, z: 2 } })
  assert.equal(i.id, 'i1')
  assert.equal(calls[0].url, 'https://api.virvi.io/api/v1/elements/a%2Fb/instances')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { position: { x: 1, y: 0, z: 2 } })
})

test("a refusal is a VirviApiError with the route's code and words", async () => {
  const { f } = fakeFetch([[403, { error: 'read_only_key', message: 'This API key can only read.' }]])
  const v = new VirviClient({ apiKey: 'k', fetch: f })
  await assert.rejects(v.elements.update('e1', { name: 'x' }), (err) => err instanceof VirviApiError && err.status === 403 && err.code === 'read_only_key' && err.message === 'This API key can only read.')
})

test('a client needs a key', () => {
  assert.throws(() => new VirviClient({ apiKey: '' }), /needs an apiKey/)
})

test('verifyWebhook accepts a genuine delivery and refuses tampering, other secrets and old ones', async () => {
  const secret = 'whsec_test'
  const body = JSON.stringify({ id: 'd1', type: 'webhook.test', createdAt: '2026-11-28T00:00:00Z', data: { message: 'hi' } })
  const now = new Date('2026-11-28T00:00:10Z')
  const t = Math.floor(now.getTime() / 1000) - 10
  const header = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
  assert.deepEqual((await verifyWebhook(body, header, secret, { now }))?.data, { message: 'hi' })
  assert.equal(await verifyWebhook(body.replace('hi', 'ho'), header, secret, { now }), null)
  assert.equal(await verifyWebhook(body, header, 'whsec_other', { now }), null)
  assert.equal(await verifyWebhook(body, header, secret, { now: new Date(now.getTime() + 600_000) }), null)
  assert.equal(await verifyWebhook(body, undefined, secret, { now }), null)
})
