import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import type { FastifyInstance } from 'fastify'

const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; html: string }> }))
vi.mock('../src/services/email.js', async (original) => ({
  ...(await original<typeof import('../src/services/email.js')>()),
  sendEmail: async (to: string, subject: string, html: string) => { mail.sent.push({ to, subject, html }); return true },
}))

import { db } from '../src/db/connection.js'
import { users, errorSignatures, errorReports } from '../src/db/schema.js'
import { buildApp } from '../src/app.js'
import { resetErrorBuffer } from '../src/errors/record.js'
import { ERROR_BUDGETS, registerRelease, resetErrorBudgets } from '../src/errors/limits.js'
import { resetPromptFacts } from '../src/errors/prompts.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { purgeErrors } from '../src/errors/retention.js'
import { resetDb } from './helpers/db.js'
import { createUser, tokenFor } from './helpers/factories.js'

/** LIV-66 §4: what a user sends (crash screen, prompt toast or help menu), with an optional screenshot. */

const crash = () => ({ kind: 'crash', t: Date.now(), route: '/scenes', errorType: 'TypeError', message: 'Cannot read item 4', userFacing: true })
const helpMenu = () => ({ kind: 'report', t: Date.now(), route: '/scenes/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab', breadcrumbs: [{ t: Date.now(), type: 'click', label: 'Report a bug' }] })

async function png(withExif = false) {
  const img = sharp({ create: { width: 320, height: 200, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0.5 } } }).png()
  return (withExif ? img.withMetadata({ exif: { IFD0: { Copyright: 'secret-location' } } }) : img).toBuffer()
}

