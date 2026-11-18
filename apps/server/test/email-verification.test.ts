import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { emailVerificationTokens, passwordResetTokens, users } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor } from './helpers/factories.js'

// Capture the links instead of mailing them
const sent: { to: string; link: string }[] = []
const resets: { to: string; token: string }[] = []
vi.mock('../src/services/email.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/email.js')>()),
  sendVerifyEmail: async (to: string, link: string) => { sent.push({ to, link }); return true },
  sendPasswordResetEmail: async (to: string, token: string) => { resets.push({ to, token }); return true },
}))

const { verifyEmailToken, resendVerification, sendVerification, EMAIL_VERIFY_TTL_MS } = await import('../src/auth/email-verification.js')

const tokenOf = (link: string) => new URL(link).searchParams.get('token')!

describe('email verification (LIV-161)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    sent.length = 0
    resets.length = 0
    app = await testApp()
  })
  afterEach(async () => { await app.close() })

  const register = (email: string) =>
    app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'longenough1', displayName: 'Nia' } })
  const status = (accessToken: string) =>
    app.inject({ method: 'GET', url: '/api/auth/email', headers: { authorization: `Bearer ${accessToken}` } }).then((r) => r.json())
  const until = async (n: number) => { for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20)) }

  it('sign-up mails a link; opening it confirms the email once', async () => {
    const res = await register('Nia@Test.dev')
    expect(res.statusCode).toBe(201)
    const { accessToken } = res.json()
    await until(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('nia@test.dev')
    expect(sent[0].link).toMatch(/\/auth\/verify-email\?token=/)
    expect(await status(accessToken)).toMatchObject({ email: 'nia@test.dev', verified: false })
    // Only the hash is stored
    const [row] = await db.select().from(emailVerificationTokens)
    expect(row.tokenHash).not.toBe(tokenOf(sent[0].link))

    const ok = await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token: tokenOf(sent[0].link) } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ verified: true, email: 'nia@test.dev' })
    expect(await status(accessToken)).toMatchObject({ verified: true, nextResendAt: null })
    const again = await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token: tokenOf(sent[0].link) } })
    expect(again.statusCode).toBe(400)
    expect(again.json().error).toBe('used_link')
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token: 'nope' } })).json().error).toBe('invalid_link')
  })

  it('a link expires after 24 hours, and is refused once the account uses another email', async () => {
    const u = await createUser({ email: 'old@test.dev', emailVerified: false })
    const t0 = new Date('2026-11-18T00:00:00Z')
    await sendVerification(u.id, 'old@test.dev', t0)
    await expect(verifyEmailToken(tokenOf(sent[0].link), new Date(t0.getTime() + EMAIL_VERIFY_TTL_MS))).rejects.toMatchObject({ code: 'expired_link' })
    await sendVerification(u.id, 'old@test.dev', t0)
    await db.update(users).set({ email: 'new@test.dev' }).where(eq(users.id, u.id))
    await expect(verifyEmailToken(tokenOf(sent[1].link), t0)).rejects.toMatchObject({ code: 'email_changed' })
    const [after] = await db.select().from(users).where(eq(users.id, u.id))
    expect(after.emailVerifiedAt).toBeNull()
  })

  it('resend: once a minute, 5 a day counting the sign-up email; none once confirmed or without an email', async () => {
    const u = await createUser({ email: 'r@test.dev', emailVerified: false })
    const t0 = new Date('2026-11-18T00:00:00Z')
    await sendVerification(u.id, 'r@test.dev', t0) // the sign-up email
    await expect(resendVerification(u.id, new Date(t0.getTime() + 30_000))).rejects.toMatchObject({ code: 'too_soon', status: 429, retryAfterSec: 30 })
    for (let i = 1; i <= 4; i++) {
      const s = await resendVerification(u.id, new Date(t0.getTime() + i * 61_000))
      if (i < 4) expect(s.nextResendAt).toBe(new Date(t0.getTime() + i * 61_000 + 60_000).toISOString())
    }
    expect(sent).toHaveLength(5)
    await expect(resendVerification(u.id, new Date(t0.getTime() + 3_600_000))).rejects.toMatchObject({ code: 'daily_limit', status: 429 })
    // A day after the first one, one more may go
    await resendVerification(u.id, new Date(t0.getTime() + 24 * 3_600_000 + 1000))
    expect(sent).toHaveLength(6)

    const done = await createUser({ email: 'd@test.dev' })
    await expect(resendVerification(done.id)).rejects.toMatchObject({ code: 'already_verified', status: 409 })
    const none = await createUser({ email: null })
    await expect(resendVerification(none.id)).rejects.toMatchObject({ code: 'no_email', status: 400 })

    const res = await app.inject({ method: 'POST', url: '/api/auth/email/resend', headers: { authorization: `Bearer ${tokenFor(done)}` } })
    expect(res.statusCode).toBe(409)
  })

  it('a password reset link confirms the email, and reset tokens are stored only as a hash', async () => {
    const res = await register('pw@test.dev')
    const { accessToken } = res.json()
    await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'pw@test.dev' } })
    expect(resets).toHaveLength(1)
    const [row] = await db.select().from(passwordResetTokens)
    expect(row.token).not.toBe(resets[0].token)
    const ok = await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: resets[0].token, newPassword: 'evenlonger22' } })
    expect(ok.statusCode).toBe(200)
    expect(await status(accessToken)).toMatchObject({ verified: true })
    // The old plaintext lookup no longer finds it
    expect((await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: row.token, newPassword: 'evenlonger22' } })).statusCode).toBe(400)
  })

  it('a scene collaborator is added by email only when that email is confirmed', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    await createUser({ email: 'sly@test.dev', emailVerified: false })
    const h = { authorization: `Bearer ${tokenFor(owner)}` }
    const no = await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/collaborators`, headers: h, payload: { email: 'sly@test.dev', role: 'editor' } })
    expect(no.statusCode).toBe(409)
    expect(no.json().error).toBe('email_not_verified')
    await createUser({ email: 'Real@Test.dev' })
    const yes = await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/collaborators`, headers: h, payload: { email: 'real@test.dev', role: 'editor' } })
    expect(yes.statusCode).toBe(201)
  })
})
