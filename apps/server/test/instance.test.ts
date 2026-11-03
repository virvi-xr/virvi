import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { config } from '../src/config.js'
import { testApp } from './helpers/factories.js'

describe('GET /api/instance', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const original = config.mode
  beforeEach(async () => { app = await testApp() })
  afterEach(async () => { ;(config as any).mode = original; await app.close() })

  it('answers the mode and version without a sign-in, and nothing else', async () => {
    for (const mode of ['single', 'scalable', 'cloud'] as const) {
      ;(config as any).mode = mode
      const res = await app.inject({ method: 'GET', url: '/api/instance' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ mode, version: expect.stringMatching(/^\d+\.\d+\.\d+/) })
    }
  })

  it('reports the same version as the health check', async () => {
    const instance = (await app.inject({ method: 'GET', url: '/api/instance' })).json()
    const health = (await app.inject({ method: 'GET', url: '/api/health' })).json()
    expect(instance.version).toBe(health.version)
  })
})
