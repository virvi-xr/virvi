import type { FastifyInstance } from 'fastify'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '../db/connection.js'
import { users } from '../db/schema.js'
import { config } from '../config.js'
import { sha256 } from '../auth/hash.js'
import { issueTrialSession, trialIpKey } from '../auth/trial.js'
import { authenticate } from '../middleware/auth.js'
import { mergeTrial, trialFromHeldToken } from '../auth/trial-convert.js'
import { recordTrialEvent } from '../auth/trial-events.js'
import { trialsAvailable, verifyTurnstile } from '../auth/turnstile.js'

const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/
/** Where the trial started (`/try` or `/try/scene`), kept on its `started` funnel row. */
const ENTRIES = new Set(['studio', 'scene'])

export default async function trialRoutes(app: FastifyInstance) {
  // Start a signed-out trial (Design Studio or scene builder): bot check, per-IP and per-device daily limits, then a trial
  // user + session. `entry` ('studio' | 'scene') is recorded on the funnel; anything else is ignored.
  app.post<{ Body: { turnstileToken?: string; deviceId?: string; entry?: unknown } }>(
    '/api/auth/trial',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { turnstileToken, deviceId, entry } = request.body ?? {}
      if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return reply.status(400).send({ error: 'bad_device' })
      if (!trialsAvailable()) return reply.status(503).send({ error: 'trials_unavailable' })
      if (!(await verifyTurnstile(typeof turnstileToken === 'string' ? turnstileToken : undefined, request.ip))) {
        return reply.status(403).send({ error: 'bot_check_failed' })
      }

      const ipHash = sha256(trialIpKey(request.ip))
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
      recordTrialEvent('started', user.id, typeof entry === 'string' && ENTRIES.has(entry) ? entry : null)
      return reply.status(201).send(issueTrialSession(app, user))
    },
  )

  // Back from Google or Discord: the browser that held the trial moves it into the account it just signed in to. The trial
  // token in the body is the proof (a crafted sign-in link can't put one in someone else's browser). Account bearers only.
  app.post<{ Body: { trialToken?: unknown; fromAction?: string } }>(
    '/api/auth/trial/adopt',
    { preHandler: [authenticate], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const trialId = await trialFromHeldToken(app, request.body?.trialToken)
      if (!trialId || trialId === request.user.id) return reply.send({ moved: false })
      const moved = await mergeTrial(trialId, request.user.id, request.body?.fromAction)
      return reply.send({ moved })
    },
  )
}
