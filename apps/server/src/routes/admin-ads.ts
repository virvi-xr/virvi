import type { FastifyInstance } from 'fastify'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { AD_SHAPES, VideoSourceType } from '@virvixr/shared'
import type { AdShape, AdminAd, AdminAdSpace } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { ads, adCreatives, adPlacements, mediaAssets, sceneElements, scenePresets, scenes } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../auth/admin.js'
import { adReport } from '../ads/report.js'
import { recordReview, resetReview } from '../ads/review.js'
import { spaceContentFor } from '../ads/content.js'


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isShape = (v: unknown): v is AdShape => AD_SHAPES.includes(v as AdShape)
const isHttps = (v: unknown): v is string => {
  if (typeof v !== 'string') return false
  try { return new URL(v).protocol === 'https:' } catch { return false }
}
/** Parsed date, null for an explicit null, undefined when the value is not a date. */
const parseDate = (v: unknown): Date | null | undefined => {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** A video element counts as an ad space when it plays ads. */
const isAdsVideo = (el: { type: string; properties: unknown }) => {
  const offType = ((el.properties ?? {}) as Record<string, unknown>).offType
  return el.type === 'video' && (offType === VideoSourceType.ADS || offType === VideoSourceType.PLAYLIST_ADS)
}
const isAdCapable = (el: { type: string; properties: unknown }) => el.type === 'ad_space' || isAdsVideo(el)

async function loadAd(id: string): Promise<AdminAd | null> {
  if (!UUID.test(id)) return null
  const [ad] = await db.select().from(ads).where(eq(ads.id, id))
  if (!ad) return null
  return (await toAdminAds([ad]))[0]
}

async function toAdminAds(rows: (typeof ads.$inferSelect)[]): Promise<AdminAd[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const [creatives, placements] = await Promise.all([
    db.select().from(adCreatives).where(inArray(adCreatives.adId, ids)).orderBy(asc(adCreatives.createdAt)),
    db.select().from(adPlacements).where(inArray(adPlacements.adId, ids)),
  ])
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    clickUrl: r.clickUrl,
    status: r.status,
    startsAt: r.startsAt?.toISOString() ?? null,
    endsAt: r.endsAt?.toISOString() ?? null,
    creatives: creatives.filter((c) => c.adId === r.id).map((c) => ({ id: c.id, shape: c.shape as AdShape, kind: c.kind, url: c.url })),
    placements: placements.filter((p) => p.adId === r.id).map((p) => p.elementId),
    review: {
      status: r.reviewStatus,
      audience: r.audience,
      reason: r.rejectReason,
      reviewerKind: r.reviewerKind,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
    },
  }))
}

