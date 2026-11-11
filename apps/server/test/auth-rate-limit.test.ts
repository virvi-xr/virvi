import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { CREDENTIAL_RATE_LIMIT } from '../src/auth/credential-rate-limit.js'

// Credential-guessing routes get 20 a minute per address, not just the global 300 (LIV-136).
describe('credential route rate limits', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp({ logger: false, backfill: false })
    await app.ready()
  })
  afterAll(async () => { await app.close() })

  it('is 20 a minute', () => {
    expect(CREDENTIAL_RATE_LIMIT).toEqual({ max: 20, timeWindow: '1 minute' })
  })

  const routes: Array<{ method: 'POST' | 'PUT'; url: string }> = [
    { method: 'POST', url: '/api/auth/login' },
    { method: 'POST', url: '/api/auth/register' },
    { method: 'POST', url: '/api/auth/forgot-password' },
    { method: 'POST', url: '/api/auth/reset-password' },
    { method: 'PUT', url: '/api/auth/password' },
    { method: 'POST', url: '/api/auth/wallet/verify' },
  ]

  routes.forEach(({ method, url }, i) => {
    it(`${method} ${url}: the 21st call from one address in a minute is 429; another address is unaffected`, async () => {
      const ip = `198.51.100.${100 + i}`
      const codes: number[] = []
      for (let n = 0; n < 21; n++) codes.push((await app.inject({ method, url, remoteAddress: ip, payload: {} })).statusCode)
      expect(codes.slice(0, 20).every((c) => c !== 429)).toBe(true)
      expect(codes[20]).toBe(429)
      const other = await app.inject({ method, url, remoteAddress: `203.0.113.${100 + i}`, payload: {} })
      expect(other.statusCode).not.toBe(429)
    })
  })

  it('leaves token refresh on the global limit', async () => {
    const codes: number[] = []
    for (let n = 0; n < 21; n++) codes.push((await app.inject({ method: 'POST', url: '/api/auth/refresh', remoteAddress: '198.51.100.200', payload: {} })).statusCode)
    expect(codes).not.toContain(429)
  })
})
