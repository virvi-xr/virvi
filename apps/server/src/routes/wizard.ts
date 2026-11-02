/**
 * New Scene Wizard routes.
 *
 * GET  /api/wizard/catalog — curated themes and category chips, resolved against the live catalog
 * GET  /api/wizard/options — what this account can pick (Virvi-signed deploys, Hyperfy, scene allowance)
 * POST /api/wizard/scenes  — create the whole scene (preset, models, placements, library links) in one call;
 *                            `dcl: false` (Hyperfy/AR only) skips Decentraland's triangle and entity budget
 */

import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { dclBudget, plotParcels, plotSizeM, validPlot, type Plot } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assetLibraryItems, sceneElementInstances, sceneElements, sceneLibrary, scenePresets, scenes } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { browsableAsset } from '../catalog/visibility.js'
import { config } from '../config.js'
import { getSubscription } from '../integrations/stripe.js'
import { virviSigner } from '../services/dcl/entity.js'
import { sceneLimitError } from './scenes.js'
import { plotForLayout } from '../room-scan/plot.js'
import { commitRoomSet, insertRoomSet, loadOwnedScan, parseRoomSetOptions, prepareRoomSet, RoomSetError, type PreparedRoomSet, type Tx } from '../room-scan/sets.js'
import { CATEGORY_CHIPS, THEMES } from '../wizard/themes.js'

interface WizardAsset {
  id: string
  name: string
  thumbnailUrl: string | null
  cdnUrl: string | null
  dimensions: { x: number; y: number; z: number } | null
  triangleCount: number | null
  fileSizeBytes: number
}

type AssetRow = typeof assetLibraryItems.$inferSelect

/** Catalog dimensions are stored as { width, height, depth }; the wizard speaks x/y/z. */
function toDimensions(raw: unknown): WizardAsset['dimensions'] {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const [x, y, z] = [d.width ?? d.x, d.height ?? d.y, d.depth ?? d.z]
  return [x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n)) ? { x: x as number, y: y as number, z: z as number } : null
}

function toWizardAsset(a: AssetRow): WizardAsset {
  return {
    id: a.id,
    name: a.name,
    thumbnailUrl: a.thumbnailUrl,
    cdnUrl: a.cdnUrl,
    dimensions: toDimensions(a.dimensions),
    triangleCount: a.triangleCount,
    fileSizeBytes: a.fileSizeBytes,
  }
}

const refKey = (r: { pack: string; sourceRef: string }) => `${r.pack}\n${r.sourceRef}`
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

interface BootstrapBody {
  name?: unknown
  plot?: unknown
  items?: unknown
  spawn?: unknown
  /** True when the scene goes to a Decentraland World; false (Hyperfy/AR only) drops the per-parcel budget. */
  dcl?: unknown
  /** Start the scene from one of the caller's room scans: `{ scanId, options }`. */
  roomSet?: unknown
}

