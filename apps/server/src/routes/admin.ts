import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { eq, sql, ilike, or, count, desc } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  users,
  organizations,
  orgMembers,
  scenes,
  mediaAssets,
  subscriptions,
  catalogPacks,
  arReports,
  arSpaces,
} from '../db/schema.js'
import { listPacks } from '../catalog/packs.js'
import { hostedWorldsBlockingDelete } from '../hyperfy/hosting.js'
import { deleteImportFiles, importsGoingWith } from '../services/import/imports.js'
import { authenticate } from '../middleware/auth.js'
import { isUuid } from '../auth/scene-from.js'

/**
 * Reusable preHandler that ensures the authenticated user has the 'admin' role.
 * Must be used AFTER `authenticate` so that `request.user` is populated.
 */
async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.user.role !== 'admin') {
    return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' })
  }
}

export default async function adminRoutes(app: FastifyInstance) {
  // All admin routes require authentication + admin role
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAdmin)

  // ── Catalog packs: switch a pack's models off (hidden from browsing and new links) or on ──

  app.get('/api/admin/catalog/packs', async (_request, reply) => {
    return reply.send({ packs: await listPacks() })
  })

  app.patch<{ Params: { id: string }; Body: { enabled?: unknown } }>('/api/admin/catalog/packs/:id', async (request, reply) => {
    const enabled = request.body?.enabled
    if (typeof enabled !== 'boolean') return reply.status(400).send({ error: 'enabled must be true or false' })
    const [row] = await db.update(catalogPacks).set({ enabled }).where(eq(catalogPacks.id, request.params.id)).returning({ id: catalogPacks.id })
    if (!row) return reply.status(404).send({ error: 'Pack not found' })
    const [pack] = await listPacks(row.id)
    return reply.send({ pack })
  })

  // ── Virvi Spaces reports: what visitors sent from the Quest menu ──

  app.get<{ Querystring: { status?: string } }>('/api/admin/ar-reports', async (request, reply) => {
    const status = request.query.status ?? 'open'
    if (!['open', 'resolved', 'all'].includes(status)) return reply.status(400).send({ error: 'bad_status' })
    const reports = await db
      .select({
        id: arReports.id,
        spaceId: arReports.spaceId,
        spaceName: arSpaces.name,
        sceneId: arSpaces.sceneId,
        sceneName: scenes.name,
        reason: arReports.reason,
        platform: arReports.platform,
        status: arReports.status,
        createdAt: arReports.createdAt,
      })
      .from(arReports)
      .innerJoin(arSpaces, eq(arSpaces.id, arReports.spaceId))
      .innerJoin(scenes, eq(scenes.id, arSpaces.sceneId))
      .where(status === 'all' ? undefined : eq(arReports.status, status))
      .orderBy(desc(arReports.createdAt))
      .limit(200)
    return reply.send({ reports })
  })

  app.patch<{ Params: { id: string }; Body: { status?: unknown } }>('/api/admin/ar-reports/:id', async (request, reply) => {
    const status = request.body?.status
    if (status !== 'open' && status !== 'resolved') return reply.status(400).send({ error: 'bad_status' })
    if (!isUuid(request.params.id)) return reply.status(404).send({ error: 'not_found' })
    const [row] = await db.update(arReports).set({ status }).where(eq(arReports.id, request.params.id)).returning({ id: arReports.id, status: arReports.status })
    if (!row) return reply.status(404).send({ error: 'not_found' })
    return reply.send({ report: row })
  })

  // ── GET /api/admin/stats — system-wide statistics ─────────────────────────

  app.get('/api/admin/stats', async (_request, reply) => {
    const [
      [{ totalUsers }],
      [{ totalOrgs }],
      [{ totalScenes }],
      [{ totalMedia }],
      [{ totalStorageBytes }],
      subscriptionsByTier,
    ] = await Promise.all([
      db.select({ totalUsers: sql<number>`count(*)::int` }).from(users),
      db.select({ totalOrgs: sql<number>`count(*)::int` }).from(organizations),
      db.select({ totalScenes: sql<number>`count(*)::int` }).from(scenes),
      db.select({ totalMedia: sql<number>`count(*)::int` }).from(mediaAssets),
      db.select({ totalStorageBytes: sql<string>`coalesce(sum(${mediaAssets.sizeBytes}), 0)::bigint` }).from(mediaAssets),
      db
        .select({
          tier: subscriptions.tier,
          count: sql<number>`count(*)::int`,
        })
        .from(subscriptions)
        .where(eq(subscriptions.status, 'active'))
        .groupBy(subscriptions.tier),
    ])

    const activeSubscriptionsByTier: Record<string, number> = {}
    for (const row of subscriptionsByTier) {
      activeSubscriptionsByTier[row.tier] = row.count
    }

    return reply.send({
      totalUsers,
      totalOrgs,
      totalScenes,
      totalMedia,
      totalStorageBytes: Number(totalStorageBytes),
      activeSubscriptionsByTier,
    })
  })

  // ── GET /api/admin/users — list all users with pagination ─────────────────

  app.get<{
    Querystring: { limit?: string; offset?: string; search?: string }
  }>('/api/admin/users', async (request, reply) => {
    const limit = Math.min(Number(request.query.limit) || 50, 200)
    const offset = Number(request.query.offset) || 0
    const search = request.query.search?.trim()

    const conditions = search
      ? or(
          ilike(users.displayName, `%${search}%`),
          ilike(users.email, `%${search}%`),
        )
      : undefined

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: users.id,
          displayName: users.displayName,
          email: users.email,
          role: users.role,
          createdAt: users.createdAt,
          activeOrgId: users.activeOrgId,
        })
        .from(users)
        .where(conditions)
        .orderBy(users.createdAt)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(users)
        .where(conditions),
    ])

    return reply.send({ users: rows, total, limit, offset })
  })

  // ── GET /api/admin/users/:userId — single user details ────────────────────

  app.get<{ Params: { userId: string } }>('/api/admin/users/:userId', async (request, reply) => {
    const { userId } = request.params

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      with: {
        orgMemberships: {
          with: {
            org: true,
          },
        },
      },
    })

    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }

    // Fetch subscription for this user
    const [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1)

    return reply.send({ user, subscription: subscription || null })
  })

  // ── PUT /api/admin/users/:userId/role — update user role ──────────────────

  app.put<{ Params: { userId: string }; Body: { role: string } }>(
    '/api/admin/users/:userId/role',
    async (request, reply) => {
      const { userId } = request.params
      const { role } = request.body

      if (!role || !['admin', 'creator', 'viewer'].includes(role)) {
        return reply.status(400).send({ error: 'Invalid role. Must be admin, creator, or viewer.' })
      }

      const existing = await db.query.users.findFirst({ where: eq(users.id, userId) })
      if (!existing) {
        return reply.status(404).send({ error: 'User not found' })
      }

      const [updated] = await db
        .update(users)
        .set({ role: role as 'admin' | 'creator' | 'viewer', updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning()

      return reply.send({ user: updated })
    },
  )

  // ── DELETE /api/admin/users/:userId — delete user ─────────────────────────

  app.delete<{ Params: { userId: string } }>('/api/admin/users/:userId', async (request, reply) => {
    const { userId } = request.params

    // Prevent self-deletion
    if (userId === request.user.id) {
      return reply.status(400).send({ error: 'Cannot delete your own admin account' })
    }

    const existing = await db.query.users.findFirst({ where: eq(users.id, userId) })
    if (!existing) {
      return reply.status(404).send({ error: 'User not found' })
    }

    // Hosted worlds' rows would cascade away with it, leaving their Fly app, database and files running untracked.
    const blocked = await hostedWorldsBlockingDelete({ userId })
    if (blocked) return reply.status(409).send(blocked)
    const imports = await importsGoingWith({ userId })
    await db.delete(users).where(eq(users.id, userId))
    await deleteImportFiles(imports)
    return reply.status(204).send()
  })

  // ── GET /api/admin/orgs — list all organizations with counts ──────────────

  app.get<{
    Querystring: { limit?: string; offset?: string; search?: string }
  }>('/api/admin/orgs', async (request, reply) => {
    const limit = Math.min(Number(request.query.limit) || 50, 200)
    const offset = Number(request.query.offset) || 0
    const search = request.query.search?.trim()

    const conditions = search
      ? or(
          ilike(organizations.name, `%${search}%`),
          ilike(organizations.slug, `%${search}%`),
        )
      : undefined

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          createdAt: organizations.createdAt,
          memberCount: sql<number>`(SELECT count(*)::int FROM org_members WHERE org_id = ${organizations.id})`,
          sceneCount: sql<number>`(SELECT count(*)::int FROM scenes WHERE org_id = ${organizations.id})`,
        })
        .from(organizations)
        .where(conditions)
        .orderBy(organizations.createdAt)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(organizations)
        .where(conditions),
    ])

    return reply.send({ organizations: rows, total, limit, offset })
  })

  // ── DELETE /api/admin/orgs/:orgId — delete organization ───────────────────

  app.delete<{ Params: { orgId: string } }>('/api/admin/orgs/:orgId', async (request, reply) => {
    const { orgId } = request.params

    const existing = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) })
    if (!existing) {
      return reply.status(404).send({ error: 'Organization not found' })
    }

    // Hosted worlds' rows would cascade away with it, leaving their Fly app, database and files running untracked.
    const blocked = await hostedWorldsBlockingDelete({ orgId })
    if (blocked) return reply.status(409).send(blocked)
    await db.delete(organizations).where(eq(organizations.id, orgId))
    return reply.status(204).send()
  })
}
