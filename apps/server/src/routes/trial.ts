import type { FastifyInstance } from 'fastify'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '../db/connection.js'
import { users } from '../db/schema.js'
import { config } from '../config.js'
import { sha256 } from '../auth/hash.js'
import { issueTrialSession } from '../auth/trial.js'
import { authenticate } from '../middleware/auth.js'
import { recordTrialEvent, cleanAction } from '../auth/trial-events.js'
import { trialsAvailable, verifyTurnstile } from '../auth/turnstile.js'

const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/

export default async function trialRoutes(app: FastifyInstance) {
  // Start a signed-out Design Studio trial: bot check, per-IP and per-device daily limits, then a trial user + session.
  app.post<{ Body: { turnstileToken?: string; deviceId?: string } }>(
    '/api/auth/trial',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { turnstileToken, deviceId } = request.body ?? {}
      if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return reply.status(400).send({ error: 'bad_device' })
      if (!trialsAvailable()) return reply.status(503).send({ error: 'trials_unavailable' })
      if (!(await verifyTurnstile(typeof turnstileToken === 'string' ? turnstileToken : undefined, request.ip))) {
        return reply.status(403).send({ error: 'bot_check_failed' })
      }

      const ipHash = sha256(request.ip)
      const deviceHash = sha256(deviceId)
      const now = new Date()
      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      const countToday = async (col: AnyPgColumn, hash: string) => {
        const [row] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(users)
          .where(and(eq(col, hash), gte(users.createdAt, dayStart)))
        return row?.n ?? 0
      }
      if ((await countToday(users.trialIpHash, ipHash)) >= config.trialPerIpDay || (await countToday(users.trialDeviceHash, deviceHash)) >= config.trialPerDeviceDay) {
        return reply.status(429).send({ error: 'trial_limit' })
      }

      const [user] = await db
        .insert(users)
        .values({ displayName: 'Guest', email: null, role: 'creator', isTrial: true, trialLastActiveAt: now, trialIpHash: ipHash, trialDeviceHash: deviceHash })
        .returning()
      recordTrialEvent('started', user.id)
      return reply.status(201).send(issueTrialSession(app, user))
    },
  )

  // A ticket that carries the visitor's trial through a Google or Discord sign-in (OAuth `state`); 10 minutes.
  app.post<{ Body: { fromAction?: string } }>('/api/auth/trial/claim', { preHandler: authenticate, config: { trial: true } }, async (request, reply) => {
    if (!request.user.trial) return reply.status(403).send({ error: 'not_a_trial' })
    const fromAction = cleanAction(request.body?.fromAction)
    const ticket = app.jwt.sign({ id: request.user.id, kind: 'trial_claim', ...(fromAction ? { fromAction } : {}) } as unknown as Parameters<typeof app.jwt.sign>[0], { expiresIn: '10m' })
    return reply.send({ ticket })
  })
}
