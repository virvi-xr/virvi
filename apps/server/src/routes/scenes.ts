import type { FastifyInstance } from 'fastify'
import { eq, and, or, isNull, sql, inArray } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  scenes,
  scenePresets,
  sceneElements,
  sceneElementInstances,
  sceneCollaborators,
  sceneRoles,
  users,
} from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import type { AuthUser } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess, isHostAccess, canWriteElement, diffKeys } from '../auth/permissions.js'
import { config } from '../config.js'
import { publishElementChanged, publishSceneTouched } from '../realtime/bus.js'
import { dispatchPlatformCallbacks } from '../integrations/platform-hooks.js'
import { serializeSingleElement } from '../services/scene-serializer.js'
import { getSubscription } from '../integrations/stripe.js'
import { hostedWorldsBlockingDelete } from '../hyperfy/hosting.js'
import { authorizeVideoControl } from '../ws/scene-guard.js'
import { boundScene, fromElement, fromInstance, fromParam, fromPreset, isScenePass } from '../auth/scene-from.js'
import { commitRoomSet, deleteOrphanedRoomSets, insertRoomSet, prepareRoomSetForPlacement, RoomSetError, roomSetIdsByElement, sceneOwnedRoomSets, type PreparedRoomSet } from '../room-scan/sets.js'

type ElementChange = Parameters<typeof publishElementChanged>[0]

/** Structural keys left out of platform callback payloads (as the scene room's compact payload does). */
const NON_CONFIG_KEYS = new Set(['sk', 'id', 'pk', 'instances', 'instanceIds', 'services', 'entity'])

/**
 * Push a REST element/instance write to HTTP platform callbacks (Second Life etc.) — the scene room
 * does the same for room-sent updates. Only edits to the scene's active preset are pushed.
 */
async function dispatchElementCallbacks(e: ElementChange): Promise<void> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, e.sceneId) })
  if (!scene || scene.activePresetId !== e.presetId) return
  if (e.deleted) {
    await dispatchPlatformCallbacks(e.sceneId, { action: 'config_update', elementId: e.elementId, element: e.elementType, deleted: true })
    return
  }
  const element = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, e.elementId), with: { instances: true } })
  if (!element || element.presetId !== e.presetId) return
  const compact: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(serializeSingleElement(element))) {
    if (value !== undefined && !NON_CONFIG_KEYS.has(key)) compact[key] = value
  }
  await dispatchPlatformCallbacks(e.sceneId, { ...compact, action: 'config_update', elementId: e.elementId, element: element.type })
}

/** After a REST write: broadcast to scene rooms, and push to platform callbacks (fire-and-forget, errors swallowed). */
async function elementChanged(e: ElementChange): Promise<void> {
  await publishElementChanged(e)
  await publishSceneTouched(e.sceneId)
  void dispatchElementCallbacks(e).catch((err) => console.error('[scenes] platform callback dispatch failed:', err))
}

interface CreateSceneBody {
  name: string
  description?: string
}

interface CreateElementBody {
  type: 'image' | 'video' | 'nft' | 'sound' | 'widget' | 'model' | 'custom' | 'ad_space'
  name: string
  enabled?: boolean
  customId?: string
  customRendering?: boolean
  clickEvent?: unknown
  properties?: unknown
}

interface CreateInstanceBody {
  enabled?: boolean
  customId?: string
  customRendering?: boolean
  position?: unknown
  rotation?: unknown
  scale?: unknown
  clickEvent?: unknown
  parentInstanceId?: string
  withCollisions?: boolean
  properties?: unknown
}

interface UpdateInstanceBody {
  enabled?: boolean
  customId?: string
  customRendering?: boolean
  position?: unknown
  rotation?: unknown
  scale?: unknown
  clickEvent?: unknown
  parentInstanceId?: string | null
  withCollisions?: boolean
  properties?: unknown
}

