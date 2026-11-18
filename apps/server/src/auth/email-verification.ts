import crypto from 'node:crypto'
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { emailVerificationTokens, users } from '../db/schema.js'
import { config } from '../config.js'
import { sendVerifyEmail } from '../services/email.js'

/**
 * Email verification (LIV-161). An account's email is trusted (to match invites to it) only once a link sent to it
 * has been opened, or a provider that verifies email (Google, Discord) said so. The account works either way.
 */

export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60_000
export const RESEND_GAP_MS = 60_000
export const RESENDS_PER_DAY = 5

export class EmailVerifyError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterSec?: number) {
    super(message)
  }
}

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex')
export const verifyLink = (token: string) => `${config.publicUrl}/auth/verify-email?token=${encodeURIComponent(token)}`
const norm = (e: string) => e.trim().toLowerCase()

/** Stores a new link for the address and returns its token (only the hash is kept). */
async function createLink(userId: string, email: string, now: Date): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url')
  await db.insert(emailVerificationTokens).values({
    userId, email: norm(email), tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + EMAIL_VERIFY_TTL_MS), createdAt: now,
  })
  return token
}

async function mailLink(email: string, token: string): Promise<void> {
  try {
    await sendVerifyEmail(norm(email), verifyLink(token))
  } catch (err) {
    console.error('[virvi-auth] verification email failed:', err instanceof Error ? err.message : err)
  }
}

/** Makes a link for the account's email and mails it (sign-up); a send failure is logged, never thrown. */
export async function sendVerification(userId: string, email: string, now = new Date()): Promise<void> {
  await mailLink(email, await createLink(userId, email, now))
}

export interface EmailStatus {
  email: string | null
  verified: boolean
  /** When another link may be sent; null when one may be sent now (or never: no email, or verified). */
  nextResendAt: string | null
}

async function limits(userId: string, now: Date): Promise<{ next: Date | null; daily: boolean }> {
  const [last] = await db.select({ at: emailVerificationTokens.createdAt }).from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.userId, userId)).orderBy(desc(emailVerificationTokens.createdAt)).limit(1)
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000)
  const recent = await db.select({ at: emailVerificationTokens.createdAt }).from(emailVerificationTokens)
    .where(and(eq(emailVerificationTokens.userId, userId), gte(emailVerificationTokens.createdAt, dayAgo)))
    .orderBy(emailVerificationTokens.createdAt)
  if (recent.length >= RESENDS_PER_DAY) return { next: new Date(recent[recent.length - RESENDS_PER_DAY].at.getTime() + 24 * 60 * 60_000), daily: true }
  if (last && now.getTime() - last.at.getTime() < RESEND_GAP_MS) return { next: new Date(last.at.getTime() + RESEND_GAP_MS), daily: false }
  return { next: null, daily: false }
}

export async function emailStatus(userId: string, now = new Date()): Promise<EmailStatus> {
  const [u] = await db.select({ email: users.email, at: users.emailVerifiedAt }).from(users).where(eq(users.id, userId))
  if (!u?.email) return { email: null, verified: false, nextResendAt: null }
  if (u.at) return { email: u.email, verified: true, nextResendAt: null }
  const { next } = await limits(userId, now)
  return { email: u.email, verified: false, nextResendAt: next?.toISOString() ?? null }
}

/** "Resend the link": at most once a minute and 5 a day (counting the sign-up email). */
export async function resendVerification(userId: string, now = new Date()): Promise<EmailStatus> {
  const [u] = await db.select({ email: users.email, at: users.emailVerifiedAt, isTrial: users.isTrial }).from(users).where(eq(users.id, userId))
  if (!u?.email || u.isTrial) throw new EmailVerifyError(400, 'no_email', 'This account has no email address to confirm.')
  if (u.at) throw new EmailVerifyError(409, 'already_verified', 'Your email is already confirmed.')
  // One request at a time per account, so two quick clicks can't both pass the limits
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'email-verify:' + userId}))`)
    const { next, daily } = await limits(userId, now)
    if (next) {
      const sec = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000))
      throw daily
        ? new EmailVerifyError(429, 'daily_limit', 'You can send 5 confirmation links a day. Try again tomorrow.', sec)
        : new EmailVerifyError(429, 'too_soon', 'Wait a minute before sending another link.', sec)
    }
    return createLink(userId, u.email!, now)
  }).then(async (token) => {
    await mailLink(u.email!, token)
    return emailStatus(userId, now)
  })
}

/** Opens a link: verifies the email it was sent to, once, within 24 hours, while that is still the account's email. */
export async function verifyEmailToken(token: unknown, now = new Date()): Promise<{ email: string }> {
  if (typeof token !== 'string' || !token || token.length > 200) throw new EmailVerifyError(400, 'invalid_link', 'This link isn\'t valid.')
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(emailVerificationTokens).where(eq(emailVerificationTokens.tokenHash, hashToken(token))).for('update')
    if (!row) throw new EmailVerifyError(400, 'invalid_link', 'This link isn\'t valid.')
    if (row.usedAt) throw new EmailVerifyError(400, 'used_link', 'This link has already been used.')
    if (row.expiresAt <= now) throw new EmailVerifyError(400, 'expired_link', 'This link has expired. Send a new one from Settings.')
    const [u] = await tx.select({ email: users.email }).from(users).where(eq(users.id, row.userId))
    if (!u?.email || norm(u.email) !== row.email) throw new EmailVerifyError(400, 'email_changed', 'This link is for an email address the account no longer uses.')
    await tx.update(emailVerificationTokens).set({ usedAt: now }).where(and(eq(emailVerificationTokens.userId, row.userId), isNull(emailVerificationTokens.usedAt)))
    await tx.update(users).set({ emailVerifiedAt: now, updatedAt: now }).where(and(eq(users.id, row.userId), isNull(users.emailVerifiedAt)))
    return { email: row.email }
  })
}

/** A password reset link proves the address too: it was mailed there. Only while it is still the account's email. */
export async function markVerifiedByReset(userId: string, email: string, now = new Date()): Promise<void> {
  await db.update(users).set({ emailVerifiedAt: now }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt), sql`lower(trim(${users.email})) = ${norm(email)}`))
}