export default async function adminAdsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAdmin)

  app.get<{ Querystring: { review?: string } }>('/api/admin/ads', async (request, reply) => {
    const pending = request.query.review === 'pending'
    const rows = await db.select().from(ads).where(pending ? eq(ads.reviewStatus, 'pending') : undefined).orderBy(asc(ads.createdAt))
    return reply.send({ ads: await toAdminAds(rows) })
  })

  // Registered before the :id routes; the static segment wins either way
  app.get('/api/admin/ads/spaces', async (_request, reply) => {
    const rows = await db
      .select({
        id: sceneElements.id, name: sceneElements.name, type: sceneElements.type, properties: sceneElements.properties,
        sceneId: scenes.id, sceneName: scenes.name, presetId: scenePresets.id, presetName: scenePresets.name, activePresetId: scenes.activePresetId,
      })
      .from(sceneElements)
      .innerJoin(scenePresets, eq(scenePresets.id, sceneElements.presetId))
      .innerJoin(scenes, eq(scenes.id, scenePresets.sceneId))
      // booking clones take their original's placements, so only originals are listed
      .where(and(inArray(sceneElements.type, ['ad_space', 'video']), isNull(sceneElements.clonedFromId)))
      .orderBy(asc(scenes.name), asc(scenePresets.name), asc(sceneElements.name))
    const capable = rows.filter(isAdCapable)
    const contentById = await spaceContentFor(capable.map((r) => r.id))
    const spaces: AdminAdSpace[] = capable.map((r) => {
      const p = (r.properties ?? {}) as Record<string, unknown>
      const raw = r.type === 'ad_space' ? p.shape : p.adShape
      return {
        elementId: r.id, sceneId: r.sceneId, sceneName: r.sceneName, presetName: r.presetName, activePreset: r.presetId === r.activePresetId,
        name: r.name, type: r.type as AdminAdSpace['type'], shape: isShape(raw) ? raw : r.type === 'video' ? '16:9' : null,
        content: contentById.get(r.id) ?? 'family',
      }
    })
    return reply.send({ spaces })
  })

  app.post<{ Body: { name?: unknown; kind?: unknown; clickUrl?: unknown; startsAt?: unknown; endsAt?: unknown } }>('/api/admin/ads', async (request, reply) => {
    const { name, kind, clickUrl, startsAt, endsAt } = request.body ?? {}
    if (typeof name !== 'string' || !name.trim()) return reply.status(400).send({ error: 'name is required' })
    if (kind !== 'house' && kind !== 'partner') return reply.status(400).send({ error: 'kind must be house or partner' })
    if (!isHttps(clickUrl)) return reply.status(400).send({ error: 'click_url_must_be_https' })
    const start = startsAt === undefined ? null : parseDate(startsAt)
    const end = endsAt === undefined ? null : parseDate(endsAt)
    if (start === undefined || end === undefined) return reply.status(400).send({ error: 'startsAt and endsAt must be dates' })
    const [row] = await db.insert(ads).values({ name: name.trim(), kind, clickUrl, startsAt: start, endsAt: end, createdBy: request.user.id }).returning()
    return reply.status(201).send({ ad: (await toAdminAds([row]))[0] })
  })

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/admin/ads/:id', async (request, reply) => {
    if (!(await loadAd(request.params.id))) return reply.status(404).send({ error: 'Ad not found' })
    const b = request.body ?? {}
    const set: Partial<typeof ads.$inferInsert> = { updatedAt: new Date() }
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || !b.name.trim()) return reply.status(400).send({ error: 'name must not be empty' })
      set.name = b.name.trim()
    }
    if (b.clickUrl !== undefined) {
      if (!isHttps(b.clickUrl)) return reply.status(400).send({ error: 'click_url_must_be_https' })
      set.clickUrl = b.clickUrl
    }
    if (b.status !== undefined) {
      if (b.status !== 'active' && b.status !== 'paused') return reply.status(400).send({ error: 'status must be active or paused' })
      set.status = b.status
    }
    for (const key of ['startsAt', 'endsAt'] as const) {
      if (b[key] === undefined) continue
      const d = parseDate(b[key])
      if (d === undefined) return reply.status(400).send({ error: `${key} must be a date or null` })
      set[key] = d
    }
    const before = await loadAd(request.params.id)
    await db.transaction(async (tx) => {
      await tx.update(ads).set(set).where(eq(ads.id, request.params.id))
      if (set.clickUrl !== undefined && set.clickUrl !== before?.clickUrl) await resetReview(request.params.id, tx)
    })
    return reply.send({ ad: await loadAd(request.params.id) })
  })

  app.post<{ Params: { id: string }; Body: { mediaAssetId?: unknown; shape?: unknown } }>('/api/admin/ads/:id/creatives', async (request, reply) => {
    if (!(await loadAd(request.params.id))) return reply.status(404).send({ error: 'Ad not found' })
    const { mediaAssetId, shape } = request.body ?? {}
    if (!isShape(shape)) return reply.status(400).send({ error: `shape must be one of ${AD_SHAPES.join(', ')}` })
    if (typeof mediaAssetId !== 'string' || !UUID.test(mediaAssetId)) return reply.status(400).send({ error: 'mediaAssetId is required' })
    const [media] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaAssetId))
    if (!media) return reply.status(404).send({ error: 'Media not found' })
    if (media.status !== 'ready' || !media.publicUrl) return reply.status(400).send({ error: 'media_not_ready' })
    const kind = media.contentType.startsWith('image/') ? 'image' : media.contentType.startsWith('video/') ? 'video' : null
    if (!kind) return reply.status(400).send({ error: 'creative_must_be_image_or_video' })
    const creative = await db.transaction(async (tx) => {
      const [row] = await tx.insert(adCreatives).values({ adId: request.params.id, shape, kind, mediaAssetId: media.id, url: media.publicUrl! }).returning()
      await resetReview(request.params.id, tx)
      return row
    })
    return reply.status(201).send({ creative: { id: creative.id, shape: creative.shape, kind: creative.kind, url: creative.url } })
  })

  app.delete<{ Params: { id: string; creativeId: string } }>('/api/admin/ads/:id/creatives/:creativeId', async (request, reply) => {
    const { id, creativeId } = request.params
    if (!UUID.test(id) || !UUID.test(creativeId)) return reply.status(404).send({ error: 'Creative not found' })
    const removed = await db.transaction(async (tx) => {
      const gone = await tx.delete(adCreatives).where(and(eq(adCreatives.id, creativeId), eq(adCreatives.adId, id))).returning({ id: adCreatives.id })
      if (gone.length) await resetReview(id, tx)
      return gone
    })
    if (!removed.length) return reply.status(404).send({ error: 'Creative not found' })
    return reply.send({ ok: true })
  })

  app.post<{ Params: { id: string }; Body: { decision?: unknown; audience?: unknown; reason?: unknown } }>('/api/admin/ads/:id/review', async (request, reply) => {
    const { decision, audience, reason } = request.body ?? {}
    const by = { kind: 'human' as const, userId: request.user.id }
    if (decision !== 'approved' && decision !== 'rejected') return reply.status(400).send({ error: 'decision must be approved or rejected' })
    if (decision === 'approved' && audience !== 'family' && audience !== 'mature') return reply.status(400).send({ error: 'audience_required' })
    if (!UUID.test(request.params.id)) return reply.status(404).send({ error: 'Ad not found' })
    const result = await recordReview(
      request.params.id,
      decision === 'approved' ? { decision, audience: audience as 'family' | 'mature' } : { decision, reason: typeof reason === 'string' ? reason : '' },
      by,
    )
    if (result === 'not_found') return reply.status(404).send({ error: 'Ad not found' })
    if (result === 'no_creatives') return reply.status(400).send({ error: 'ad_has_no_creatives' })
    if (result === 'bad_reason') return reply.status(400).send({ error: 'reason_required' })
    return reply.send({ ad: await loadAd(request.params.id) })
  })

  app.put<{ Params: { id: string }; Body: { elementIds?: unknown } }>('/api/admin/ads/:id/placements', async (request, reply) => {
    const ad = await loadAd(request.params.id)
    if (!ad) return reply.status(404).send({ error: 'Ad not found' })
    if (ad.kind === 'house') return reply.status(400).send({ error: 'house_ads_go_everywhere' })
    const raw = request.body?.elementIds
    if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string' && UUID.test(id))) {
      return reply.status(400).send({ error: 'elementIds must be an array of element ids' })
    }
    const elementIds = [...new Set(raw as string[])]
    const found = elementIds.length ? await db.select().from(sceneElements).where(inArray(sceneElements.id, elementIds)) : []
    // booking clones serve their original's placements; the owner's candidate list reads originals only
    if (found.length !== elementIds.length || !found.every(isAdCapable) || found.some((e) => e.clonedFromId !== null)) {
      return reply.status(400).send({ error: 'elements_must_be_ad_spaces' })
    }
    await db.transaction(async (tx) => {
      await tx.delete(adPlacements).where(eq(adPlacements.adId, ad.id))
      if (elementIds.length) await tx.insert(adPlacements).values(elementIds.map((elementId) => ({ adId: ad.id, elementId })))
    })
    return reply.send({ ad: await loadAd(ad.id) })
  })

  app.get<{ Params: { id: string } }>('/api/admin/ads/:id/report', async (request, reply) => {
    if (!(await loadAd(request.params.id))) return reply.status(404).send({ error: 'Ad not found' })
    return reply.send(await adReport(request.params.id))
  })
}
