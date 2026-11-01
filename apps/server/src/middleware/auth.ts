import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { apiKeys, users } from '../db/schema.js'
import '../auth/scene-from.js' // FastifyContextConfig.scenePass
import { pairingLive } from '../hyperfy/pairing.js'
import { deviceLive, devicePersonal } from '../ar/devices.js'

export interface AuthUser {
  id: string
  email: string | null
  role: string
  orgId: string | null
  wallet?: string | null
  verified?: boolean
  guest?: boolean
  viaApiKey?: boolean
  kind?: 'account' | 'scene'
  sceneId?: string | null
  locationId?: string | null
  via?: 'hyperfy' | 'ar'
  pairingId?: string
  worldId?: string
  deviceId?: string
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: string; email: string | null; role: string; orgId?: string | null; wallet?: string | null; verified?: boolean; guest?: boolean; refresh?: boolean; kind?: 'account' | 'scene'; sceneId?: string | null; locationId?: string | null; via?: 'hyperfy' | 'ar'; pairingId?: string; worldId?: string; deviceId?: string }
    user: AuthUser
  }
}

/**
 * Fastify preHandler that verifies the JWT from the Authorization header
 * and attaches the decoded user to request.user.
 *
 * Also supports API key authentication via `Bearer virvi_...` tokens.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' })
    }

    const token = authHeader.slice(7)

    // ── API Key auth ──────────────────────────────────────────────────────
    if (token.startsWith('virvi_')) {
      const keyHash = createHash('sha256').update(token).digest('hex')

      const [apiKey] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1)

      if (!apiKey) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid API key' })
      }

      // Check expiry
      if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'API key has expired' })
      }

      // Look up the user
      const user = await db.query.users.findFirst({
        where: eq(users.id, apiKey.userId),
      })

      if (!user) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'API key owner not found' })
      }

      // Update lastUsedAt (fire-and-forget)
      db.update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, apiKey.id))
        .then(() => {})
        .catch(() => {})

      request.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        orgId: apiKey.orgId ?? user.activeOrgId ?? null,
        kind: 'account',
        verified: true,
        viaApiKey: true,
      }
      return
    }

    // ── JWT auth (default) ────────────────────────────────────────────────
    const decoded = await request.jwtVerify<AuthUser & { refresh?: boolean }>()
    if (decoded.refresh) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Refresh tokens cannot access the API' })
    }
    if (decoded.guest) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Guest tokens cannot access the API' })
    }
    if (decoded.kind !== 'account' && decoded.kind !== 'scene') {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Session expired — sign in again' })
    }
    request.user = decoded
    if (decoded.via === 'hyperfy' && !(decoded.pairingId && (await pairingLive(decoded.pairingId)))) {
      return reply.status(401).send({ error: 'pairing_revoked' })
    }
    // Default deny for Hyperfy passes too: only routes that opt in (the HUD's) take one.
    if (decoded.via === 'hyperfy' && request.routeOptions.config?.scenePass && !request.routeOptions.config.scenePass.hyperfy) {
      return reply.status(403).send({ error: 'hyperfy_pass_not_allowed' })
    }
    // An AR pass lives only as long as its headset, and works only on the routes the headset uses (`ar: true`).
    if (decoded.via === 'ar' && !(decoded.deviceId && (await deviceLive(decoded.deviceId)))) {
      return reply.status(401).send({ error: 'device_revoked' })
    }
    if (decoded.via === 'ar' && !request.routeOptions.config?.scenePass?.ar) {
      return reply.status(403).send({ error: 'ar_pass_not_allowed' })
    }
    // `ar: 'personal'` routes (the builder's own) take a personal headset's pass only, as room scans do.
    if (decoded.via === 'ar' && request.routeOptions.config?.scenePass?.ar === 'personal' && !(await devicePersonal(decoded.deviceId))) {
      return reply.status(403).send({ error: 'personal_only' })
    }
    if (decoded.kind === 'scene') {
      // Default deny: a scene pass works only on routes that declare how to find their scene,
      // and only when that scene is the pass's own. A resolver error refuses too (never 401/pass-through).
      const sceneFrom = request.routeOptions.config?.scenePass?.sceneFrom
      let target: string | null = null
      if (sceneFrom && decoded.sceneId) {
        try {
          target = await sceneFrom(request)
        } catch {
          target = null
        }
      }
      if (!decoded.sceneId || !target || target !== decoded.sceneId) {
        return reply.status(403).send({ error: 'scene_pass_not_allowed' })
      }
    }
  } catch (err) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' })
  }
}

/**
 * Register the JWT plugin on a Fastify instance.
 */
export function registerJwt(app: FastifyInstance, secret: string) {
  return app.register(import('@fastify/jwt'), {
    secret,
    sign: { expiresIn: '15m' },
  })
}
