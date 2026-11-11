import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { db } from '../src/db/connection.js'
import { users, errorSignatures, errorEvents, errorHourly, errorHourlyDims, errorHourlyUsers, errorReports } from '../src/db/schema.js'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { flushErrors, resetErrorBuffer, recordJobFailure, bufferedErrorCount } from '../src/errors/record.js'
import { ERROR_BUDGETS, registerRelease, resetErrorBudgets } from '../src/errors/limits.js'
import { errorUserHash } from '../src/errors/user-hash.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { resetDb } from './helpers/db.js'
import { createUser, tokenFor } from './helpers/factories.js'

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const now = () => Date.now()
const apiEvent = (over: Record<string, unknown> = {}) => ({ kind: 'api', t: now(), route: '/scenes', method: 'GET', path: '/api/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab', status: 500, requestId: '0b1c2d3e-0000-4000-8000-000000000001', ...over })
const crash = (over: Record<string, unknown> = {}) => ({
  kind: 'crash', t: now(), route: '/scenes', errorType: 'TypeError', message: 'Cannot read item 4', userFacing: true,
  stack: 'TypeError: Cannot read item 4\n    at renderList (https://virvi.io/_next/static/chunks/page-3a9f0c2b1d4e5f60.js:1:2)',
  breadcrumbs: [{ t: now(), type: 'nav', path: '/scenes' }, { t: now(), type: 'click', label: 'Save' }], ...over,
})

