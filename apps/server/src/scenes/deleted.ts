/**
 * Deleted scenes (LIV-83): soft delete, restore, purge.
 *
 * Deleting sets scenes.deleted_at; the row and every child row stay, so a restore within PURGE_AFTER_DAYS brings the
 * scene back as it was. While deleted the scene is hidden everywhere: getSceneAccess answers 'none' for it (so every
 * route and room that checks access refuses), the deleted-scene route guard (app.ts) answers 404 on any route naming
 * it, and lists, feeds and sweeps leave it out with `liveScene()`. The purge sweep hard-deletes it after the window,
 * through the same path "Delete forever now" takes.
 *
 * Who may delete, restore or purge (`mayManageDeletion`): the scene's owner, an owner or admin of the organization it
 * belongs to, and a platform admin. A scene deleted with its organization keeps `restorer_ids` (the org's owners and
 * admins then), because the org and its members are gone.
 */
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { orgMembers, scenes } from '../db/schema.js'
import type { Actor } from '../auth/actor.js'
import { destroyHostedWorldsFor, type HostingDeps } from '../hyperfy/hosting.js'
import { deleteImportFiles, importsGoingWith } from '../services/import/imports.js'
import { deleteOrphanedRoomSets, sceneOwnedRoomSets } from '../room-scan/sets.js'
import { deleteThumbnailFile } from './thumbnail.js'
import { publishSceneTouched } from '../realtime/bus.js'

export const PURGE_AFTER_DAYS = 30
const DAY_MS = 24 * 60 * 60_000

/** When a scene deleted at `deletedAt` is removed for good. */
export const purgeAtOf = (deletedAt: Date) => new Date(deletedAt.getTime() + PURGE_AFTER_DAYS * DAY_MS)

import { liveScene } from './live.js'
export { liveScene, liveSceneIds, isSceneDeleted } from './live.js'


/** The scene, deleted or not, with the columns deletion needs. */
export async function sceneForDeletion(sceneId: string) {
  const [row] = await db.select().from(scenes).where(eq(scenes.id, sceneId))
  return row ?? null
}

export type DeletableScene = Pick<typeof scenes.$inferSelect, 'ownerId' | 'orgId' | 'restorerIds'>

const ORG_ADMIN_ROLES = ['owner', 'admin'] as const

/**
 * Whether `actor` may delete, restore or purge the scene. Narrow on purpose (getSceneAccess is not widened): co-hosts,
 * editors, collaborators and booking crew never may. A trial only for its own scenes.
 */
export async function mayManageDeletion(actor: Actor, scene: DeletableScene): Promise<boolean> {
  if (!actor.userId) return false
  if (actor.trial) return scene.ownerId === actor.userId
  if (!actor.verified) return false
  if (actor.role === 'admin' || scene.ownerId === actor.userId) return true
  if (scene.restorerIds?.includes(actor.userId)) return true
  if (!scene.orgId) return false
  const [m] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, scene.orgId), eq(orgMembers.userId, actor.userId), inArray(orgMembers.role, [...ORG_ADMIN_ROLES])))
  return !!m
}

/** Marks the scene deleted (only if it isn't already); false when it was. Wakes Hyperfy feed polls so they get 404. */
export async function softDeleteScene(sceneId: string, by: string | null, now = new Date()): Promise<boolean> {
  const done = await db
    .update(scenes)
    .set({ deletedAt: now, deletedBy: by })
    .where(and(eq(scenes.id, sceneId), liveScene()))
    .returning({ id: scenes.id })
  if (done.length) await publishSceneTouched(sceneId)
  return done.length > 0
}

/**
 * Deleting an organization (LIV-83): each of its scenes is soft-deleted (a scene already deleted keeps its own date),
 * unlinked from the org so its row survives the org's cascade, and records who may restore it besides its owner: the
 * org's owners and admins at this moment. Returns how many scenes it deleted.
 */
export async function softDeleteOrgScenes(orgId: string, by: string | null, now = new Date()): Promise<number> {
  const admins = (await db.select({ userId: orgMembers.userId }).from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), inArray(orgMembers.role, [...ORG_ADMIN_ROLES])))).map((m) => m.userId)
  const rows = await db
    .update(scenes)
    .set({ deletedAt: sql`coalesce(${scenes.deletedAt}, ${now.toISOString()}::timestamptz)`, deletedBy: sql`coalesce(${scenes.deletedBy}, ${by}::uuid)`, deletedOrgId: orgId, restorerIds: admins, orgId: null })
    .where(eq(scenes.orgId, orgId))
    .returning({ id: scenes.id })
  for (const r of rows) await publishSceneTouched(r.id)
  return rows.length
}

