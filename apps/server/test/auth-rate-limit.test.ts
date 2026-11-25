import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { addressKey } from '../src/http/rate-key.js'
import { CREDENTIAL_RATE_LIMIT } from '../src/auth/credential-rate-limit.js'
import { config } from '../src/config.js'

// Credential-guessing routes get 20 a minute per address, not just the global 300 (LIV-136).
describe('credential route rate limits', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp({ logger: false, backfill: false })
    await app.ready()
  })
  afterAll(async () => { await app.close() })

  it('is 20 a minute, per address', () => {
    expect(CREDENTIAL_RATE_LIMIT).toEqual({ max: 20, timeWindow: '1 minute', keyGenerator: addressKey })
  })

  const routes: Array<{ method: 'POST' | 'PUT'; url: string }> = [
    { method: 'POST', url: '/api/auth/login' },
    { method: 'POST', url: '/api/auth/register' },
    { method: 'POST', url: '/api/auth/forgot-password' },
    { method: 'POST', url: '/api/auth/reset-password' },
    { method: 'PUT', url: '/api/auth/password' },
    { method: 'POST', url: '/api/auth/wallet/verify' },
    { method: 'POST', url: '/api/auth/verify-email' },
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

describe('public wallet BEATs page rate limit (LIV-185)', () => {
  let app: FastifyInstance
  const prev = config.beats
  beforeAll(async () => {
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon' }
    app = await buildApp({ logger: false, backfill: false })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    ;(config as any).beats = prev
  })

  it("the public wallet BEATs page allows 60 calls a minute per address (LIV-185)", async () => {
    const url = '/api/wallets/0x00000000000000000000000000000000000000aa/beats'
    const codes: number[] = []
    for (let n = 0; n < 61; n++) codes.push((await app.inject({ method: 'GET', url, remoteAddress: '198.51.100.77' })).statusCode)
    expect(codes.slice(0, 60).every((c) => c !== 429)).toBe(true)
    expect(codes[60]).toBe(429)
    expect((await app.inject({ method: 'GET', url, remoteAddress: '203.0.113.77' })).statusCode).not.toBe(429)
  })
})