describe('user reports (POST /api/errors/reports)', () => {
  let app: FastifyInstance
  let store: ReturnType<typeof memoryPrivateStore>
  beforeEach(async () => {
    await resetDb()
    resetErrorBuffer()
    resetErrorBudgets()
    resetPromptFacts()
    mail.sent.length = 0
    store = memoryPrivateStore()
    setImportStore(store)
    await registerRelease('abc1234')
    app = await buildApp({ rateLimit: false, logger: false, backfill: false })
    await app.ready()
  })
  afterEach(async () => { setImportStore(null); await app.close() })

  const report = (body: Record<string, unknown>, bearer?: string, ip = '198.51.100.7') => app.inject({
    method: 'POST', url: '/api/errors/reports', payload: { v: 1, release: 'abc1234', ...body } as any, remoteAddress: ip,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })

  it('takes a help-menu report with no error, signed by its page, kept on the Errors page only (never for Linear)', async () => {
    const u = await createUser({ email: 'maker@example.com', name: 'Maker' })
    const res = await report({ description: 'The save button does nothing', event: helpMenu() }, tokenFor(u))
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ received: true, screenshot: null })
    const [sig] = await db.select().from(errorSignatures)
    expect(sig).toMatchObject({ signature: 'report /scenes/:id', kind: 'report', userReports: 1, totalCount: 0 })
    const [r] = await db.select().from(errorReports)
    expect(r.userId).toBe(u.id)
    expect(r.linearSkipped).toBe('no_error')
  })

  it('sends no thank-you email (emails are not verified): the thanks is in the app', async () => {
    const u = await createUser({ email: 'victim@example.com', name: 'your account will be deleted, see evil.example' })
    for (let i = 0; i < 3; i++) expect((await report({ description: `try ${i}`, event: crash() }, tokenFor(u))).statusCode).toBe(201)
    await new Promise((r) => setTimeout(r, 50))
    expect(mail.sent).toEqual([])
  })

  it('a guest’s report is kept without an account and no email', async () => {
    const res = await report({ description: 'It crashed', event: crash() })
    expect(res.json()).toEqual({ received: true, screenshot: null })
    const [r] = await db.select().from(errorReports)
    expect(r.userId).toBeNull()
    expect(mail.sent).toHaveLength(0)
  })

  it("a deleted account's token still sends, without the account (M8: never a 500)", async () => {
    const u = await createUser()
    const t = tokenFor(u)
    await db.delete(users).where(eq(users.id, u.id))
    const res = await report({ description: 'It crashed', event: crash() }, t)
    expect(res.statusCode).toBe(201)
    const [r] = await db.select().from(errorReports)
    expect(r.userId).toBeNull()
    expect(mail.sent).toHaveLength(0)
  })

  it('keeps a screenshot re-encoded without its metadata in the private store; only site admins can open it', async () => {
    const u = await createUser()
    const image = await png(true)
    expect(image.includes(Buffer.from('secret-location'))).toBe(true)
    const res = await report({ description: 'Look at this', event: crash(), screenshot: { type: 'image/png', data: image.toString('base64') } }, tokenFor(u))
    expect(res.statusCode).toBe(201)
    expect(res.json().screenshot).toBe('kept')
    const [r] = await db.select().from(errorReports)
    expect(r.screenshotKey).toBe(`error-reports/${r.id}.png`)
    expect(r.screenshotType).toBe('image/png')
    const stored = await store.get(r.screenshotKey!)
    expect(stored!.body.includes(Buffer.from('secret-location'))).toBe(false)
    expect(r.screenshotBytes).toBe(stored!.body.length)
    // the stored payload never has the image bytes in it
    expect(JSON.stringify(r.payload)).not.toContain(image.toString('base64').slice(0, 40))
    const url = `/api/admin/errors/reports/${r.id}/screenshot`
    expect((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokenFor(u)}` } })).statusCode).toBe(403)
    const admin = await createUser({ role: 'admin' })
    const got = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokenFor(admin)}` } })
    expect(got.statusCode).toBe(200)
    expect(got.headers['content-type']).toBe('image/png')
    expect(got.headers['cache-control']).toContain('private')
    expect(got.rawPayload.equals(stored!.body)).toBe(true)
  })

  it('refuses something that is not a picture before storing anything', async () => {
    const res = await report({ description: 'x', event: crash(), screenshot: { type: 'image/png', data: Buffer.from('not an image at all').toString('base64') } })
    expect(res.statusCode).toBe(415)
    expect(await db.select().from(errorReports)).toHaveLength(0)
    expect(store.keys()).toEqual([])
  })

  it('keeps at most 5 screenshots a day from one address; later reports go without them', async () => {
    const data = (await png()).toString('base64')
    for (let i = 0; i < ERROR_BUDGETS.screenshotsPerIpDay; i++) {
      expect((await report({ description: `r${i}`, event: crash(), screenshot: { type: 'image/png', data } })).json().screenshot).toBe('kept')
    }
    const over = await report({ description: 'one more', event: crash(), screenshot: { type: 'image/png', data } })
    expect([over.statusCode, over.json().screenshot]).toEqual([201, 'not_kept'])
    expect(store.keys()).toHaveLength(5)
    // another address still can
    expect((await report({ description: 'other', event: crash(), screenshot: { type: 'image/png', data } }, undefined, '203.0.113.9')).json().screenshot).toBe('kept')
  })

  it('decodes a screenshot only once it has a place in the budget (M1); a spent address gets 429 before any decode', async () => {
    const data = (await png()).toString('base64')
    for (let i = 0; i < ERROR_BUDGETS.screenshotsPerIpDay; i++) await report({ description: `r${i}`, event: crash(), screenshot: { type: 'image/png', data } }, undefined, '198.51.100.40')
    // not a picture at all: decoded it would be refused 415; past the budget it is never decoded, and the report is kept
    const junk = Buffer.from('not an image at all').toString('base64')
    const over = await report({ description: 'later', event: crash(), screenshot: { type: 'image/png', data: junk } }, undefined, '198.51.100.40')
    expect([over.statusCode, over.json().screenshot]).toEqual([201, 'not_kept'])
    for (let i = 0; i < ERROR_BUDGETS.reportsPerIpDay; i++) await report({ description: `f${i}`, event: crash() }, undefined, '198.51.100.41')
    const spent = await report({ description: 'x', event: crash(), screenshot: { type: 'image/png', data: junk } }, undefined, '198.51.100.41')
    expect(spent.statusCode).toBe(429)
  })

  it('a report clears the cached prompt facts, so the third description turns asks into "we know"', async () => {
    const event = { kind: 'api', t: Date.now(), route: '/scenes', method: 'PUT', path: '/api/scenes/x', status: 500, userFacing: true }
    const prompt = () => app.inject({ method: 'POST', url: '/api/errors/prompt', payload: { v: 1, event } })
    expect((await prompt()).json().prompt).toBe('ask')
    for (let i = 0; i < 3; i++) await report({ description: `d${i}`, event }, undefined, `198.51.100.${20 + i}`)
    expect((await prompt()).json()).toMatchObject({ prompt: 'known', facts: { reports: 3 } })
  })

  it('deletes screenshots after 30 days, keeping the report', async () => {
    const data = (await png()).toString('base64')
    await report({ description: 'old one', event: crash(), screenshot: { type: 'image/png', data } })
    const [r] = await db.select().from(errorReports)
    await purgeErrors(new Date(Date.now() + 31 * 86_400_000))
    const [after] = await db.select().from(errorReports)
    expect(after.id).toBe(r.id)
    expect(after.screenshotKey).toBeNull()
    expect(store.keys()).toEqual([])
  })
})