/** The name a restored scene takes: its own, or with " (restored)" when one of the owner's live scenes has it now. */
export async function restoredName(ownerId: string, name: string, sceneId: string): Promise<string> {
  const [taken] = await db
    .select({ id: scenes.id })
    .from(scenes)
    .where(and(eq(scenes.ownerId, ownerId), eq(scenes.name, name), liveScene(), sql`${scenes.id} <> ${sceneId}`))
    .limit(1)
  return taken ? `${name} (restored)` : name
}

/**
 * Brings a deleted scene back. A scene deleted with its organization becomes `by`'s personal scene (the org is gone).
 * Returns the restored row, or null when the scene isn't deleted (any more).
 */
export async function restoreScene(sceneId: string, by: string) {
  const scene = await sceneForDeletion(sceneId)
  if (!scene?.deletedAt) return null
  const orphaned = !scene.orgId && !!scene.deletedOrgId
  const ownerId = orphaned ? by : scene.ownerId
  const name = await restoredName(ownerId, scene.name, sceneId)
  const [row] = await db
    .update(scenes)
    .set({
      deletedAt: null, deletedBy: null, deletedOrgId: null, restorerIds: null, name, updatedAt: new Date(),
      ...(orphaned ? { ownerId } : {}),
    })
    .where(and(eq(scenes.id, sceneId), isNotNull(scenes.deletedAt)))
    .returning()
  if (row) await publishSceneTouched(sceneId)
  return row ?? null
}

/**
 * Removes the scene for good, as deleting did before LIV-83: hosted worlds still attached are destroyed first (throws
 * HostingError hosted_world_destroy_failed when one couldn't be, and nothing is deleted), then the row and its cascade,
 * the thumbnail, room sets and import files. Media and asset library items stay in their owners' libraries.
 * False when there was no such scene.
 */
export async function hardDeleteScene(sceneId: string, deps?: Partial<HostingDeps>): Promise<boolean> {
  const scene = await sceneForDeletion(sceneId)
  if (!scene) return false
  // Hosted worlds' rows would cascade away with it, leaving their Fly app, database and files running untracked.
  await destroyHostedWorldsFor({ sceneId }, deps)
  // The cascade only unlinks the scene's room sets, so they (and their GLBs) are removed here
  const roomSetsToDelete = await sceneOwnedRoomSets({ sceneId })
  const imports = await importsGoingWith({ sceneId })
  await db.delete(scenes).where(eq(scenes.id, sceneId))
  await deleteThumbnailFile(scene.thumbnailKey)
  await deleteOrphanedRoomSets(roomSetsToDelete)
  await deleteImportFiles(imports)
  await publishSceneTouched(sceneId) // wake waiting Hyperfy feed polls so they get 404 now
  return true
}

/** Hard-deletes every scene deleted more than PURGE_AFTER_DAYS before `now`; one failing (a hosted world) waits for the next run. */
export async function purgeDeletedScenes(now: Date, deps?: Partial<HostingDeps>): Promise<{ purged: number; failed: number }> {
  const due = await db
    .select({ id: scenes.id })
    .from(scenes)
    .where(and(isNotNull(scenes.deletedAt), lt(scenes.deletedAt, new Date(now.getTime() - PURGE_AFTER_DAYS * DAY_MS))))
  let purged = 0
  let failed = 0
  for (const { id } of due) {
    try {
      if (await hardDeleteScene(id, deps)) purged++
    } catch (err) {
      failed++
      console.error('[scene-purge] purging a deleted scene failed:', id, err instanceof Error ? err.message : err)
    }
  }
  return { purged, failed }
}

export const PURGE_SWEEP_MS = DAY_MS
const PURGE_FIRST_RUN_MS = 10 * 60_000
let timer: ReturnType<typeof setInterval> | null = null
let first: ReturnType<typeof setTimeout> | null = null

/** Daily, starting 10 minutes after boot (as the import retention sweep). Safe on several replicas: a purge is idempotent. */
export function startScenePurgeSweep(ms = PURGE_SWEEP_MS, firstAfterMs = PURGE_FIRST_RUN_MS): void {
  if (timer || first) return
  let running = false
  const tick = () => {
    if (running) return
    running = true
    purgeDeletedScenes(new Date())
      .then((r) => { if (r.purged || r.failed) console.log(`[scene-purge] purged ${r.purged} deleted scenes, ${r.failed} failed`) })
      .catch((err) => console.error('[scene-purge] failed:', err))
      .finally(() => { running = false })
  }
  first = setTimeout(() => {
    first = null
    tick()
    timer = setInterval(tick, ms)
    timer.unref?.()
  }, firstAfterMs)
  first.unref?.()
}

export function stopScenePurgeSweep(): void {
  if (first) clearTimeout(first)
  if (timer) clearInterval(timer)
  first = null
  timer = null
}
