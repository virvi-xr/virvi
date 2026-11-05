import type { FastifyInstance } from 'fastify'
import { eq, and, count, inArray } from 'drizzle-orm'
import crypto from 'node:crypto'
import { db } from '../db/connection.js'
import { organizations, orgMembers, orgInvites, userAuthMethods, users } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { sendOrgInviteEmail } from '../services/email.js'

export default async function organizationRoutes(app: FastifyInstance) {
  // ── GET /api/orgs — list user's organizations ───────────────────────────

  // Flat, as Settings → Your Organizations reads it (LIV-93): the org, your role in it, how many members it has, and
  // whether it's your active one.
  app.get('/api/orgs', { preHandler: [authenticate] }, async (request) => {
    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        logoUrl: organizations.logoUrl,
        role: orgMembers.role,
      })
      .from(orgMembers)
      .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
      .where(eq(orgMembers.userId, request.user.id))
    const counts = rows.length
      ? await db.select({ orgId: orgMembers.orgId, n: count() }).from(orgMembers)
        .where(inArray(orgMembers.orgId, rows.map((r) => r.id))).groupBy(orgMembers.orgId)
      : []
    const [me] = await db.select({ activeOrgId: users.activeOrgId }).from(users).where(eq(users.id, request.user.id))
    const countOf = new Map(counts.map((c) => [c.orgId, Number(c.n)]))
    return {
      organizations: rows.map((r) => ({ ...r, memberCount: countOf.get(r.id) ?? 0, isActive: me?.activeOrgId === r.id })),
    }
  })

  // ── POST /api/orgs — create organization ────────────────────────────────

  app.post<{ Body: { name: string; slug?: string } }>(
    '/api/orgs',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { name, slug: rawSlug } = request.body
      if (!name) return reply.status(400).send({ error: 'name is required' })

      const slug = (rawSlug || name).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

      const existing = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug))
      if (existing.length > 0) return reply.status(409).send({ error: 'Organization slug already taken' })

      const [org] = await db.insert(organizations).values({
        name,
        slug,
        billingOwnerId: request.user.id,
      }).returning()

      // Creator becomes owner
      await db.insert(orgMembers).values({
        orgId: org.id,
        userId: request.user.id,
        role: 'owner',
      })

      // Set as active org if user has none
      const [user] = await db.select({ activeOrgId: users.activeOrgId }).from(users).where(eq(users.id, request.user.id))
      if (!user.activeOrgId) {
        await db.update(users).set({ activeOrgId: org.id }).where(eq(users.id, request.user.id))
      }

      // The org list's shape, so the page can show it at once with the owner's controls
      return reply.status(201).send({
        organization: { id: org.id, name: org.name, slug: org.slug, logoUrl: org.logoUrl, role: 'owner', memberCount: 1, isActive: !user.activeOrgId },
      })
    },
  )

  // ── PUT /api/orgs/:orgId — update organization ─────────────────────────

  app.put<{ Params: { orgId: string }; Body: { name?: string; logoUrl?: string } }>(
    '/api/orgs/:orgId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { orgId } = request.params
      const membership = await getOrgMembership(request.user.id, orgId)
      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        return reply.status(403).send({ error: 'Must be org owner or admin' })
      }

      const { name, logoUrl } = request.body
      const [updated] = await db.update(organizations)
        .set({ ...(name ? { name } : {}), ...(logoUrl !== undefined ? { logoUrl } : {}), updatedAt: new Date() })
        .where(eq(organizations.id, orgId))
        .returning()

      return { organization: updated }
    },
  )

  // ── GET /api/orgs/:orgId/members — list members ────────────────────────

  app.get<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/members',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { orgId } = request.params
      const membership = await getOrgMembership(request.user.id, orgId)
      if (!membership) return reply.status(403).send({ error: 'Not a member of this organization' })

      const rows = await db
        .select({
          userId: orgMembers.userId,
          role: orgMembers.role,
          joinedAt: orgMembers.joinedAt,
          displayName: users.displayName,
          email: users.email,
        })
        .from(orgMembers)
        .innerJoin(users, eq(orgMembers.userId, users.id))
        .where(eq(orgMembers.orgId, orgId))
      // A wallet, for members with neither a name nor an email (LIV-93: the page never shows an id)
      const wallets = rows.length
        ? await db.select({ userId: userAuthMethods.userId, identifier: userAuthMethods.identifier }).from(userAuthMethods)
          .where(and(inArray(userAuthMethods.userId, rows.map((r) => r.userId)), eq(userAuthMethods.type, 'wallet')))
        : []
      const walletOf = new Map<string, string>()
      for (const w of wallets) if (!walletOf.has(w.userId)) walletOf.set(w.userId, w.identifier)

      return { members: rows.map((r) => ({ ...r, walletAddress: walletOf.get(r.userId) ?? null })) }
    },
  )

  // ── POST /api/orgs/:orgId/invites — invite member ─────────────────────

  app.post<{ Params: { orgId: string }; Body: { email: string; role?: string } }>(
    '/api/orgs/:orgId/invites',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { orgId } = request.params
      const { email, role } = request.body

      if (!email) return reply.status(400).send({ error: 'email is required' })

      const membership = await getOrgMembership(request.user.id, orgId)
      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        return reply.status(403).send({ error: 'Must be org owner or admin to invite' })
      }

      // Only member/admin can be invited, and only the owner can mint admins.
      const inviteRole = role ?? 'member'
      if (inviteRole !== 'member' && inviteRole !== 'admin') return reply.status(400).send({ error: 'invalid_role' })
      if (inviteRole === 'admin' && membership.role !== 'owner') {
        return reply.status(403).send({ error: 'Only the owner can invite admins' })
      }

      const token = crypto.randomBytes(32).toString('hex')
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

      const [invite] = await db.insert(orgInvites).values({
        orgId,
        email: email.toLowerCase(),
        role: inviteRole,
        invitedBy: request.user.id,
        token,
        expiresAt,
      }).returning()

      // Send invite email
      const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId))
      const [inviter] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, request.user.id))
      await sendOrgInviteEmail(email.toLowerCase(), org?.name || 'an organization', inviter?.displayName || 'Someone', token)

      return reply.status(201).send({ invite })
    },
  )

  // ── POST /api/orgs/accept-invite — accept invite by token ─────────────

  app.post<{ Body: { token: string } }>(
    '/api/orgs/accept-invite',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { token } = request.body
      if (!token) return reply.status(400).send({ error: 'token is required' })

      const [invite] = await db.select().from(orgInvites).where(eq(orgInvites.token, token))
      if (!invite) return reply.status(404).send({ error: 'Invite not found' })
      if (invite.status !== 'pending') return reply.status(400).send({ error: `Invite already ${invite.status}` })
      if (invite.expiresAt < new Date()) {
        await db.update(orgInvites).set({ status: 'expired' }).where(eq(orgInvites.id, invite.id))
        return reply.status(400).send({ error: 'Invite has expired' })
      }

      // Add user to org
      await db.insert(orgMembers).values({
        orgId: invite.orgId,
        userId: request.user.id,
        role: invite.role,
      }).onConflictDoNothing()

      // Mark invite accepted
      await db.update(orgInvites).set({ status: 'accepted' }).where(eq(orgInvites.id, invite.id))

      // Set active org if user has none
      const [user] = await db.select({ activeOrgId: users.activeOrgId }).from(users).where(eq(users.id, request.user.id))
      if (!user.activeOrgId) {
        await db.update(users).set({ activeOrgId: invite.orgId }).where(eq(users.id, request.user.id))
      }

      return { accepted: true, orgId: invite.orgId }
    },
  )

  // ── PUT /api/orgs/:orgId/active — set active org ──────────────────────

  app.put<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/active',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { orgId } = request.params
      const membership = await getOrgMembership(request.user.id, orgId)
      if (!membership) return reply.status(403).send({ error: 'Not a member of this organization' })

      await db.update(users).set({ activeOrgId: orgId }).where(eq(users.id, request.user.id))
      return { activeOrgId: orgId }
    },
  )

  // ── DELETE /api/orgs/:orgId/members/:userId — remove member ────────────

  app.delete<{ Params: { orgId: string; userId: string } }>(
    '/api/orgs/:orgId/members/:userId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { orgId, userId } = request.params

      const membership = await getOrgMembership(request.user.id, orgId)
      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin' && request.user.id !== userId)) {
        return reply.status(403).send({ error: 'Insufficient permissions' })
      }

      const target = await getOrgMembership(userId, orgId)
      if (target?.role === 'owner') return reply.status(400).send({ error: 'Transfer ownership first' })
      if (target?.role === 'admin' && membership.role !== 'owner' && request.user.id !== userId) {
        return reply.status(403).send({ error: 'Only the owner can remove an admin' })
      }

      await db.delete(orgMembers).where(
        and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))
      )

      return reply.status(204).send()
    },
  )
}

async function getOrgMembership(userId: string, orgId: string) {
  const [membership] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.orgId, orgId)))
  return membership || null
}
