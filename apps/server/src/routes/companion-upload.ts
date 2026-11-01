/**
 * Companion Upload Routes — Phone-to-world asset upload via short-lived tokens.
 *
 * Authenticated (HUD/dashboard):
 *   POST /api/upload-tokens               — Create a short-lived upload token
 *
 * Token-authenticated (no JWT needed — the code IS the auth):
 *   GET  /api/upload/:code                — Validate token (returns expiry, remaining uploads, allowed kinds)
 *   GET  /api/upload/:code/qr.png         — QR code of the token's upload page link
 *   POST /api/upload/:code/start          — Announce a file: checks it, records it as 'uploading', spends one upload
 *   POST /api/upload/:code/:assetId       — Send that file's bytes (base64)
 */

import { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { eq, and, gt, sql } from 'drizzle-orm'
import QRCode from 'qrcode'
import { db } from '../db/connection.js'
import { mediaAssets, uploadTokens, users } from '../db/schema.js'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims, type Actor } from '../auth/actor.js'
import { getSceneAccess, hasScope } from '../auth/permissions.js'
import { fromBody } from '../auth/scene-from.js'
import { linkToScene, uploadDestination } from '../library/scene-library.js'
import { publishLibraryChanged } from '../realtime/bus.js'
import { reserveMedia, fillMedia, StoreMediaError } from '../media/store.js'
import { classifyUpload } from '../storage/upload-policy.js'

const KINDS = ['image', 'model', 'video'] as const
type UploadKind = (typeof KINDS)[number]

/** The kind of a classified (allowlisted) content type. */
function kindOf(contentType: string): UploadKind {
  if (contentType === 'model/gltf-binary') return 'model'
  return contentType.startsWith('video/') ? 'video' : 'image'
}

const uploadUrlFor = (code: string) => `${config.webAppUrl}/u/${code}`

/** A live (unexpired) token by code, or null. */
async function liveToken(code: string) {
  const token = await db.query.uploadTokens.findFirst({
    where: and(eq(uploadTokens.code, code), gt(uploadTokens.expiresAt, new Date())),
  })
  return token ?? null
}

/** The minter as they are now: role read fresh, wallet and verification as they signed in when minting. */
async function minterActor(token: typeof uploadTokens.$inferSelect): Promise<Actor> {
  const user = await db.query.users.findFirst({ where: eq(users.id, token.userId), columns: { role: true } })
  return { userId: token.userId, role: user?.role ?? 'viewer', wallet: token.minterWallet, verified: token.minterVerified }
}

/** Generate a short alphanumeric code (6 chars, easy to type on mobile). */
function generateCode(): string {
  // Use only lowercase + digits, no ambiguous chars (0/o, 1/l)
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(6)
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('')
}

