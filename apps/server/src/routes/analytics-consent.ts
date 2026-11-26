import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { isPrivacyDecision, locationKeyFor, validateSceneRef } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { analyticsScenes } from '../db/schema.js'
import { hasDclAuthHeaders, verifyDclSignedFetch } from '../middleware/dcl-auth.js'
import { StaleConsentError, consentStatus, consentSubject, isWalletShaped, recordConsent } from '../analytics/consent.js'

const PLATFORMS = new Set(['decentraland', 'hyperfy', 'ar', 'web'])

/** The request's verified wallet when it is a valid Decentraland signed fetch, else null (as /api/ingest decides). */
async function signerOf(request: FastifyRequest): Promise<string | null> {
  const headers = request.headers as Record<string, string | string[] | undefined>
  if (!hasDclAuthHeaders(headers)) return null
  try {
    return (await verifyDclSignedFetch(request.method, request.url.split('?')[0], headers)).walletAddress.toLowerCase()
  } catch {
    return null
  }
}

const visitorIdOf = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 100 ? v : null)

/** An unsigned request may decide only for a guest id, never for a wallet (the collector then treats it as no decision). */
const signatureRequired = { error: 'signature_required', message: 'Sign the request to read or record a decision for a wallet.' }

/**
 * The scene visitor notice (GDPR notice): a visitor's decision on Virvi's analytics, one for every Virvi scene. Under the
 * scene's analytics auth, as /api/ingest: a signed fetch decides as its wallet, anything else as the visitor id it
 * sends (a guest). The analytics collector calls these; nothing here returns or logs a wallet or a visitor id.
 */
export default async function analyticsConsentRoutes(app: FastifyInstance) {
  // warn: keep per-request logs (which include the client IP and the visitor id in the query) out of the logs
  const opts = { logLevel: 'warn' as const }

  app.get<{ Querystring: { visitorId?: string } }>('/api/analytics/consent', opts, async (request, reply) => {
    const signer = await signerOf(request)
    const visitorId = visitorIdOf(request.query?.visitorId)
    if (!signer && !visitorId) return reply.status(400).send({ error: 'visitorId is required' })
    if (!signer && isWalletShaped(visitorId!)) return reply.status(401).send(signatureRequired)
    return reply.send(await consentStatus(consentSubject(signer, signer ?? visitorId!)))
  })

  app.post<{ Body: { decision?: unknown; version?: unknown; visitorId?: unknown; scene?: unknown; platform?: unknown } }>(
    '/api/analytics/consent', opts, async (request, reply) => {
      const body = request.body && typeof request.body === 'object' ? request.body : {}
      if (!isPrivacyDecision(body.decision)) return reply.status(400).send({ error: 'decision must be accept or decline' })
      const signer = await signerOf(request)
      const visitorId = visitorIdOf(body.visitorId)
      if (!signer && !visitorId) return reply.status(400).send({ error: 'visitorId is required' })
      if (!signer && isWalletShaped(visitorId!)) return reply.status(401).send(signatureRequired)
      const subject = consentSubject(signer, signer ?? visitorId!)
      // Where it was given: the analytics location, when Virvi already knows it (never created from here)
      const ref = validateSceneRef(body.scene)
      const scene = ref
        ? await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, locationKeyFor(ref, signer)), columns: { id: true } })
        : undefined
      const platform = typeof body.platform === 'string' && PLATFORMS.has(body.platform) ? body.platform : 'decentraland'
      try {
        await recordConsent({ subject, decision: body.decision, version: body.version, sceneId: scene?.id ?? null, platform })
      } catch (err) {
        if (!(err instanceof StaleConsentError)) throw err
        return reply.status(400).send({ error: 'stale_version', message: err.message, ...(await consentStatus(subject)) })
      }
      return reply.send(await consentStatus(subject))
    },
  )
}
