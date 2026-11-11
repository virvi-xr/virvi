import { describe, it, expect } from 'vitest'
import { config } from '../src/config.js'
import { buildApp } from '../src/app.js'
import { bearerMatches } from '../src/metrics.js'

async function appWith(over: { metricsEnabled: boolean; metricsToken?: string }) {
  const prev = { metricsEnabled: config.metricsEnabled, metricsToken: config.metricsToken }
  Object.assign(config as any, over)
  const app = await buildApp({ rateLimit: false, logger: false, backfill: false })
  Object.assign(config as any, prev)
  await app.ready()
  return app
}

describe('/metrics is never public (LIV-156)', () => {
  it('without METRICS_TOKEN it isn\'t served at all', async () => {
    const app = await appWith({ metricsEnabled: true, metricsToken: undefined })
    try {
      const res = await app.inject({ method: 'GET', url: '/metrics' })
      expect(res.statusCode).not.toBe(200)
      expect(res.body).not.toContain('http_requests_total')
    } finally { await app.close() }
  })

  it('with a token it needs the token', async () => {
    const app = await appWith({ metricsEnabled: true, metricsToken: 's3cret-token' })
    try {
      expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401)
      const ok = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer s3cret-token' } })
      expect(ok.statusCode).toBe(200)
    } finally { await app.close() }
  })

  it('compares the bearer exactly', () => {
    expect(bearerMatches('Bearer abc', 'abc')).toBe(true)
    expect(bearerMatches('Bearer abcd', 'abc')).toBe(false)
    expect(bearerMatches('abc', 'abc')).toBe(false)
    expect(bearerMatches(undefined, 'abc')).toBe(false)
  })
})
