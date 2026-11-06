import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'

describe('POST /api/auth/trial rate limit', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp({ logger: false, backfill: false })
    await app.ready()
  })
  afterAll(async () => { await app.close() })

  it('allows 10 a minute per address, then 429', async () => {
    const codes: number[] = []
    for (let i = 0; i < 11; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/api/auth/trial', remoteAddress: '198.51.100.50', payload: { deviceId: 'bad' } })).statusCode)
    }
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true)
    expect(codes[10]).toBe(429)
  })
})
