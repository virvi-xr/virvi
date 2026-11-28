import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor } from './helpers/factories.js'
import { apiV1Rewrite } from '../src/app.js'

/** LIV-39: /api/v1 is the versioned name for the API; the same routes and checks answer it. */
describe('/api/v1', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  it('rewrites only the v1 prefix', () => {
    expect(apiV1Rewrite('/api/v1/scenes?x=1')).toBe('/api/scenes?x=1')
    expect(apiV1Rewrite('/api/v1')).toBe('/api')
    expect(apiV1Rewrite('/api/v10/scenes')).toBe('/api/v10/scenes')
    expect(apiV1Rewrite('/api/scenes')).toBe('/api/scenes')
    expect(apiV1Rewrite('/mcp')).toBe('/mcp')
  })

  it('answers as /api does, with the same checks', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner, 'Club')
    const auth = { authorization: `Bearer ${tokenFor(owner)}` }
    const v1 = await app.inject({ method: 'GET', url: `/api/v1/scenes/${scene.id}`, headers: auth })
    expect(v1.statusCode).toBe(200)
    expect(v1.json().scene.name).toBe('Club')
    expect((await app.inject({ method: 'GET', url: `/api/v1/scenes/${scene.id}`, headers: { authorization: `Bearer ${tokenFor(await createUser())}` } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/v1/scenes' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).json().status).toBe('ok')
  })
})