/** Integer within [min, max]; fallback when absent or not a number. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export default async function companionUploadRoutes(app: FastifyInstance) {
  // ── Create Upload Token (authenticated) ───────────────────────────────
  app.post(
    '/api/upload-tokens',
    { preHandler: [authenticate], config: { scenePass: { sceneFrom: fromBody('sceneId'), ar: 'personal' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        sceneId?: string
        maxUploads?: number
        expiresInMinutes?: number
        kinds?: unknown
      }
      const kinds = Array.isArray(body.kinds) ? KINDS.filter((k) => (body.kinds as unknown[]).includes(k)) : null
      if (kinds && kinds.length === 0) return reply.status(400).send({ error: 'kinds must include image, model or video' })
      if (body.sceneId) {
        const access = await getSceneAccess(actorFromClaims(request.user), body.sceneId).catch(() => null)
        if (!access || !hasScope(access, 'scene.edit')) return reply.status(403).send({ error: 'forbidden' })
      }

      const code = generateCode()
      const expiresInMs = clamp(body.expiresInMinutes, 1, 60, 30) * 60 * 1000
      const expiresAt = new Date(Date.now() + expiresInMs)

      const [token] = await db
        .insert(uploadTokens)
        .values({
          code,
          userId: request.user.id,
          sceneId: body.sceneId || null,
          maxUploads: clamp(body.maxUploads, 1, 50, 10),
          kinds,
          minterWallet: request.user.wallet ? request.user.wallet.toLowerCase() : null,
          minterVerified: request.user.verified === true,
          expiresAt,
        })
        .returning()

      return reply.status(201).send({
        token: {
          code,
          uploadUrl: uploadUrlFor(code),
          qrUrl: `${config.publicUrl}/api/upload/${code}/qr.png`,
          expiresAt: expiresAt.toISOString(),
          maxUploads: token.maxUploads,
        },
      })
    },
  )

  // ── Validate Token (no auth) ──────────────────────────────────────────
  app.get('/api/upload/:code', async (request, reply) => {
    const { code } = request.params as { code: string }
    const token = await liveToken(code)
    if (!token) return reply.status(404).send({ error: 'Invalid or expired upload code' })
    if (token.uploadCount >= token.maxUploads) return reply.status(410).send({ error: 'Upload limit reached' })
    return reply.send({
      valid: true,
      remainingUploads: token.maxUploads - token.uploadCount,
      expiresAt: token.expiresAt.toISOString(),
      sceneId: token.sceneId,
      kinds: token.kinds,
    })
  })

  // ── QR code of the upload page link (no auth) ─────────────────────────
  app.get('/api/upload/:code/qr.png', async (request, reply) => {
    const { code } = request.params as { code: string }
    const token = await liveToken(code)
    if (!token) return reply.status(404).send({ error: 'Invalid or expired upload code' })
    const png = await QRCode.toBuffer(uploadUrlFor(code), { margin: 2, width: 512, errorCorrectionLevel: 'M' })
    const maxAge = Math.max(0, Math.floor((token.expiresAt.getTime() - Date.now()) / 1000))
    return reply.header('Cache-Control', `public, max-age=${maxAge}`).type('image/png').send(png)
  })

  // ── Start an upload (token auth) ──────────────────────────────────────
  app.post('/api/upload/:code/start', async (request, reply) => {
    const { code } = request.params as { code: string }
    const token = await liveToken(code)
    if (!token) return reply.status(404).send({ error: 'Invalid or expired upload code' })
    if (token.uploadCount >= token.maxUploads) return reply.status(410).send({ error: 'Upload limit reached' })

    const body = (request.body ?? {}) as { filename?: string; contentType?: string; sizeBytes?: number }
    const sizeBytes = Number(body.sizeBytes)
    if (!body.filename || typeof body.contentType !== 'string' || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      return reply.status(400).send({ error: 'Missing required fields: filename, contentType, sizeBytes' })
    }
    const verdict = classifyUpload(body.filename, body.contentType, sizeBytes)
    if (verdict.ok && token.kinds && !token.kinds.includes(kindOf(verdict.contentType))) {
      return reply.status(415).send({ error: 'unsupported_type' })
    }

    // The code is the auth, so re-check the minter's access to the scene now
    let ownerId = token.userId
    let bookingId: string | null = null
    if (token.sceneId) {
      const dest = await uploadDestination(await minterActor(token), token.sceneId)
      if (!dest) return reply.status(403).send({ error: 'forbidden' })
      ownerId = dest.ownerId
      bookingId = dest.bookingId
    }

    let asset
    try {
      asset = await reserveMedia(
        ownerId,
        { filename: body.filename, contentType: body.contentType, sizeBytes, metadata: { uploadCode: code } },
        { quotaStatus: 413, quotaMessage: ownerId === token.userId ? undefined : "The scene owner's storage is full" },
      )
    } catch (err) {
      if (err instanceof StoreMediaError) return reply.status(err.status).send(err.body)
      throw err
    }

    // Spend one upload atomically (a race past the limit undoes the reservation)
    const [spent] = await db
      .update(uploadTokens)
      .set({ uploadCount: sql`${uploadTokens.uploadCount} + 1` })
      .where(and(eq(uploadTokens.id, token.id), sql`${uploadTokens.uploadCount} < ${uploadTokens.maxUploads}`))
      .returning({ uploadCount: uploadTokens.uploadCount })
    if (!spent) {
      await db.delete(mediaAssets).where(eq(mediaAssets.id, asset.id))
      return reply.status(410).send({ error: 'Upload limit reached' })
    }

    if (token.sceneId) await linkToScene(token.sceneId, { mediaAssetId: asset.id }, token.userId, bookingId)
    return reply.status(201).send({ assetId: asset.id, remainingUploads: token.maxUploads - spent.uploadCount })
  })

  // ── Send a started upload's bytes (token auth) ────────────────────────
  app.post('/api/upload/:code/:assetId', async (request, reply) => {
    const { code, assetId } = request.params as { code: string; assetId: string }
    const token = await liveToken(code)
    if (!token) return reply.status(404).send({ error: 'Invalid or expired upload code' })
    const reserved = /^[0-9a-f-]{36}$/i.test(assetId)
      ? await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, assetId) })
      : undefined
    if (!reserved || (reserved.metadata as { uploadCode?: string } | null)?.uploadCode !== code) {
      return reply.status(404).send({ error: 'Upload not found' })
    }
    const body = (request.body ?? {}) as { fileData?: string }
    if (typeof body.fileData !== 'string' || !body.fileData) return reply.status(400).send({ error: 'Missing required field: fileData' })

    // Claim it: only one data post per upload gets past 'uploading'
    const [claimed] = await db
      .update(mediaAssets)
      .set({ status: 'processing' })
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.status, 'uploading')))
      .returning({ id: mediaAssets.id })
    if (!claimed) return reply.status(409).send({ error: 'Upload already sent' })

    const announce = async () => {
      if (!token.sceneId) return
      const link = await db.query.sceneLibrary.findFirst({
        where: (l, { and: all, eq: is }) => all(is(l.sceneId, token.sceneId!), is(l.mediaAssetId, assetId)),
        columns: { id: true },
      })
      if (link) await publishLibraryChanged(token.sceneId, link.id)
    }
    await announce() // processing
    let asset
    try {
      asset = await fillMedia(assetId, Buffer.from(body.fileData, 'base64'))
    } catch (err) {
      await announce()
      if (err instanceof StoreMediaError) return reply.status(err.status).send(err.body)
      throw err
    }
    await announce()
    return reply.status(201).send({ asset })
  })
}
