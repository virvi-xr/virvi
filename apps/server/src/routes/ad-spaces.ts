import type { FastifyInstance } from 'fastify'
import { and, asc, eq, or } from 'drizzle-orm'
import { AD_CONTENT_DEFAULT } from '@virvixr/shared'
import type { AdContent, OwnerAdSpace, OwnerAdCandidate } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { ads, adCreatives, adPlacements, adSpaceApprovals, adSpaceSettings, sceneElements, scenePresets } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, isFullAccess } from '../auth/permissions.js'
import { spaceFor } from '../ads/select.js'
import { adSpaceReport } from '../ads/report.js'
import type { Space } from '../ads/select.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTENTS: readonly string[] = ['family', 'all', 'approve']

type Resolved = { status: number; error: string } | { originalId: string; space: Space }

export default async function adSpacesRoutes(app: FastifyInstance) {
  // No `scenePass` config: in-world passes (Hyperfy, AR, scene) are refused by default.
  app.addHook('preHandler', authenticate)

  /** The element's original (booking clones resolve to it), after a full-access check on its scene. */
  async function resolve(request: { user: Parameters<typeof actorFromClaims>[0] }, elementId: string): Promise<Resolved> {
    if (!UUID.test(elementId)) return { status: 404, error: 'not_found' }
    const [el] = await db.select().from(sceneElements).where(eq(sceneElements.id, elementId))
    if (!el) return { status: 404, error: 'not_found' }
    let original = el
    if (el.clonedFromId) {
      const [o] = await db.select().from(sceneElements).where(eq(sceneElements.id, el.clonedFromId))
      if (o) original = o
    }
    const [preset] = await db.select({ sceneId: scenePresets.sceneId }).from(scenePresets).where(eq(scenePresets.id, original.presetId))
    if (!preset) return { status: 404, error: 'not_found' }
    const access = await getSceneAccess(actorFromClaims(request.user), preset.sceneId)
    if (!isFullAccess(access)) return { status: 403, error: 'Forbidden' }
    const space = spaceFor(original)
    if (!space) return { status: 404, error: 'not_an_ad_space' }
    return { originalId: original.id, space }
  }

  async function build(originalId: string, space: Space, now = new Date()): Promise<OwnerAdSpace> {
    const [setting] = await db.select().from(adSpaceSettings).where(eq(adSpaceSettings.elementId, originalId))
    const decisions = await db.select().from(adSpaceApprovals).where(eq(adSpaceApprovals.elementId, originalId))
    const placed = new Set(
      (await db.select({ adId: adPlacements.adId }).from(adPlacements).where(eq(adPlacements.elementId, originalId))).map((p) => p.adId),
    )
    const rows = await db
      .select({
        adId: ads.id, name: ads.name, adKind: ads.kind, clickUrl: ads.clickUrl, audience: ads.audience,
        startsAt: ads.startsAt, endsAt: ads.endsAt,
        creativeId: adCreatives.id, shape: adCreatives.shape, kind: adCreatives.kind, url: adCreatives.url,
      })
      .from(ads)
      .innerJoin(adCreatives, eq(adCreatives.adId, ads.id))
      .where(and(eq(ads.status, 'active'), eq(ads.reviewStatus, 'approved')))
      .orderBy(asc(ads.name), asc(ads.id), asc(adCreatives.id))
    const byAd = new Map<string, OwnerAdCandidate>()
    for (const r of rows) {
      if ((r.startsAt && r.startsAt > now) || (r.endsAt && now >= r.endsAt)) continue
      if (r.shape !== space.shape || (space.formats !== 'both' && r.kind !== space.formats)) continue
      if (r.adKind === 'partner' && !placed.has(r.adId)) continue
      let c = byAd.get(r.adId)
      if (!c) {
        c = {
          adId: r.adId, name: r.name, clickUrl: r.clickUrl, house: r.adKind === 'house', audience: r.audience,
          creatives: [], decision: decisions.find((d) => d.adId === r.adId)?.decision ?? null,
        }
        byAd.set(r.adId, c)
      }
      c.creatives.push({ id: r.creativeId, kind: r.kind, url: r.url })
    }
    return { elementId: originalId, content: setting?.content ?? AD_CONTENT_DEFAULT, ads: [...byAd.values()] }
  }

  const fail = (reply: { status: (n: number) => { send: (b: unknown) => unknown } }, r: { status: number; error: string }) =>
    reply.status(r.status).send(r.status === 403 ? { error: 'Forbidden', message: 'Full access to this scene is required' } : { error: r.error })

  app.get<{ Params: { elementId: string } }>('/api/ad-spaces/:elementId', async (request, reply) => {
    const r = await resolve(request, request.params.elementId)
    if ('error' in r) return fail(reply, r)
    return { space: await build(r.originalId, r.space) }
  })

  // LIV-38: what the space delivered, per ad, over the last 7, 30 or 90 days (30 by default)
  app.get<{ Params: { elementId: string }; Querystring: { days?: string } }>('/api/ad-spaces/:elementId/report', async (request, reply) => {
    const r = await resolve(request, request.params.elementId)
    if ('error' in r) return fail(reply, r)
    const days = [7, 30, 90].includes(Number(request.query.days)) ? Number(request.query.days) : 30
    const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
    // The space and its booking copies, which serve the same ads under their own ids
    const ids = (await db.select({ id: sceneElements.id }).from(sceneElements)
      .where(or(eq(sceneElements.id, r.originalId), eq(sceneElements.clonedFromId, r.originalId)))).map((e) => e.id)
    return { report: await adSpaceReport(ids, from, days) }
  })

  app.put<{ Params: { elementId: string }; Body: { content?: unknown } }>('/api/ad-spaces/:elementId/content', async (request, reply) => {
    const r = await resolve(request, request.params.elementId)
    if ('error' in r) return fail(reply, r)
    const content = request.body?.content
    if (typeof content !== 'string' || !CONTENTS.includes(content)) {
      return reply.status(400).send({ error: 'content_must_be_family_all_or_approve' })
    }
    const now = new Date()
    await db
      .insert(adSpaceSettings)
      .values({ elementId: r.originalId, content: content as AdContent, updatedBy: request.user.id, updatedAt: now })
      .onConflictDoUpdate({ target: adSpaceSettings.elementId, set: { content: content as AdContent, updatedBy: request.user.id, updatedAt: now } })
    return { space: await build(r.originalId, r.space) }
  })

  app.put<{ Params: { elementId: string; adId: string }; Body: { decision?: unknown } }>(
    '/api/ad-spaces/:elementId/approvals/:adId',
    async (request, reply) => {
      const r = await resolve(request, request.params.elementId)
      if ('error' in r) return fail(reply, r)
      const decision = request.body?.decision
      if (decision !== 'approved' && decision !== 'declined') {
        return reply.status(400).send({ error: 'decision_must_be_approved_or_declined' })
      }
      const { adId } = request.params
      const current = await build(r.originalId, r.space)
      if (!UUID.test(adId) || !current.ads.some((a) => a.adId === adId)) {
        return reply.status(400).send({ error: 'ad_not_a_candidate' })
      }
      const now = new Date()
      await db
        .insert(adSpaceApprovals)
        .values({ adId, elementId: r.originalId, decision, decidedBy: request.user.id, decidedAt: now })
        .onConflictDoUpdate({
          target: [adSpaceApprovals.adId, adSpaceApprovals.elementId],
          set: { decision, decidedBy: request.user.id, decidedAt: now },
        })
      return { space: await build(r.originalId, r.space) }
    },
  )
}