/** The 403 body when `userId` is at their plan's scene limit; null when they may create another (always null in self-hosted mode). */
export async function sceneLimitError(userId: string) {
  if (config.allFeaturesUnlocked) return null
  const sub = await getSubscription(userId)
  const limit = sub.limits.scenes
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scenes)
    .where(eq(scenes.ownerId, userId))
  if (count < limit) return null
  return {
    error: 'scene_limit_reached' as const,
    message: `Your ${sub.tier} plan allows up to ${limit} scenes. Please upgrade to create more.`,
    currentUsage: count,
    limit,
    tier: sub.tier as string,
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Same limit as the New Scene Wizard. */
const SCENE_NAME_MAX = 120

export default async function sceneRoutes(app: FastifyInstance) {
  // All scene routes require authentication
  app.addHook('preHandler', authenticate)

  const accessFor = (request: { user: AuthUser }, sceneId: string) =>
    getSceneAccess(actorFromClaims(request.user), sceneId)

  // ── GET /api/scenes — list user's scenes ─────────────────────────────────

  app.get('/api/scenes', { config: { scenePass: { sceneFrom: boundScene } } }, async (request, reply) => {
    const actor = actorFromClaims(request.user)
    if (!actor.userId || !actor.verified) return reply.send({ scenes: [] })
    const owned = await db.query.scenes.findMany({
      where: eq(scenes.ownerId, request.user.id),
      orderBy: (scenes, { desc }) => [desc(scenes.updatedAt)],
    })
    const collabs = await db.query.sceneCollaborators.findMany({
      where: eq(sceneCollaborators.userId, request.user.id),
    })
    const shared = collabs.length
      ? await db.query.scenes.findMany({
          where: inArray(scenes.id, collabs.map((c) => c.sceneId)),
          orderBy: (scenes, { desc }) => [desc(scenes.updatedAt)],
        })
      : []
    const actorWallet = actor.wallet
    const roleRows = await db
      .select({ sceneId: sceneRoles.sceneId, role: sceneRoles.role })
      .from(sceneRoles)
      .where(
        and(
          isNull(sceneRoles.revokedAt),
          actorWallet
            ? or(eq(sceneRoles.userId, actor.userId), eq(sceneRoles.walletAddress, actorWallet))
            : eq(sceneRoles.userId, actor.userId),
        ),
      )
    const rank: Record<string, number> = { owner: 4, cohost: 3, editor: 2, viewer: 1 }
    const best = new Map<string, string>()
    const consider = (sceneId: string, role: string) => {
      const cur = best.get(sceneId)
      if (!cur || rank[role] > rank[cur]) best.set(sceneId, role)
    }
    for (const c of collabs) consider(c.sceneId, c.role)
    for (const r of roleRows) consider(r.sceneId, r.role)

    const ownedIds = new Set(owned.map((s) => s.id))
    const sharedIds = new Set(shared.map((s) => s.id))
    const extraIds = roleRows.map((r) => r.sceneId).filter((id) => !ownedIds.has(id) && !sharedIds.has(id))
    const extra = extraIds.length
      ? await db.query.scenes.findMany({
          where: inArray(scenes.id, [...new Set(extraIds)]),
          orderBy: (scenes, { desc }) => [desc(scenes.updatedAt)],
        })
      : []
    const list = [
      ...owned.map((s) => ({ ...s, relationship: 'owner' as const })),
      ...[...shared, ...extra].map((s) => ({ ...s, relationship: best.get(s.id)! })),
    ]
    // A scene pass sees only its own scene (the guard already required a bound sceneId).
    return reply.send({ scenes: isScenePass(request.user) ? list.filter((s) => s.id === request.user.sceneId) : list })
  })

  // ── POST /api/scenes — create scene ──────────────────────────────────────

  app.post<{ Body: CreateSceneBody }>('/api/scenes', async (request, reply) => {
    const { name, description } = request.body

    if (!name) {
      return reply.status(400).send({ error: 'name is required' })
    }

    // Enforce scene limit based on subscription tier (skip in self-hosted mode)
    const limitError = await sceneLimitError(request.user.id)
    if (limitError) return reply.status(403).send(limitError)

    const [scene] = await db
      .insert(scenes)
      .values({
        ownerId: request.user.id,
        name,
        description: description || null,
      })
      .returning()

    // Auto-create a default preset
    const [preset] = await db
      .insert(scenePresets)
      .values({
        sceneId: scene.id,
        name: 'Default',
      })
      .returning()

    // Set the active preset
    await db
      .update(scenes)
      .set({ activePresetId: preset.id })
      .where(eq(scenes.id, scene.id))

    return reply.status(201).send({
      scene: { ...scene, activePresetId: preset.id },
      preset,
    })
  })

  // ── GET /api/scenes/:sceneId — get scene with full nested data ───────────

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId', { config: { scenePass: { sceneFrom: fromParam('sceneId'), hyperfy: true, ar: true } } }, async (request, reply) => {
    const { sceneId } = request.params

    const scene = await db.query.scenes.findFirst({
      where: eq(scenes.id, sceneId),
      with: {
        presets: {
          with: {
            elements: {
              with: {
                instances: true,
              },
            },
          },
        },
        collaborators: true,
      },
    })

    if (!scene) {
      return reply.status(404).send({ error: 'Scene not found' })
    }

    // Check ownership or collaboration
    const access = await accessFor(request, sceneId)
    if (access.level === 'none') return reply.status(403).send({ error: 'Forbidden' })

    // Model elements carry the id of their room set (null when they're an ordinary model), looked up in one query
    const withRoomSets = async <P extends (typeof scene.presets)[number]>(presets: P[]) => {
      const modelIds = presets.flatMap((p) => p.elements.filter((e) => e.type === 'model').map((e) => e.id))
      const ids = await roomSetIdsByElement(modelIds)
      return presets.map((p) => ({
        ...p,
        elements: p.elements.map((e) => (e.type === 'model' ? { ...e, roomSetId: ids.get(e.id) ?? null } : e)),
      }))
    }

    if (access.level === 'grant') {
      // Venue crew see only what's live and their own booking's copy — never the
      // owner's other presets, other renters' bookings, or the collaborator list.
      const visible = new Set([scene.activePresetId, access.booking?.bookingPresetId].filter(Boolean))
      const { collaborators: _hidden, ...rest } = scene
      return reply.send({ scene: { ...rest, presets: await withRoomSets(scene.presets.filter((p) => visible.has(p.id))) } })
    }

    return reply.send({ scene: { ...scene, presets: await withRoomSets(scene.presets) } })
  })

  // ── PUT /api/scenes/:sceneId — update scene ─────────────────────────────

  app.put<{ Params: { sceneId: string }; Body: Partial<CreateSceneBody> & { activePresetId?: string } }>(
    '/api/scenes/:sceneId',
    { config: { scenePass: { sceneFrom: fromParam('sceneId'), hyperfy: true, ar: true } } },
    async (request, reply) => {
      const { sceneId } = request.params
      const { name, description, activePresetId } = request.body

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })
      if (!hasScope(await accessFor(request, sceneId), 'scene.edit')) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (name !== undefined) {
        const trimmed = typeof name === 'string' ? name.trim() : ''
        if (!trimmed || trimmed.length > SCENE_NAME_MAX) {
          return reply.status(400).send({ error: 'bad_name', message: `A scene name is required (up to ${SCENE_NAME_MAX} characters)` })
        }
        updates.name = trimmed
      }
      if (description !== undefined) updates.description = description
      if (activePresetId !== undefined) {
        // The live preset must be one of this scene's own (rooms and setup load it by id).
        if (activePresetId !== null) {
          const ok =
            typeof activePresetId === 'string' &&
            UUID_RE.test(activePresetId) &&
            (await db.query.scenePresets.findFirst({ where: and(eq(scenePresets.id, activePresetId), eq(scenePresets.sceneId, sceneId)), columns: { id: true } }))
          if (!ok) return reply.status(400).send({ error: 'Preset does not belong to this scene' })
        }
        updates.activePresetId = activePresetId
      }

      const [updated] = await db.update(scenes).set(updates).where(eq(scenes.id, sceneId)).returning()
      if (activePresetId !== undefined) await publishSceneTouched(sceneId)
      return reply.send({ scene: updated })
    },
  )

  // ── DELETE /api/scenes/:sceneId — delete scene ───────────────────────────

  app.delete<{ Params: { sceneId: string } }>('/api/scenes/:sceneId', async (request, reply) => {
    const { sceneId } = request.params

    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
    if (!scene) return reply.status(404).send({ error: 'Scene not found' })
    // Host-only: co-hosts hold scene.admin but may not delete the scene.
    if (!isHostAccess(await accessFor(request, sceneId))) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    // Hosted worlds' rows would cascade away with it, leaving their Fly app, database and files running untracked.
    const blocked = await hostedWorldsBlockingDelete({ sceneId })
    if (blocked) return reply.status(409).send(blocked)
    // The cascade only unlinks the scene's room sets, so they (and their GLBs) are removed here
    const roomSetsToDelete = await sceneOwnedRoomSets({ sceneId })
    await db.delete(scenes).where(eq(scenes.id, sceneId))
    await deleteOrphanedRoomSets(roomSetsToDelete)
    await publishSceneTouched(sceneId) // wake waiting Hyperfy feed polls so they get 404 now
    return reply.status(204).send()
  })

  // ── POST /api/scenes/:sceneId/presets — create preset ────────────────────

  app.post<{ Params: { sceneId: string }; Body: { name: string; locale?: string } }>(
    '/api/scenes/:sceneId/presets',
    async (request, reply) => {
      const { sceneId } = request.params
      const { name, locale } = request.body

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })
      if (!hasScope(await accessFor(request, sceneId), 'scene.edit')) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const [preset] = await db
        .insert(scenePresets)
        .values({ sceneId, name, locale: locale || null })
        .returning()

      return reply.status(201).send({ preset })
    },
  )

  // ── POST /api/presets/:presetId/elements — create element ────────────────

  app.post<{ Params: { presetId: string }; Body: CreateElementBody }>(
    '/api/presets/:presetId/elements',
    { config: { scenePass: { sceneFrom: fromPreset, hyperfy: true, ar: true } } },
    async (request, reply) => {
      const { presetId } = request.params
      const { type, name, enabled, customId, customRendering, clickEvent, properties } = request.body

      if (!type || !name) {
        return reply.status(400).send({ error: 'type and name are required' })
      }

      // Verify preset exists and user has access
      const preset = await db.query.scenePresets.findFirst({
        where: eq(scenePresets.id, presetId),
        with: { scene: true },
      })
      if (!preset) return reply.status(404).send({ error: 'Preset not found' })
      if (!hasScope(await accessFor(request, preset.sceneId), 'scene.edit')) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // A room-set asset gets the scene's own copy of its set (generated and uploaded before the transaction)
      let prepared: PreparedRoomSet | null = null
      try {
        if (type === 'model') prepared = await prepareRoomSetForPlacement((properties as { modelSrc?: unknown } | null)?.modelSrc, preset.sceneId, request.user.id)
      } catch (err) {
        if (err instanceof RoomSetError) return reply.status(err.status).send({ error: err.code })
        throw err
      }

      const insertElement = (exec: Pick<typeof db, 'insert'>, props: unknown) =>
        exec
          .insert(sceneElements)
          .values({
            presetId,
            type,
            name,
            enabled: enabled ?? true,
            customId: customId || null,
            customRendering: customRendering ?? false,
            clickEvent: clickEvent ?? null,
            properties: props ?? null,
          })
          .returning()

      const room = prepared
      const { element, roomSetId } = room
        ? await commitRoomSet(room, async (tx) => {
            const [el] = await insertElement(tx, { ...(properties as Record<string, unknown>), modelSrc: room.glbUrl })
            const set = await insertRoomSet(room, { sceneElementId: el.id }, tx)
            return { element: el, roomSetId: set.id as string | null }
          })
        : { element: (await insertElement(db, properties))[0], roomSetId: null }

      await elementChanged({
        sceneId: preset.sceneId,
        presetId,
        elementId: element.id,
        elementType: element.type,
        deleted: false,
      })
      return reply.status(201).send({ element: type === 'model' ? { ...element, roomSetId } : element })
    },
  )

  // ── PUT /api/elements/:elementId — update element ────────────────────────

  app.put<{ Params: { elementId: string }; Body: Partial<CreateElementBody> }>(
    '/api/elements/:elementId',
    { config: { scenePass: { sceneFrom: fromElement, hyperfy: true, ar: true } } },
    async (request, reply) => {
      const { elementId } = request.params

      const element = await db.query.sceneElements.findFirst({
        where: eq(sceneElements.id, elementId),
        with: { preset: { with: { scene: true } } },
      })
      if (!element) return reply.status(404).send({ error: 'Element not found' })
      const access = await accessFor(request, element.preset.sceneId)
      const propertyKeys =
        request.body.properties !== undefined
          ? diffKeys(element.properties as Record<string, unknown> | null, request.body.properties as Record<string, unknown>)
          : []
      const fieldKeys = (['type', 'name', 'enabled', 'customId', 'customRendering', 'clickEvent'] as const).filter(
        (k) => request.body[k] !== undefined && JSON.stringify(request.body[k]) !== JSON.stringify((element as any)[k]),
      )
      if (!canWriteElement(access, element, { propertyKeys, fieldKeys })) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      for (const key of ['type', 'name', 'enabled', 'customId', 'customRendering', 'clickEvent', 'properties'] as const) {
        if (request.body[key] !== undefined) updates[key] = request.body[key]
      }

      const [updated] = await db
        .update(sceneElements)
        .set(updates)
        .where(eq(sceneElements.id, elementId))
        .returning()

      await elementChanged({
        sceneId: element.preset.sceneId,
        presetId: element.presetId,
        elementId,
        elementType: updated.type,
        deleted: false,
      })
      return reply.send({ element: updated })
    },
  )

  // ── POST /api/elements/:elementId/live — turn a screen's live stream on or off ──

  app.post<{ Params: { elementId: string }; Body: { enabled?: unknown } }>(
    '/api/elements/:elementId/live',
    { config: { scenePass: { sceneFrom: fromElement, hyperfy: true, ar: true } } },
    async (request, reply) => {
      const { elementId } = request.params
      const enabled = request.body?.enabled
      if (typeof enabled !== 'boolean') return reply.status(400).send({ error: 'enabled must be a boolean' })

      const element = await db.query.sceneElements.findFirst({
        where: eq(sceneElements.id, elementId),
        with: { preset: true },
      })
      if (!element) return reply.status(404).send({ error: 'Element not found' })
      // The same rules as the room's scene_video_update
      const sceneId = element.preset.sceneId
      const auth = await authorizeVideoControl(await accessFor(request, sceneId), sceneId, elementId)
      if (!auth.ok) return reply.status(auth.code === 'not_found' ? 404 : 403).send({ error: auth.code === 'not_found' ? 'Element not found' : 'Forbidden' })
      if (element.type !== 'video') return reply.status(400).send({ error: 'Only video elements have a live stream' })

      const [updated] = await db
        .update(sceneElements)
        .set({ properties: { ...((element.properties as Record<string, unknown> | null) ?? {}), enableLiveStream: enabled }, updatedAt: new Date() })
        .where(eq(sceneElements.id, elementId))
        .returning()

      // Rooms push the element's full state (enableLiveStream included) to connected clients
      await elementChanged({ sceneId, presetId: element.presetId, elementId, elementType: updated.type, deleted: false })
      return reply.send({ element: updated })
    },
  )

  // ── DELETE /api/elements/:elementId — delete element (and its instances) ─

  app.delete<{ Params: { elementId: string } }>(
    '/api/elements/:elementId',
    { config: { scenePass: { sceneFrom: fromElement, hyperfy: true, ar: true } } },
    async (request, reply) => {
      const { elementId } = request.params

      const element = await db.query.sceneElements.findFirst({
        where: eq(sceneElements.id, elementId),
        with: { preset: { with: { scene: true } } },
      })
      if (!element) return reply.status(404).send({ error: 'Element not found' })
      // Deleting is structural (like instance delete and the room's delete guard): editors only, never renters.
      if (!hasScope(await accessFor(request, element.preset.sceneId), 'scene.edit')) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const roomSetsToDelete = await sceneOwnedRoomSets({ elementId })
      await db.delete(sceneElements).where(eq(sceneElements.id, elementId))
      await deleteOrphanedRoomSets(roomSetsToDelete)
      await elementChanged({
        sceneId: element.preset.sceneId,
        presetId: element.presetId,
        elementId,
        elementType: element.type,
        deleted: true,
      })
      return reply.status(204).send()
    },
  )

  // ── POST /api/elements/:elementId/instances — create instance ────────────

  app.post<{ Params: { elementId: string }; Body: CreateInstanceBody }>(
    '/api/elements/:elementId/instances',
    { config: { scenePass: { sceneFrom: fromElement, hyperfy: true, ar: true } } },
    async (request, reply) => {
      const { elementId } = request.params

      const element = await db.query.sceneElements.findFirst({
        where: eq(sceneElements.id, elementId),
        with: { preset: { with: { scene: true } } },
      })
      if (!element) return reply.status(404).send({ error: 'Element not found' })
      if (!hasScope(await accessFor(request, element.preset.sceneId), 'scene.edit')) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const {
        enabled,
        customId,
        customRendering,
        position,
        rotation,
        scale,
        clickEvent,
        parentInstanceId,
        withCollisions,
        properties,
      } = request.body

      const [instance] = await db
        .insert(sceneElementInstances)
        .values({
          elementId,
          enabled: enabled ?? true,
          customId: customId || null,
          customRendering: customRendering ?? false,
          position: position ?? null,
          rotation: rotation ?? null,
          scale: scale ?? null,
          clickEvent: clickEvent ?? null,
          parentInstanceId: parentInstanceId || null,
          withCollisions: withCollisions ?? false,
          properties: properties ?? null,
        })
        .returning()

      await elementChanged({
        sceneId: element.preset.sceneId,
        presetId: element.presetId,
        elementId,
        elementType: element.type,
        deleted: false,
      })
      return reply.status(201).send({ instance })
    },
  )

  // ── PUT /api/instances/:instanceId — update instance ─────────────────────

  app.put<{ Params: { instanceId: string }; Body: UpdateInstanceBody }>(
    '/api/instances/:instanceId',
    { config: { scenePass: { sceneFrom: fromInstance, hyperfy: true, ar: true } } },
    async (request, reply) => {
      const { instanceId } = request.params

      const instance = await db.query.sceneElementInstances.findFirst({
        where: eq(sceneElementInstances.id, instanceId),
        with: { element: { with: { preset: { with: { scene: true } } } } },
      })
      if (!instance) return reply.status(404).send({ error: 'Instance not found' })
      if (!hasScope(await accessFor(request, instance.element.preset.sceneId), 'scene.edit')) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      for (const key of [
        'enabled',
        'customId',
        'customRendering',
        'position',
        'rotation',
        'scale',
        'clickEvent',
        'parentInstanceId',
        'withCollisions',
        'properties',
      ] as const) {
        if (request.body[key] !== undefined) updates[key] = request.body[key]
      }

      const [updated] = await db
        .update(sceneElementInstances)
        .set(updates)
        .where(eq(sceneElementInstances.id, instanceId))
        .returning()

      await elementChanged({
        sceneId: instance.element.preset.sceneId,
        presetId: instance.element.presetId,
        elementId: instance.elementId,
        elementType: instance.element.type,
        deleted: false,
      })
      return reply.send({ instance: updated })
    },
  )

  // ── DELETE /api/instances/:instanceId — delete instance ──────────────────

  app.delete<{ Params: { instanceId: string } }>(
    '/api/instances/:instanceId',
    { config: { scenePass: { sceneFrom: fromInstance } } },
    async (request, reply) => {
      const { instanceId } = request.params

      const instance = await db.query.sceneElementInstances.findFirst({
        where: eq(sceneElementInstances.id, instanceId),
        with: { element: { with: { preset: { with: { scene: true } } } } },
      })
      if (!instance) return reply.status(404).send({ error: 'Instance not found' })
      if (!hasScope(await accessFor(request, instance.element.preset.sceneId), 'scene.edit')) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      await db.delete(sceneElementInstances).where(eq(sceneElementInstances.id, instanceId))
      await elementChanged({
        sceneId: instance.element.preset.sceneId,
        presetId: instance.element.presetId,
        elementId: instance.elementId,
        elementType: instance.element.type,
        deleted: false,
      })
      return reply.status(204).send()
    },
  )

  // ── GET /api/scenes/:sceneId/collaborators — list collaborators ────────

  app.get<{ Params: { sceneId: string } }>(
    '/api/scenes/:sceneId/collaborators',
    async (request, reply) => {
      const { sceneId } = request.params

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })

      const access = await accessFor(request, sceneId)
      const level = access.level
      if (level === 'none' || level === 'grant') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // Fetch collaborators with user info
      const collabs = await db
        .select({
          userId: sceneCollaborators.userId,
          role: sceneCollaborators.role,
          displayName: users.displayName,
          email: users.email,
        })
        .from(sceneCollaborators)
        .innerJoin(users, eq(sceneCollaborators.userId, users.id))
        .where(eq(sceneCollaborators.sceneId, sceneId))

      // Also include the owner
      const owner = await db.query.users.findFirst({ where: eq(users.id, scene.ownerId) })
      const collaborators = [
        ...(owner
          ? [{ userId: owner.id, role: 'owner' as const, displayName: owner.displayName, email: owner.email }]
          : []),
        ...collabs,
      ]

      // Emails only for people who manage the scene; editors/viewers see names and roles.
      if (!isFullAccess(access)) {
        return reply.send({ collaborators: collaborators.map(({ email: _email, ...rest }) => rest) })
      }
      return reply.send({ collaborators })
    },
  )

  // ── POST /api/scenes/:sceneId/collaborators — add collaborator ─────────

  app.post<{ Params: { sceneId: string }; Body: { email: string; role: string } }>(
    '/api/scenes/:sceneId/collaborators',
    async (request, reply) => {
      const { sceneId } = request.params
      const { email, role } = request.body

      if (!email || !role) {
        return reply.status(400).send({ error: 'email and role are required' })
      }
      if (role !== 'editor' && role !== 'viewer') {
        return reply.status(400).send({ error: 'role must be editor or viewer' })
      }

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })

      // Only owner can add collaborators
      if (!hasScope(await accessFor(request, sceneId), 'scene.admin')) {
        return reply.status(403).send({ error: 'Only the scene owner can add collaborators' })
      }

      // Look up user by email
      const targetUser = await db.query.users.findFirst({ where: eq(users.email, email) })
      if (!targetUser) {
        return reply.status(404).send({ error: 'User not found with that email' })
      }

      // Cannot add the owner as a collaborator
      if (targetUser.id === scene.ownerId) {
        return reply.status(409).send({ error: 'That user is already the scene owner' })
      }

      // Check if already a collaborator
      const existing = await db.query.sceneCollaborators.findFirst({
        where: and(
          eq(sceneCollaborators.sceneId, sceneId),
          eq(sceneCollaborators.userId, targetUser.id),
        ),
      })
      if (existing) {
        return reply.status(409).send({ error: 'User is already a collaborator' })
      }

      const [collab] = await db
        .insert(sceneCollaborators)
        .values({
          sceneId,
          userId: targetUser.id,
          role: role as 'editor' | 'viewer',
        })
        .returning()

      return reply.status(201).send({
        collaborator: {
          userId: targetUser.id,
          role: collab.role,
          displayName: targetUser.displayName,
          email: targetUser.email,
        },
      })
    },
  )

  // ── PUT /api/scenes/:sceneId/collaborators/:userId — update role ───────

  app.put<{ Params: { sceneId: string; userId: string }; Body: { role: string } }>(
    '/api/scenes/:sceneId/collaborators/:userId',
    async (request, reply) => {
      const { sceneId, userId } = request.params
      const { role } = request.body

      if (!role || (role !== 'editor' && role !== 'viewer')) {
        return reply.status(400).send({ error: 'role must be editor or viewer' })
      }

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })

      // Only owner can change roles
      if (!hasScope(await accessFor(request, sceneId), 'scene.admin')) {
        return reply.status(403).send({ error: 'Only the scene owner can change roles' })
      }

      const existing = await db.query.sceneCollaborators.findFirst({
        where: and(
          eq(sceneCollaborators.sceneId, sceneId),
          eq(sceneCollaborators.userId, userId),
        ),
      })
      if (!existing) {
        return reply.status(404).send({ error: 'Collaborator not found' })
      }

      const [updated] = await db
        .update(sceneCollaborators)
        .set({ role: role as 'editor' | 'viewer' })
        .where(
          and(
            eq(sceneCollaborators.sceneId, sceneId),
            eq(sceneCollaborators.userId, userId),
          ),
        )
        .returning()

      return reply.send({ collaborator: updated })
    },
  )

  // ── DELETE /api/scenes/:sceneId/collaborators/:userId — remove ─────────

  app.delete<{ Params: { sceneId: string; userId: string } }>(
    '/api/scenes/:sceneId/collaborators/:userId',
    async (request, reply) => {
      const { sceneId, userId } = request.params

      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })

      const isSelf = userId === request.user.id

      // Admins can remove anyone; collaborators can remove themselves
      if (!isSelf && !hasScope(await accessFor(request, sceneId), 'scene.admin')) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const existing = await db.query.sceneCollaborators.findFirst({
        where: and(
          eq(sceneCollaborators.sceneId, sceneId),
          eq(sceneCollaborators.userId, userId),
        ),
      })
      if (!existing) {
        return reply.status(404).send({ error: 'Collaborator not found' })
      }

      await db
        .delete(sceneCollaborators)
        .where(
          and(
            eq(sceneCollaborators.sceneId, sceneId),
            eq(sceneCollaborators.userId, userId),
          ),
        )

      return reply.status(204).send()
    },
  )
}
