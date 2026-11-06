import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setTurnstileFetch } from '../src/auth/turnstile.js'
import { testApp } from './helpers/factories.js'

let app: Awaited<ReturnType<typeof testApp>>
const okFetch = (async () => new Response(JSON.stringify({ success: true }))) as unknown as typeof fetch
const badFetch = (async () => new Response(JSON.stringify({ success: false }))) as unknown as typeof fetch
const dev = (n: string) => `device-${n}`.padEnd(20, 'x')

function start(deviceId: string, ip = '10.0.0.1') {
  return app.inject({
    method: 'POST',
    url: '/api/auth/trial',
    headers: { 'x-forwarded-for': ip },
    payload: { turnstileToken: 'tok', deviceId },
  })
}

const savedSecret = config.turnstileSecretKey
beforeAll(async () => {
  ;(config as any).turnstileSecretKey = 'test-secret' // the stubbed fetch answers; Cloudflare is never called
  app = await testApp()
})
afterAll(async () => {
  ;(config as any).turnstileSecretKey = savedSecret
  await app.close()
})
afterEach(() => setTurnstileFetch(null))

describe('trial sessions', () => {
  it('creates a trial user and session after the bot check', async () => {
    setTurnstileFetch(okFetch)
    const before = Date.now()
    const res = await start(dev('create'), '10.1.0.1')
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.user.trial).toBe(true)
    const row = await db.query.users.findFirst({ where: eq(users.id, body.user.id) })
    expect(row?.isTrial).toBe(true)
    expect(row?.email).toBeNull()
    const days = (new Date(body.user.expiresAt).getTime() - before) / 86400000
    expect(days).toBeGreaterThan(13.99)
    expect(days).toBeLessThan(14.01)
    const claims = app.jwt.decode<any>(body.accessToken)
    expect(claims.kind).toBe('trial')
    expect(claims.id).toBe(body.user.id)
  })

  it('refuses a failed bot check', async () => {
    setTurnstileFetch(badFetch)
    const res = await start(dev('bot'), '10.2.0.1')
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('bot_check_failed')
    const rows = await db.select().from(users).where(eq(users.trialDeviceHash, (await import('../src/auth/hash.js')).sha256(dev('bot'))))
    expect(rows).toHaveLength(0)
  })

  it('refuses a malformed deviceId', async () => {
    setTurnstileFetch(okFetch)
    const res = await start('short', '10.2.0.2')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('bad_device')
  })

  it('limits new trials to 3 a day per IP and per device', async () => {
    setTurnstileFetch(okFetch)
    for (let i = 0; i < 3; i++) expect((await start(dev(`ip${i}`), '10.3.0.1')).statusCode).toBe(201)
    const fourth = await start(dev('ip3'), '10.3.0.1')
    expect(fourth.statusCode).toBe(429)
    expect(fourth.json().error).toBe('trial_limit')

    for (let i = 0; i < 3; i++) expect((await start(dev('same'), `10.4.0.${i}`)).statusCode).toBe(201)
    const again = await start(dev('same'), '10.4.0.9')
    expect(again.statusCode).toBe(429)
    expect(again.json().error).toBe('trial_limit')
  })

  it('counts every IPv6 address in a /64 toward the same daily limit', async () => {
    setTurnstileFetch(okFetch)
    for (let i = 1; i <= 3; i++) expect((await start(dev(`v6${i}`), `2001:db8:77:1::${i}`)).statusCode).toBe(201)
    const fourth = await start(dev('v64'), '2001:db8:77:1:ffff::9')
    expect([fourth.statusCode, fourth.json().error]).toEqual([429, 'trial_limit'])
    expect((await start(dev('v65'), '2001:db8:77:2::1')).statusCode).toBe(201)
  })

  it('refreshes a trial session; a converted trial\'s refresh is refused', async () => {
    setTurnstileFetch(okFetch)
    const body = (await start(dev('refresh'), '10.5.0.1')).json()
    const ok = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${body.refreshToken}` } })
    expect(ok.statusCode).toBe(200)
    expect(app.jwt.decode<any>(ok.json().accessToken).kind).toBe('trial')
    await db.update(users).set({ isTrial: false }).where(eq(users.id, body.user.id))
    const ended = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${body.refreshToken}` } })
    expect(ended.statusCode).toBe(401)
    expect(ended.json().error).toBe('trial_ended')
  })

  it('refuses trials in cloud mode without a Turnstile secret', async () => {
    const c = config as any
    const saved = { mode: c.mode, secret: c.turnstileSecretKey }
    c.mode = 'cloud'
    c.turnstileSecretKey = ''
    try {
      const res = await start(dev('cloud'), '10.6.0.1')
      expect(res.statusCode).toBe(503)
      expect(res.json().error).toBe('trials_unavailable')
    } finally {
      c.mode = saved.mode
      c.turnstileSecretKey = saved.secret
    }
  })
})