export default async function wizardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/wizard/catalog', async (_request, reply) => {
    const refs = [...THEMES.flatMap((t) => t.items), ...CATEGORY_CHIPS.flatMap((c) => c.picks)]
    const rows = await db
      .select()
      .from(assetLibraryItems)
      .where(
        and(
          inArray(assetLibraryItems.sourceRef, [...new Set(refs.map((r) => r.sourceRef))]),
          isNotNull(assetLibraryItems.packId),
          eq(assetLibraryItems.isPublic, true),
          browsableAsset(),
        ),
      )
    // Assets the wizard can't use (unmeasured or without a model URL) are left out like unresolved refs
    const usable = rows.filter((a) => a.triangleCount !== null && a.cdnUrl)
    const byRef = new Map(usable.map((a) => [refKey({ pack: a.packId!, sourceRef: a.sourceRef! }), toWizardAsset(a)]))
    return reply.send({
      themes: THEMES.map((t) => ({
        id: t.id,
        name: t.name,
        items: t.items.flatMap((i) => {
          const asset = byRef.get(refKey(i))
          return asset ? [{ asset, x: i.x, z: i.z, rotationY: i.rotationY }] : []
        }),
      })),
      chips: CATEGORY_CHIPS.map((c) => ({
        id: c.id,
        label: c.label,
        categories: c.categories,
        assets: c.picks.flatMap((p) => byRef.get(refKey(p)) ?? []),
      })),
    })
  })

  app.get('/api/wizard/options', async (request, reply) => {
    const signer = virviSigner()
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(scenes)
      .where(eq(scenes.ownerId, request.user.id))
    return reply.send({
      dcl: { virviDeploys: !!signer, virviAddress: signer?.address ?? null },
      hyperfy: { allowed: true, requiredTier: 'free' }, // the wizard is open to everyone
      scenes: {
        used: count,
        limit: config.allFeaturesUnlocked ? null : (await getSubscription(request.user.id)).limits.scenes,
      },
    })
  })

  app.post<{ Body: BootstrapBody }>('/api/wizard/scenes', async (request, reply) => {
    const body = request.body ?? {}
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 120) return reply.status(400).send({ error: 'name is required (up to 120 characters)' })
    if (!validPlot(body.plot)) return reply.status(400).send({ error: 'invalid_plot' })
    if (body.dcl !== undefined && typeof body.dcl !== 'boolean') return reply.status(400).send({ error: 'dcl must be true or false' })
    // Hyperfy and AR have no hard edges: only a Decentraland destination brings the per-parcel budget
    const dclLimits = body.dcl !== false
    const plot: Plot = body.plot
    const size = plotSizeM(plot)
    const budget = dclBudget(plotParcels(plot).length)
    const inPlot = (x: unknown, z: unknown) => isNum(x) && isNum(z) && x >= 0 && x <= size.x && z >= 0 && z <= size.z

    const spawn = body.spawn as { x?: unknown; z?: unknown } | undefined
    if (!spawn || !inPlot(spawn.x, spawn.z)) return reply.status(400).send({ error: 'spawn must be inside the plot' })
    if (!Array.isArray(body.items)) return reply.status(400).send({ error: 'items must be a list' })
    if (dclLimits && body.items.length > budget.entities) {
      return reply.status(400).send({ error: 'too_many_items', message: `This plot fits at most ${budget.entities} items`, limit: budget.entities })
    }
    const items = body.items as Array<{ assetId?: unknown; x?: unknown; z?: unknown; rotationY?: unknown }>
    for (const i of items) {
      if (typeof i?.assetId !== 'string' || !UUID_RE.test(i.assetId) || !inPlot(i.x, i.z) || !isNum(i.rotationY)) {
        return reply.status(400).send({ error: 'Each item needs a catalog assetId, a position inside the plot and a rotationY' })
      }
    }

    // A room set is checked (owner, plot, options) before anything is generated or stored
    let roomSetRequest: { scan: NonNullable<Awaited<ReturnType<typeof loadOwnedScan>>>; options: NonNullable<ReturnType<typeof parseRoomSetOptions>> } | null = null
    if (body.roomSet !== undefined) {
      const rs = body.roomSet as { scanId?: unknown; options?: unknown } | null
      if (!rs || typeof rs !== 'object' || typeof rs.scanId !== 'string') return reply.status(400).send({ error: 'invalid_room_set' })
      const scan = UUID_RE.test(rs.scanId) ? await loadOwnedScan(request.user.id, rs.scanId) : null
      if (!scan) return reply.status(404).send({ error: 'not_found' })
      // The client picks the plot's base (Genesis City parcels), so only the size must match the generated shell
      const needed = plotForLayout(scan.layout)
      if (!needed) return reply.status(422).send({ error: 'too_big' })
      if (needed.width !== plot.width || needed.depth !== plot.depth) return reply.status(400).send({ error: 'plot_mismatch' })
      const options = parseRoomSetOptions(rs.options)
      if (!options) return reply.status(400).send({ error: 'invalid_options' })
      roomSetRequest = { scan, options }
    }

    const assetIds = [...new Set(items.map((i) => i.assetId as string))]
    const assets = assetIds.length
      ? await db
          .select()
          .from(assetLibraryItems)
          .where(and(inArray(assetLibraryItems.id, assetIds), isNotNull(assetLibraryItems.packId), eq(assetLibraryItems.isPublic, true), browsableAsset()))
      : []
    if (assets.length !== assetIds.length || assets.some((a) => !a.cdnUrl)) {
      return reply.status(400).send({ error: 'Every item must be a public catalog model' })
    }
    // An unmeasured asset would under-count the budget, so it can't be placed
    if (assets.some((a) => a.triangleCount === null)) return reply.status(400).send({ error: 'unmeasured_asset' })
    const byId = new Map(assets.map((a) => [a.id, a]))

    const itemTriangles = items.reduce((sum, i) => sum + byId.get(i.assetId as string)!.triangleCount!, 0)
    // Triangles are never a stop: Decentraland only warns about a scene over its recommended count
    // The room model is one more entity on the plot
    if (dclLimits && roomSetRequest && items.length + 1 > budget.entities) {
      return reply.status(422).send({
        error: 'over_budget',
        message: `This plot fits ${budget.entities} items; the chosen items plus the room make ${items.length + 1}`,
        triangles: itemTriangles,
        limit: budget.triangles,
        entities: items.length + 1,
        entityLimit: budget.entities,
      })
    }

    const limitError = await sceneLimitError(request.user.id)
    if (limitError) return reply.status(403).send(limitError)

    let prepared: PreparedRoomSet | null = null
    if (roomSetRequest) {
      try {
        prepared = await prepareRoomSet(request.user.id, roomSetRequest.scan, roomSetRequest.options, [])
      } catch (err) {
        if (err instanceof RoomSetError) return reply.status(err.status).send({ error: err.code })
        throw err
      }
    }

    const create = async (tx: Tx) => {
      const [scene] = await tx.insert(scenes).values({ ownerId: request.user.id, name }).returning({ id: scenes.id })
      const [preset] = await tx.insert(scenePresets).values({ sceneId: scene.id, name: 'Default' }).returning({ id: scenePresets.id })
      await tx.update(scenes).set({ activePresetId: preset.id }).where(eq(scenes.id, scene.id))
      if (assets.length) {
        const elements = await tx
          .insert(sceneElements)
          .values(assets.map((a) => ({ presetId: preset.id, type: 'model' as const, name: a.name, properties: { modelSrc: a.cdnUrl } })))
          .returning({ id: sceneElements.id })
        const elementFor = new Map(assets.map((a, n) => [a.id, elements[n].id]))
        await tx.insert(sceneElementInstances).values(
          items.map((i) => ({
            elementId: elementFor.get(i.assetId as string)!,
            // The dashboard transform editor and the Decentraland adapter both use Euler degrees
            position: { x: i.x as number, y: 0, z: i.z as number },
            rotation: { x: 0, y: i.rotationY as number, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          })),
        )
        await tx.insert(sceneLibrary).values(assets.map((a) => ({ sceneId: scene.id, assetItemId: a.id, addedBy: request.user.id })))
      }
      if (prepared) {
        const [element] = await tx
          .insert(sceneElements)
          .values({ presetId: preset.id, type: 'model', name: `${name} room`, properties: { modelSrc: prepared.glbUrl } })
          .returning({ id: sceneElements.id })
        await tx.insert(sceneElementInstances).values({
          elementId: element.id,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        })
        await insertRoomSet(prepared, { sceneElementId: element.id }, tx)
      }
      return scene.id
    }
    const sceneId = prepared ? await commitRoomSet(prepared, create) : await db.transaction(create)
    return reply.status(201).send({ sceneId })
  })
}
