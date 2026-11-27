import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneRoles, scenes, userAuthMethods, users } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, isFullAccess, isHostAccess } from '../auth/permissions.js'
import { checkEditArea, describeEditArea, type EditArea } from '@virvixr/shared'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { fromParam } from '../auth/scene-from.js'
import { listSceneActivity, recordSceneActivity, requestActor } from '../scenes/activity.js'

const WALLET_RE = /^0x[0-9a-f]{40}$/
const ROLES = new Set(['cohost', 'editor', 'viewer'])

export default async function sceneRoleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  async function guard(request: FastifyRequest<{ Params: { sceneId: string } }>, reply: FastifyReply, hostOnly = false) {
    const access = await getSceneAccess(actorFromClaims(request.user), request.params.sceneId)
    if (!(hostOnly ? isHostAccess(access) : isFullAccess(access))) {
      reply.status(403).send({ error: 'Forbidden' })
      return null
    }
    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, request.params.sceneId) })
    if (!scene) {
      reply.status(404).send({ error: 'Not found' })
      return null
    }
    return scene
  }

  const walletName = async (userId: string | null) =>
    userId ? (await db.query.users.findFirst({ where: eq(users.id, userId), columns: { displayName: true } }))?.displayName ?? null : null

  const activeRow = (sceneId: string, wallet: string) =>
    db.query.sceneRoles.findFirst({ where: and(eq(sceneRoles.sceneId, sceneId), eq(sceneRoles.walletAddress, wallet), isNull(sceneRoles.revokedAt)) })

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/roles', { config: { scenePass: { sceneFrom: fromParam('sceneId'), ar: 'personal' } } }, async (request, reply) => {
    const scene = await guard(request, reply)
    if (!scene) return
    const owner = await db.query.users.findFirst({ where: eq(users.id, scene.ownerId) })
    const rows = await db
      .select({ wallet: sceneRoles.walletAddress, role: sceneRoles.role, area: sceneRoles.area, userId: sceneRoles.userId, displayName: users.displayName, createdAt: sceneRoles.createdAt })
      .from(sceneRoles)
      .leftJoin(users, eq(users.id, sceneRoles.userId))
      .where(and(eq(sceneRoles.sceneId, scene.id), isNull(sceneRoles.revokedAt)))
      .orderBy(sceneRoles.createdAt)
    return reply.send({
      host: { userId: scene.ownerId, displayName: owner?.displayName ?? null, wallets: await verifiedWalletsOf(scene.ownerId) },
      roles: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    })
  })

  app.post<{ Params: { sceneId: string }; Body: { wallet?: string; role?: string; area?: unknown } }>('/api/scenes/:sceneId/roles', { config: { scenePass: { sceneFrom: fromParam('sceneId'), ar: 'personal' } } }, async (request, reply) => {
    const scene = await guard(request, reply)
    if (!scene) return
    const wallet = typeof request.body?.wallet === 'string' ? request.body.wallet.toLowerCase() : ''
    const role = request.body?.role ?? ''
    if (!WALLET_RE.test(wallet) || !ROLES.has(role)) return reply.status(400).send({ error: 'wallet (0x…) and role (cohost, editor or viewer) are required' })
    // An editor can be limited to an area (LIV-32, a tenant); null or absent edits everywhere
    const rawArea = request.body?.area
    let area: EditArea | null = null
    if (rawArea !== undefined && rawArea !== null) {
      if (role !== 'editor') return reply.status(400).send({ error: 'area_editor_only', message: 'Only an editor can be limited to an area.' })
      const c = checkEditArea(rawArea)
      if (!c.ok) return reply.status(400).send({ error: 'bad_area', message: c.error })
      area = c.value
    }
    if ((await verifiedWalletsOf(scene.ownerId)).includes(wallet)) return reply.status(409).send({ error: 'is_host' })
    const existing = await activeRow(scene.id, wallet)
    // Left out, an editor's area stays as it was (the HUDs send only wallet and role); null clears it
    if (rawArea === undefined && role === 'editor' && existing?.role === 'editor') area = existing.area ?? null
    const linked = await db.query.userAuthMethods.findFirst({ where: and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, wallet)) })
    const userId = linked && (linked.metadata as { verified?: boolean } | null)?.verified ? linked.userId : null
    const [row] = existing
      ? await db.update(sceneRoles).set({ role: role as 'cohost', area, userId: existing.userId ?? userId }).where(eq(sceneRoles.id, existing.id)).returning()
      : await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: wallet, role: role as 'cohost', area, userId, grantedByUserId: request.user.id }).returning()
    const areaChanged = JSON.stringify(existing?.area ?? null) !== JSON.stringify(row.area ?? null)
    if (!existing || existing.role !== row.role || areaChanged) {
      await recordSceneActivity(scene.id, requestActor(request.user), 'role.granted', { type: 'wallet', id: wallet, name: await walletName(row.userId) }, {
        role: row.role, ...(existing ? { from: existing.role } : {}), ...(row.area ? { area: describeEditArea(row.area) } : {}),
      })
    }
    return reply.status(201).send({ role: { wallet: row.walletAddress, role: row.role, area: row.area ?? null, userId: row.userId } })
  })

  app.delete<{ Params: { sceneId: string; wallet: string } }>('/api/scenes/:sceneId/roles/:wallet', { config: { scenePass: { sceneFrom: fromParam('sceneId'), ar: 'personal' } } }, async (request, reply) => {
    const scene = await guard(request, reply)
    if (!scene) return
    const wallet = request.params.wallet.toLowerCase()
    if ((await verifiedWalletsOf(scene.ownerId)).includes(wallet)) return reply.status(403).send({ error: 'The host cannot be removed' })
    const revoked = await db.update(sceneRoles).set({ revokedAt: new Date() }).where(and(eq(sceneRoles.sceneId, scene.id), eq(sceneRoles.walletAddress, wallet), isNull(sceneRoles.revokedAt))).returning()
    if (revoked[0]) await recordSceneActivity(scene.id, requestActor(request.user), 'role.revoked', { type: 'wallet', id: wallet, name: await walletName(revoked[0].userId) }, { role: revoked[0].role })
    return reply.status(204).send()
  })

  app.post<{ Params: { sceneId: string }; Body: { wallet?: string } }>('/api/scenes/:sceneId/transfer-host', { config: { scenePass: { sceneFrom: fromParam('sceneId') } } }, async (request, reply) => {
    const scene = await guard(request, reply, true)
    if (!scene) return
    const wallet = typeof request.body?.wallet === 'string' ? request.body.wallet.toLowerCase() : ''
    const previousWallet = (await verifiedWalletsOf(scene.ownerId))[0]
    if (!previousWallet) return reply.status(409).send({ error: 'host_has_no_wallet' })
    const target = WALLET_RE.test(wallet) ? await activeRow(scene.id, wallet) : undefined
    if (!target || target.role !== 'cohost' || !target.userId) return reply.status(409).send({ error: 'not_a_signed_in_cohost' })
    const now = new Date()
    await db.transaction(async (tx) => {
      await tx.update(scenes).set({ ownerId: target.userId!, updatedAt: now }).where(eq(scenes.id, scene.id))
      await tx.update(sceneRoles).set({ revokedAt: now }).where(eq(sceneRoles.id, target.id))
      await tx.update(sceneRoles).set({ revokedAt: now }).where(and(eq(sceneRoles.sceneId, scene.id), eq(sceneRoles.walletAddress, previousWallet), isNull(sceneRoles.revokedAt)))
      await tx.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: previousWallet, userId: scene.ownerId, role: 'cohost', grantedByUserId: scene.ownerId })
    })
    await recordSceneActivity(scene.id, requestActor(request.user), 'host.transferred', { type: 'wallet', id: target.walletAddress, name: await walletName(target.userId) })
    return reply.send({ host: target.userId })
  })

  // ── The scene's activity log (LIV-32): host and co-hosts, newest first; ?before=<at>,<id> pages back ──
  app.get<{ Params: { sceneId: string }; Querystring: { before?: string; limit?: string } }>('/api/scenes/:sceneId/activity', async (request, reply) => {
    const scene = await guard(request, reply)
    if (!scene) return
    let before: { at: Date; id: string } | undefined
    if (request.query.before) {
      const [at, id] = request.query.before.split(',')
      const when = new Date(at ?? '')
      if (Number.isNaN(when.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) return reply.status(400).send({ error: 'bad_cursor' })
      before = { at: when, id }
    }
    const limit = request.query.limit ? Number(request.query.limit) : undefined
    if (limit !== undefined && !Number.isInteger(limit)) return reply.status(400).send({ error: 'bad_limit' })
    return reply.send(await listSceneActivity(scene.id, { before, limit }))
  })
}
