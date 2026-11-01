/**
 * AR headset pairing: the headset gets a code, a Virvi user approves it on the website as personal or shared, the
 * headset claims its device id and then mints AR passes for the spaces it opens.
 *
 * POST   /api/ar/pair                — (public) Start a pairing with the sha256 of the headset's secret; returns the code
 * GET    /api/ar/pair/:code          — (account) What the approval page shows for a code
 * POST   /api/ar/pair/:code/approve  — (account) Approve a code as a personal or a shared headset
 * POST   /api/ar/pair/:code/claim    — (public, headset secret) Trade an approved code for the device id
 * POST   /api/ar/devices/:id/pass    — (public, headset secret) An AR pass for a space, or (personal headsets only) a
 *                                       whole scene, the approver can build on; body has exactly one of spaceId, sceneId
 * POST   /api/ar/devices/:id/end     — (public, headset secret) End the session (a shared headset is unpaired)
 * POST   /api/ar/devices/:id/spaces  — (public, headset secret) The spaces the approver can build on
 * POST   /api/ar/devices/:id/scenes  — (public, headset secret) The scenes the approver can build on
 * GET    /api/ar/devices             — (account) My headsets
 * DELETE /api/ar/devices/:id         — (account) Revoke one of my headsets
 *
 * Codes and secrets are credentials: never logged, never echoed except the code the caller just made. No route here
 * takes a scene pass of any kind (no scenePass config), so a pass can't approve, list or revoke headsets.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { normalizePairingCode, type ArPairApprovalInfo, type ArPairStartResponse, type ArPassResponse } from '@virvixr/shared'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { approveDevicePairing, claimDevicePairing, devicePairingForApproval, endDeviceSession, listDeviceScenes, listDeviceSpaces, listDevices, mintArPass, mintArPassForScene, revokeDevice, startDevicePairing } from '../ar/devices.js'

const SHA256_HEX = /^[0-9a-f]{64}$/i
const MAX_NAME = 64
const MAX_SECRET = 256

const approveUrlFor = (code: string) => `${config.webAppUrl}/pair/headset/${code}`

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)
const optName = (v: unknown): string | null | undefined => (v === undefined || v === null ? null : typeof v === 'string' ? v.trim().slice(0, MAX_NAME) || null : undefined)
const secretOf = (request: FastifyRequest) => str((request.body as { secret?: unknown } | undefined)?.secret, MAX_SECRET)

/** The normalized code in `:code`, or a 404 sent (null). */
function codeParam(request: FastifyRequest, reply: FastifyReply): string | null {
  const code = normalizePairingCode(String((request.params as { code?: string }).code ?? ''))
  if (!code) void reply.status(404).send({ error: 'not_found' })
  return code
}

/** Approving and managing headsets is for a signed-in account only; `authenticate` has already refused every pass. */
function accountOnly(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.user.kind !== 'account') {
    void reply.status(403).send({ error: 'account_required' })
    return false
  }
  return true
}

