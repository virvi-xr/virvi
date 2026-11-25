import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { tokenFor, type TestUser } from './helpers/factories.js'

describe('global rate limit', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp({ logger: false, backfill: false })
    await app.ready()
  })
  afterAll(async () => { await app.close() })

  const hit = (url: string, remoteAddress: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, remoteAddress, headers })

  it('allows a dashboard session a few hundred API calls a minute', () => {
    expect(config.rateLimitMax).toBe(300)
  })

  it('still limits API calls per address', async () => {
    let last = 0
    for (let i = 0; i <= config.rateLimitMax; i++) last = (await hit('/api/health', '198.51.100.1')).statusCode
    expect(last).toBe(429)
  })

  // Venue Wi-Fi: a signed-in account has its own allowance, wherever its network is shared
  it('limits signed-in accounts per account, not per address', async () => {
    const fake = () => ({ id: crypto.randomUUID(), email: null, role: 'viewer', wallet: null }) as unknown as TestUser
    const accounts = Array.from({ length: 60 }, () => ({ authorization: `Bearer ${tokenFor(fake())}` }))
    const statuses: number[] = []
    for (let round = 0; round < 6; round++) for (const h of accounts) statuses.push((await hit('/api/health', '198.51.100.3', h)).statusCode)
    expect(statuses.length).toBeGreaterThan(config.rateLimitMax)
    expect(statuses.filter((s) => s === 429)).toHaveLength(0)
    // One account still has one allowance
    let last = 0
    const one = accounts[0]
    for (let i = 0; i <= config.rateLimitMax; i++) last = (await hit('/api/health', '198.51.100.4', one)).statusCode
    expect(last).toBe(429)
  })

  it('counts a token that does not verify against the address', async () => {
    let last = 0
    for (let i = 0; i <= config.rateLimitMax; i++) {
      const forged = `x.${Buffer.from(JSON.stringify({ id: crypto.randomUUID(), kind: 'account' })).toString('base64url')}.y`
      last = (await hit('/api/health', '198.51.100.5', { authorization: `Bearer ${forged}` })).statusCode
    }
    expect(last).toBe(429)
  })

  it("doesn't count the dashboard's own files, uploads or well-known files", async () => {
    for (let i = 0; i <= config.rateLimitMax; i++) await hit('/api/health', '198.51.100.2')
    for (const url of ['/.well-known/assetlinks.json', '/', '/scenes/abc', '/_next/static/chunk.js', '/uploads/missing.png']) {
      const res = await hit(url, '198.51.100.2')
      expect(res.statusCode, url).not.toBe(429)
    }
  })
})
