import type { FastifyInstance } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { authHandoffCodes, users } from '../db/schema.js'
import { actorFromClaims } from '../auth/actor.js'
import { authenticate } from '../middleware/auth.js'
import { boundScene, isScenePass, isStudioPass } from '../auth/scene-from.js'
import { linkWalletGrants } from '../auth/permissions.js'
import { issueWalletSession } from '../auth/sessions.js'
import { issueScenePass } from '../auth/scene-pass.js'
import { TokenBucketLimiter } from '../analytics/limiter.js'

const CODE_TTL_MS = 60_000
/** randomBytes(32) in base64url is always 43 characters. */
const CODE_RE = /^[A-Za-z0-9_-]{43}$/
const CREATE_LIMIT = { capacity: 5, refillPerSec: 5 / 60 }
const EXCHANGE_LIMIT = { capacity: 20, refillPerSec: 20 / 60 }
const EXPIRED = { error: 'This sign-in link has expired' }

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex')

/** Delete hand-off codes that expired more than a day ago (daily job). */
export async function purgeAuthHandoffCodes(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 86_400_000)
  const rows = await db.delete(authHandoffCodes).where(lt(authHandoffCodes.expiresAt, cutoff)).returning({ h: authHandoffCodes.codeHash })
  return rows.length
}

/**
 * In-world sign-in hand-off: the HUD trades its verified-wallet token for a single-use 60 s code,
 * and the website exchanges that code for a normal wallet session. The studio scene's pass gets a 10-minute
 * code instead (the checkout link). Codes are secrets: only their
 * sha256 is stored and they are never logged.
 */
export default async function authHandoffRoutes(app: FastifyInstance) {
  const limiter = new TokenBucketLimiter()

  // No `hyperfy` opt-in: a Hyperfy pass is tied to a revocable pairing, and the exchanged session would outlive a revoke.
  // `studio`: the studio scene's pass mints the one-time checkout link instead, an account code that lives 10 minutes.
  app.post('/api/auth/handoff', { preHandler: authenticate, config: { scenePass: { sceneFrom: boundScene, studio: true } } }, async (request, reply) => {
    const actor = actorFromClaims(request.user)
    if (!actor.userId || !actor.verified || !actor.wallet) {
      return reply.status(401).send({ error: 'Sign-in hand-off needs a verified wallet' })
    }
    const checkout = isStudioPass(request.user)
    // Checkout links have their own budget, apart from the HUD's sign-in codes.
    const limit = limiter.take(`handoff:${checkout ? 'studio_checkout:' : ''}${actor.userId}`, 1, CREATE_LIMIT.capacity, CREATE_LIMIT.refillPerSec)
    if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })

    const code = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + (checkout ? config.studioCheckoutLinkMs : CODE_TTL_MS))
    // A studio pass's code is an account code (the owner's call): the website gets a full wallet session to check out in.
    const scene = isScenePass(request.user) && !checkout
    await db.transaction(async (tx) => {
      await tx.delete(authHandoffCodes).where(and(eq(authHandoffCodes.userId, actor.userId!), lt(authHandoffCodes.expiresAt, sql`now()`)))
      await tx.insert(authHandoffCodes).values({ codeHash: hashCode(code), userId: actor.userId!, wallet: actor.wallet!,
        expiresAt,
        kind: scene ? 'scene' : 'account',
        sceneId: scene ? request.user.sceneId ?? null : null,
        locationId: scene ? request.user.locationId ?? null : null,
        // A code must not renew a pass: the exchanged pass expires when this one does.
        passExpiresAt: scene ? new Date(((request.user as { exp?: number }).exp ?? 0) * 1000) : null,
      })
    })
    return reply.send({ code, expiresAt: expiresAt.toISOString() })
  })

  app.post<{ Body: { code?: unknown } }>('/api/auth/handoff/exchange', async (request, reply) => {
    const limit = limiter.take(`handoff-exchange:${request.ip}`, 1, EXCHANGE_LIMIT.capacity, EXCHANGE_LIMIT.refillPerSec)
    if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })

    const code = request.body?.code
    if (typeof code !== 'string' || !CODE_RE.test(code)) return reply.status(410).send(EXPIRED)

    // Single use, atomically: only one request can flip used_at on a live code. Live by the app's clock, which set expiresAt.
    const [claimed] = await db
      .update(authHandoffCodes)
      .set({ usedAt: sql`now()` })
      .where(and(eq(authHandoffCodes.codeHash, hashCode(code)), isNull(authHandoffCodes.usedAt), gt(authHandoffCodes.expiresAt, new Date())))
      .returning({ userId: authHandoffCodes.userId, wallet: authHandoffCodes.wallet, kind: authHandoffCodes.kind, sceneId: authHandoffCodes.sceneId, locationId: authHandoffCodes.locationId, passExpiresAt: authHandoffCodes.passExpiresAt })
    if (!claimed) return reply.status(410).send(EXPIRED)

    const user = await db.query.users.findFirst({ where: eq(users.id, claimed.userId) })
    if (!user) return reply.status(410).send(EXPIRED)
    // A pass-minted code carries the same pass (same scene, same location) — never an account session.
    if (claimed.kind === 'scene') {
      if (!claimed.passExpiresAt || claimed.passExpiresAt.getTime() <= Date.now()) return reply.status(410).send(EXPIRED)
      return reply.send(issueScenePass(app, user, claimed.wallet, { sceneId: claimed.sceneId, locationId: claimed.locationId }, claimed.passExpiresAt))
    }
    await linkWalletGrants(user.id, claimed.wallet)
    return reply.send(issueWalletSession(app, user, claimed.wallet))
  })
}
