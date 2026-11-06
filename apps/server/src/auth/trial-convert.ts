import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { users, userAuthMethods, studioUsageDays } from '../db/schema.js'
import { config } from '../config.js'
import { moveStudioData } from '../studio/merge.js'
import { TRIAL_DAY } from '../studio/quota.js'
import { issueAccountSession } from './sessions.js'

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
export async function mergeTrial(trialId: string, accountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Only a row that is still a trial merges (a second sign-in with the same old token finds nothing to move).
    const [trial] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, trialId), eq(users.isTrial, true))).for('update')
    if (!trial) return
    // The trial's allowance is not the account's: drop it instead of adding it to the account's counters.
    await tx.delete(studioUsageDays).where(and(eq(studioUsageDays.userId, trialId), eq(studioUsageDays.day, TRIAL_DAY)))
    await moveStudioData(tx, trialId, accountId, new Date())
    await tx.delete(studioUsageDays).where(eq(studioUsageDays.userId, trialId))
    await tx.delete(users).where(eq(users.id, trialId))
  })
}

export interface OAuthIdentity {
  type: 'oauth'
  identifier: string
  email: string | null
  displayName: string
  metadata: object
}

/** The trial a claim ticket names, if the ticket is ours, unexpired, and the trial still exists. */
async function trialFromTicket(app: FastifyInstance, claim: string | undefined): Promise<string | null> {
  if (!claim) return null
  try {
    const c = app.jwt.verify<{ id?: string; kind?: string }>(claim)
    if (c.kind !== 'trial_claim' || !c.id) return null
    const [row] = await db.select({ isTrial: users.isTrial }).from(users).where(eq(users.id, c.id)).limit(1)
    return row?.isTrial ? c.id : null
  } catch {
    return null
  }
}

/**
 * The end of a Google or Discord sign-in: finds or creates the account for this identity and answers with its session.
 * A valid claim ticket turns the visitor's trial into the new account, or moves it into the existing one.
 */
export async function finishOAuth(app: FastifyInstance, identity: OAuthIdentity, claim: string | undefined) {
  const trialId = await trialFromTicket(app, claim)
  const existing = await db.query.userAuthMethods.findFirst({
    where: and(eq(userAuthMethods.type, 'oauth'), eq(userAuthMethods.identifier, identity.identifier)),
    with: { user: true },
  })

  if (existing) {
    if (trialId) await mergeTrial(trialId, existing.userId)
    return issueAccountSession(app, existing.user)
  }

  const email = identity.email?.toLowerCase() || null
  if (trialId) {
    try {
      const user = await db.transaction(async (tx) => {
        const converted = await convertTrial(trialId, { email, displayName: identity.displayName }, tx)
        await tx.insert(userAuthMethods).values({ userId: trialId, type: 'oauth', identifier: identity.identifier, metadata: identity.metadata })
        return converted
      })
      return issueAccountSession(app, user)
    } catch (err) {
      if ((err as Error).message !== 'trial_gone') throw err
      // The trial vanished between the check and the conversion: fall through to a normal new account.
    }
  }

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