describe('error ingest (POST /api/errors)', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    await resetDb()
    resetErrorBuffer()
    resetErrorBudgets()
    await registerRelease('abc1234') // a release the server has run, so browsers on it are believed
    app = await buildApp({ rateLimit: false, logger: false, backfill: false })
    app.get('/api/test-boom', async () => { throw new TypeError('boom 42 happened') })
    app.get('/api/test-503', async (_r, reply) => reply.status(503).send({ error: 'down' }))
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  const send = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/errors', payload: body as any, headers: { 'user-agent': CHROME, ...headers } })

  it('takes a batch from a signed-in user and records it grouped, with a hashed user, the token’s org and the browser', async () => {
    const u = await createUser()
    const orgId = '11111111-2222-4333-8444-555555555555'
    const res = await send({ v: 1, release: 'abc1234', events: [apiEvent({ userId: 'spoofed', orgId: '99999999-2222-4333-8444-555555555555' }), apiEvent({ path: '/api/scenes/aaaaaaaa-1d2a-4b3c-9d8e-0123456789ab', requestId: '0b1c2d3e-0000-4000-8000-000000000002' })] },
      { authorization: `Bearer ${tokenFor(u, { orgId })}` })
    expect(res.statusCode).toBe(202)
    await flushErrors()
    const sigs = await db.select().from(errorSignatures)
    expect(sigs).toHaveLength(1)
    expect(sigs[0]).toMatchObject({ signature: 'api 500 GET /api/scenes/:id', source: 'web', kind: 'api', status: 500, totalCount: 2, firstRelease: 'abc1234', expected: null })
    const events = await db.select().from(errorEvents)
    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(e.userHash).toBe(errorUserHash(u.id))
      expect(e.userHash).not.toContain(u.id)
      expect(e.orgId).toBe(orgId)
      expect(e.browser).toBe('Chrome 131')
      expect(e.os).toBe('macOS')
      expect(e.release).toBe('abc1234')
    }
    const [hour] = await db.select().from(errorHourly)
    expect(hour).toMatchObject({ count: 2, users: 1, ips: 1 })
    const marks = (await db.select().from(errorHourlyUsers)).map((r) => r.userHash)
    expect(marks.filter((h) => !h.startsWith('ip:'))).toEqual([errorUserHash(u.id)])
    expect(marks.filter((h) => h.startsWith('ip:'))).toHaveLength(1) // a day-salted address hash, never the address
    const dims = await db.select().from(errorHourlyDims)
    expect(dims.map((d) => `${d.dim}=${d.value}:${d.count}`).sort()).toEqual(['browser=Chrome 131:2', `org=${orgId}:2`, 'os=macOS:2', 'release=abc1234:2', 'route=/scenes:2'])
  })

  it('takes a guest’s and a trial’s reports too, counting the trial as a user', async () => {
    expect((await send({ v: 1, events: [crash()] })).statusCode).toBe(202)
    const t = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    const { accessToken } = issueTrialSession(app, { id: t.id, displayName: t.displayName, role: 'creator', trialLastActiveAt: new Date() })
    expect((await send({ v: 1, events: [crash()] }, { authorization: `Bearer ${accessToken}` })).statusCode).toBe(202)
    // a bad token is no user, not a refusal
    expect((await send({ v: 1, events: [crash()] }, { authorization: 'Bearer nonsense' })).statusCode).toBe(202)
    await flushErrors()
    const [sig] = await db.select().from(errorSignatures)
    expect(sig.totalCount).toBe(3)
    expect(sig.kind).toBe('crash')
    const hashes = (await db.select().from(errorEvents)).map((e) => e.userHash)
    expect(hashes.filter(Boolean)).toEqual([errorUserHash(t.id)])
    const [hour] = await db.select().from(errorHourly)
    expect(hour.users).toBe(1)
  })

  it('a trial token counts as anonymous for the signed-in reserve; an account token does not (R3-1)', async () => {
    const day = new Date().toISOString().slice(0, 10)
    for (const k of ['hourly', 'events', 'dims', 'users'] as const) {
      const n = Math.floor(ERROR_BUDGETS.db[k] * ERROR_BUDGETS.anonymousShare)
      await db.execute(sql`INSERT INTO error_budget (day, key, n) VALUES (${day}::date, ${k}, ${n}), (${day}::date, ${`anon:${k}`}, ${n})`)
    }
    const t = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    const { accessToken } = issueTrialSession(app, { id: t.id, displayName: t.displayName, role: 'creator', trialLastActiveAt: new Date() })
    await send({ v: 1, events: [crash({ message: 'trial bug' })] }, { authorization: `Bearer ${accessToken}` })
    const u = await createUser()
    await send({ v: 1, events: [crash({ message: 'account bug' })] }, { authorization: `Bearer ${tokenFor(u)}` })
    await flushErrors()
    expect((await db.select().from(errorSignatures)).map((s) => s.signature).sort()).toEqual([
      'crash TypeError: account bug @ renderList (/_next/static/chunks/page.js)', 'overflow crash',
    ])
  })

  it('stores the first occurrences and only counts repeats and the rest of a busy day', async () => {
    const events = Array.from({ length: 8 }, (_, i) => crash({ message: `Cannot read item ${i}` }))
    await send({ v: 1, events })
    await send({ v: 1, events: [crash({ repeat: true, count: 40 })] })
    await flushErrors()
    const [sig] = await db.select().from(errorSignatures)
    expect(sig.totalCount).toBe(28) // a client count is capped at 20
    expect(await db.select().from(errorEvents)).toHaveLength(5)
    const [hour] = await db.select().from(errorHourly)
    expect(hour).toMatchObject({ count: 28 })
  })

  it('marks expected 4xx and never takes typed text or bodies beyond the redacted error body', async () => {
    await send({ v: 1, events: [apiEvent({ status: 400, errorBody: { error: 'email me@x.com is taken', password: 'hunter2' }, typed: 'my secret text' })] })
    await flushErrors()
    const [sig] = await db.select().from(errorSignatures)
    expect(sig.expected).toBe('validation')
    const [e] = await db.select().from(errorEvents)
    expect(e.errorBody).toEqual({ error: 'email [email] is taken', password: '[redacted]' })
    expect(JSON.stringify(e)).not.toContain('my secret text')
    expect(JSON.stringify(e)).not.toContain('hunter2')
  })

  it('refuses bad and oversized batches, and never records its own failures', async () => {
    expect((await send({ v: 1, events: [] })).statusCode).toBe(400)
    expect((await send({ v: 1, events: [{ kind: 'server_5xx', t: now() }] })).statusCode).toBe(400)
    const big = await app.inject({ method: 'POST', url: '/api/errors', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ v: 1, events: [crash({ message: 'x'.repeat(70_000) })] }) })
    expect(big.statusCode).toBe(413)
    await flushErrors()
    expect(await db.select().from(errorSignatures)).toHaveLength(0)
  })

  it('returns the request ID in a header and records a server 5xx with it, so client and server events join', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test-boom' })
    expect(res.statusCode).toBe(500)
    const requestId = res.headers['x-request-id'] as string
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
    await send({ v: 1, events: [apiEvent({ path: '/api/test-boom', requestId })] })
    const other = await app.inject({ method: 'GET', url: '/api/test-503' })
    expect(other.statusCode).toBe(503)
    await flushErrors()
    const sigs = await db.select().from(errorSignatures)
    expect(sigs.map((s) => s.signature).sort()).toEqual(['api 500 GET /api/test-boom', 'server_5xx 500 GET /api/test-boom', 'server_5xx 503 GET /api/test-503'])
    const joined = await db.select().from(errorEvents).where(eq(errorEvents.requestId, requestId))
    expect(joined.map((e) => e.source).sort()).toEqual(['server', 'web'])
    const server = joined.find((e) => e.source === 'server')!
    expect(server).toMatchObject({ errorType: 'TypeError', message: 'boom 42 happened', release: config.release })
    expect(server.stack).toContain('TypeError')
  })

  it('records failed background jobs', async () => {
    recordJobFailure('deploy', new Error('World 12 is full'), { sceneId: '3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab' })
    recordJobFailure('deploy', new Error('World 99 is full'))
    await flushErrors()
    const [sig] = await db.select().from(errorSignatures)
    expect(sig).toMatchObject({ signature: 'job deploy Error: World <n> is full', source: 'server', kind: 'job', totalCount: 2 })
  })

  it('a signature marked fixed that happens again is a regression', async () => {
    await send({ v: 1, events: [crash()] })
    await flushErrors()
    const [sig] = await db.select().from(errorSignatures)
    await db.update(errorSignatures).set({ resolvedAt: new Date(Date.now() - 1000) }).where(eq(errorSignatures.id, sig.id))
    await send({ v: 1, events: [crash()] })
    await flushErrors()
    const [after] = await db.select().from(errorSignatures)
    expect(after.resolvedAt).toBeNull()
    expect(after.regressedAt).not.toBeNull()
  })

  it('drops what it gets while error reporting is off', async () => {
    ;(config as any).errorReportingEnabled = false
    try {
      expect((await send({ v: 1, events: [crash()] })).statusCode).toBe(202)
      expect(bufferedErrorCount()).toBe(0)
    } finally {
      ;(config as any).errorReportingEnabled = true
    }
  })

  it('a crash screen report attaches the description to the signature, with the account of a signed-in sender', async () => {
    const u = await createUser()
    const res = await app.inject({ method: 'POST', url: '/api/errors/reports', headers: { authorization: `Bearer ${tokenFor(u)}`, 'user-agent': CHROME },
      payload: { v: 1, release: 'abc1234', description: 'Saving my scene', event: crash() } })
    expect(res.statusCode).toBe(201)
    const [sig] = await db.select().from(errorSignatures)
    expect(sig.userReports).toBe(1)
    expect(sig.signature).toContain('crash TypeError')
    const [report] = await db.select().from(errorReports)
    expect(report).toMatchObject({ signatureId: sig.id, userId: u.id, description: 'Saving my scene', release: 'abc1234' })
    expect((report.payload as any).event.breadcrumbs).toHaveLength(2)
    const guest = await app.inject({ method: 'POST', url: '/api/errors/reports', payload: { v: 1, description: 'Clicking save', event: crash() } })
    expect(guest.statusCode).toBe(201)
    const [again] = await db.select().from(errorSignatures)
    expect(again.userReports).toBe(2)
    expect((await app.inject({ method: 'POST', url: '/api/errors/reports', payload: { v: 1, description: '', event: crash() } })).statusCode).toBe(400)
  })
})

describe('error ingest rate limit', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    resetErrorBuffer()
    app = await buildApp({ logger: false, backfill: false })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  it('limits each address on its own', async () => {
    const hit = (ip: string) => app.inject({ method: 'POST', url: '/api/errors', remoteAddress: ip, payload: { v: 1, events: [crash()] } })
    let last = 0
    for (let i = 0; i < 61; i++) last = (await hit('198.51.100.7')).statusCode
    expect(last).toBe(429)
    expect((await hit('198.51.100.8')).statusCode).toBe(202)
    let report = 0
    for (let i = 0; i < 11; i++) report = (await app.inject({ method: 'POST', url: '/api/errors/reports', remoteAddress: '198.51.100.9', payload: { v: 1, description: '', event: crash() } })).statusCode
    expect(report).toBe(429)
  })
})
