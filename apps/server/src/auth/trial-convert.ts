import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { users, userAuthMethods, studioUsageDays } from '../db/schema.js'
import { config } from '../config.js'
import { moveStudioData } from '../studio/merge.js'
import { TRIAL_DAY } from '../studio/quota.js'
import { issueAccountSession } from './sessions.js'
import { recordTrialEvent, cleanAction } from './trial-events.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type User = typeof users.$inferSelect

/** The trial user id of a valid trial access token in `Authorization` whose row is still a trial, else null. */
export async function trialFromBearer(app: FastifyInstance, request: FastifyRequest): Promise<string | null> {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  let claims: { id?: string; kind?: string; refresh?: boolean }
  try {
    claims = app.jwt.verify(auth.slice(7))
  } catch {
    return null
  }
  if (claims.kind !== 'trial' || claims.refresh || !claims.id) return null
  const [row] = await db.select({ isTrial: users.isTrial }).from(users).where(eq(users.id, claims.id)).limit(1)
  return row?.isTrial ? claims.id : null
}

/**
 * True when `Authorization` carries a trial access token that fails verification (ran out, most often).
 * Sign-up and sign-in answer 401 `trial_expired` for it instead of ignoring it, so the web app renews and
 * retries rather than making a separate account and leaving the trial's work behind.
 */
export function expiredTrialBearer(app: FastifyInstance, request: FastifyRequest): boolean {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) return false
  const token = auth.slice(7)
  const claims = (() => { try { return app.jwt.decode<{ kind?: string; refresh?: boolean }>(token) } catch { return null } })()
  if (claims?.kind !== 'trial' || claims.refresh) return false
  try {
    app.jwt.verify(token)
    return false
  } catch {
    return true
  }
}

/** A preHandler: 401 `trial_expired` for a trial bearer that fails verification (see `expiredTrialBearer`). */
export function refuseExpiredTrial(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (expiredTrialBearer(app, request)) return reply.status(401).send({ error: 'trial_expired' })
  }
}

/** The trial becomes a normal account (same id, keeps everything); its trial prompts are dropped so the Free day starts full. */
export async function convertTrial(trialId: string, set: { email?: string | null; displayName: string }, tx?: Tx): Promise<User> {
  const run = async (t: Tx) => {
    const [user] = await t
      .update(users)
      .set({ isTrial: false, trialLastActiveAt: null, displayName: set.displayName, ...(set.email !== undefined ? { email: set.email } : {}), updatedAt: new Date() })
      .where(and(eq(users.id, trialId), eq(users.isTrial, true)))
      .returning()
    if (!user) throw new Error('trial_gone')
    await t.delete(studioUsageDays).where(and(eq(studioUsageDays.userId, trialId), eq(studioUsageDays.day, TRIAL_DAY)))
    return user
  }
  return tx ? run(tx) : db.transaction(run)
}

/** The trial's work moves into an existing account and the trial is deleted. */
export async function mergeTrial(trialId: string, accountId: string, fromAction?: unknown): Promise<boolean> {
  const merged = await db.transaction(async (tx) => {
    // Only a row that is still a trial merges (a second sign-in with the same old token finds nothing to move).
    const [trial] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, trialId), eq(users.isTrial, true))).for('update')
    if (!trial) return false
    // The trial's allowance is not the account's: drop it instead of adding it to the account's counters.
    await tx.delete(studioUsageDays).where(and(eq(studioUsageDays.userId, trialId), eq(studioUsageDays.day, TRIAL_DAY)))
    await moveStudioData(tx, trialId, accountId, new Date())
    await tx.delete(studioUsageDays).where(eq(studioUsageDays.userId, trialId))
    await tx.delete(users).where(eq(users.id, trialId))
    return true
  })
  if (merged) recordTrialEvent('signed_up', trialId, cleanAction(fromAction))
  return merged
}

export interface OAuthIdentity {
  type: 'oauth'
  identifier: string
  email: string | null
  displayName: string
  metadata: object
}

/**
 * The trial a token held by this browser names: a trial access or refresh token we signed, expired or not (the session in
 * the browser is the proof), whose row is still a trial. Else null.
 */
export async function trialFromHeldToken(app: FastifyInstance, token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || !token) return null
  let claims: { id?: string; kind?: string }
  try {
    claims = app.jwt.verify(token, { ignoreExpiration: true } as never)
  } catch {
    return null
  }
  if (claims.kind !== 'trial' || !claims.id) return null
  const [row] = await db.select({ isTrial: users.isTrial, at: users.trialLastActiveAt }).from(users).where(eq(users.id, claims.id)).limit(1)
  // A trial idle past its expiry may be mid-sweep (machines and files going): let it go rather than move half of it
  const cutoff = Date.now() - config.trialIdleDays * 24 * 3600_000
  return row?.isTrial && row.at && row.at.getTime() >= cutoff ? claims.id : null
}

/**
 * The end of a Google or Discord sign-in: finds or creates the account for this identity and answers with its session.
 * A trial is never carried through the provider (a crafted link could hand someone else's trial to the victim): the web
 * app's callback page moves the trial it holds with POST /api/auth/trial/adopt.
 */
export async function finishOAuth(app: FastifyInstance, identity: OAuthIdentity) {
  const existing = await db.query.userAuthMethods.findFirst({
    where: and(eq(userAuthMethods.type, 'oauth'), eq(userAuthMethods.identifier, identity.identifier)),
    with: { user: true },
  })
  if (existing) return issueAccountSession(app, existing.user)

  const email = identity.email?.toLowerCase() || null
  // Auto-promote the first user to admin in single/scalable mode
  let role: 'admin' | 'creator' = 'creator'
  if (config.autoPromoteFirstUser) {
    const anyUser = await db.query.users.findFirst()
    if (!anyUser) role = 'admin'
  }
  const [newUser] = await db.insert(users).values({ displayName: identity.displayName, email, role }).returning()
  await db.insert(userAuthMethods).values({ userId: newUser.id, type: 'oauth', identifier: identity.identifier, metadata: identity.metadata })
  return issueAccountSession(app, newUser)
}