export default async function arDeviceRoutes(app: FastifyInstance) {
  app.post('/api/ar/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = (request.body ?? {}) as { secretHash?: unknown; deviceName?: unknown }
    const deviceName = optName(body.deviceName)
    if (typeof body.secretHash !== 'string' || !SHA256_HEX.test(body.secretHash) || deviceName === undefined) {
      return reply.status(400).send({ error: 'Missing or invalid fields: secretHash (sha256 hex), deviceName' })
    }
    const { code, codeExpiresAt } = await startDevicePairing(body.secretHash.toLowerCase(), deviceName)
    const res: ArPairStartResponse = { code, approveUrl: approveUrlFor(code), codeExpiresAt: codeExpiresAt.toISOString() }
    return reply.send(res)
  })

  app.get('/api/ar/pair/:code', { preHandler: [authenticate] }, async (request, reply) => {
    if (!accountOnly(request, reply)) return
    const code = codeParam(request, reply)
    if (!code) return
    const info = await devicePairingForApproval(code)
    if (!info) return reply.status(404).send({ error: 'not_found' })
    const res: ArPairApprovalInfo = { deviceName: info.deviceName, codeExpiresAt: info.codeExpiresAt.toISOString() }
    return reply.send(res)
  })

  app.post('/api/ar/pair/:code/approve', { preHandler: [authenticate], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!accountOnly(request, reply)) return
    const code = codeParam(request, reply)
    if (!code) return
    const kind = (request.body as { kind?: unknown } | undefined)?.kind
    if (kind !== 'personal' && kind !== 'shared') return reply.status(400).send({ error: 'Missing or invalid field: kind (personal or shared)' })
    const actor = actorFromClaims(request.user)
    // The headset will act as this account: an unverified one can't vouch for it.
    if (!actor.userId || !actor.verified) return reply.status(403).send({ error: 'unverified' })
    const result = await approveDevicePairing(code, actor, kind)
    if (result === 'expired') return reply.status(404).send({ error: 'not_found' })
    return reply.send({ result })
  })

  // A headset polls about every 2 s while its code is shown: 120 lets a few pair at once from behind one NAT.
  app.post('/api/ar/pair/:code/claim', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const code = codeParam(request, reply)
    if (!code) return
    const secret = secretOf(request)
    if (!secret) return reply.status(400).send({ error: 'Missing field: secret' })
    const result = await claimDevicePairing(code, secret)
    if (result === 'bad_secret') return reply.status(401).send({ error: 'bad_secret' })
    if (result === 'expired') return reply.status(404).send({ error: 'not_found' })
    return reply.send(result)
  })

  const deviceError = (reply: FastifyReply, error: 'bad_secret' | 'device_revoked' | 'no_access' | 'not_found' | 'personal_only') =>
    reply.status(error === 'no_access' || error === 'personal_only' ? 403 : error === 'not_found' ? 404 : 401).send({ error })

  app.post('/api/ar/devices/:id/pass', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const secret = secretOf(request)
    const { spaceId, sceneId } = (request.body ?? {}) as { spaceId?: unknown; sceneId?: unknown }
    if (!secret || (typeof spaceId === 'string') === (typeof sceneId === 'string')) {
      return reply.status(400).send({ error: 'Missing or invalid fields: secret, and exactly one of spaceId, sceneId' })
    }
    const result = typeof sceneId === 'string' ? await mintArPassForScene(app, id, secret, sceneId) : await mintArPass(app, id, secret, spaceId as string)
    if (typeof result === 'string') return deviceError(reply, result)
    const res: ArPassResponse = { pass: result.pass, passExpiresAt: result.passExpiresAt.toISOString(), sceneId: result.sceneId }
    return reply.send(res)
  })

  app.post('/api/ar/devices/:id/end', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const secret = secretOf(request)
    if (!secret) return reply.status(400).send({ error: 'Missing field: secret' })
    const result = await endDeviceSession(id, secret)
    if (result !== 'ended') return deviceError(reply, result)
    return reply.status(204).send()
  })

  app.post('/api/ar/devices/:id/spaces', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const secret = secretOf(request)
    if (!secret) return reply.status(400).send({ error: 'Missing field: secret' })
    const result = await listDeviceSpaces(id, secret)
    if (typeof result === 'string') return deviceError(reply, result)
    return reply.send(result)
  })

  app.post('/api/ar/devices/:id/scenes', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const secret = secretOf(request)
    if (!secret) return reply.status(400).send({ error: 'Missing field: secret' })
    const result = await listDeviceScenes(id, secret)
    if (typeof result === 'string') return deviceError(reply, result)
    return reply.send(result)
  })

  app.get('/api/ar/devices', { preHandler: [authenticate] }, async (request, reply) => {
    if (!accountOnly(request, reply)) return
    return reply.send(await listDevices(request.user.id))
  })

  app.delete('/api/ar/devices/:id', { preHandler: [authenticate] }, async (request, reply) => {
    if (!accountOnly(request, reply)) return
    const { id } = request.params as { id: string }
    if (!(await revokeDevice(id, request.user.id))) return reply.status(404).send({ error: 'not_found' })
    return reply.status(204).send()
  })
}
