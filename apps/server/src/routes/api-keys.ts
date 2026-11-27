import type { FastifyInstance } from 'fastify'
import { randomBytes, createHash } from 'node:crypto'
import { eq, and, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { apiKeys, organizations, orgMembers } from '../db/schema.js'
import { authenticate, isReadOnlyKey } from '../middleware/auth.js'

interface CreateKeyBody {
  name: string
  /** 'read' makes a read-only key (LIV-170); 'full' (the default) acts as the account. */
  access?: 'read' | 'full'
  orgId?: string
  expiresAt?: string // ISO date string
}

interface DeleteKeyParams {
  keyId: string
}

/** The session's org when it's still there (LIV-83: a deleted organization is no context for a new key). */
async function liveOrg(orgId: string | null | undefined): Promise<string | null> {
  if (!orgId) return null
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
  return org?.id ?? null
}

export default async function apiKeyRoutes(app: FastifyInstance) {
  // ── POST /api/keys — Create a new API key ───────────────────────────────
  // A key acts as its account, no wider: full access, or read-only (LIV-170, refused every write). A key session can't mint more keys.
  // and a key session cannot mint more keys.

  app.post<{ Body: CreateKeyBody }>(
    '/api/keys',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { name, orgId, expiresAt } = request.body
      const access = request.body.access ?? 'full'
      if (access !== 'read' && access !== 'full') return reply.status(400).send({ error: "access must be 'read' or 'full'" })

      if (request.user.viaApiKey) {
        return reply.status(403).send({ error: 'API keys cannot create API keys' })
      }

      if (!name) {
        return reply.status(400).send({ error: 'name is required' })
      }

      if (orgId) {
        const [member] = await db
          .select({ id: orgMembers.userId })
          .from(orgMembers)
          .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
          .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, request.user.id), isNull(organizations.deletedAt)))
        if (!member) return reply.status(400).send({ error: 'Not a member of that organization' })
      }

      // Generate the raw key: virvi_k1_ + 32 random hex chars
      const randomPart = randomBytes(16).toString('hex') // 32 hex chars
      const rawKey = `virvi_k1_${randomPart}`

      // Hash for storage
      const keyHash = createHash('sha256').update(rawKey).digest('hex')

      // First 8 chars for identification
      const keyPrefix = rawKey.slice(0, 8)

      const [apiKey] = await db
        .insert(apiKeys)
        .values({
          userId: request.user.id,
          orgId: orgId ?? (await liveOrg(request.user.orgId)),
          name,
          keyHash,
          keyPrefix,
          scopes: access === 'read' ? ['read'] : null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        })
        .returning()

      return reply.status(201).send({
        id: apiKey.id,
        name: apiKey.name,
        key: rawKey, // returned ONCE — not stored
        keyPrefix: apiKey.keyPrefix,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
        access,
      })
    },
  )

  // ── GET /api/keys — List user's API keys ────────────────────────────────

  app.get(
    '/api/keys',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const keys = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          lastUsedAt: apiKeys.lastUsedAt,
          expiresAt: apiKeys.expiresAt,
          createdAt: apiKeys.createdAt,
          scopes: apiKeys.scopes,
        })
        .from(apiKeys)
        .where(eq(apiKeys.userId, request.user.id))

      return reply.send({ keys: keys.map(({ scopes, ...k }) => ({ ...k, access: isReadOnlyKey(scopes) ? 'read' : 'full' })) })
    },
  )

  // ── DELETE /api/keys/:keyId — Delete an API key ─────────────────────────

  app.delete<{ Params: DeleteKeyParams }>(
    '/api/keys/:keyId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { keyId } = request.params

      const [deleted] = await db
        .delete(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, request.user.id)))
        .returning()

      if (!deleted) {
        return reply.status(404).send({ error: 'API key not found' })
      }

      return reply.send({ message: 'API key deleted' })
    },
  )
}
