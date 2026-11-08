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
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  eventGiveawayLinks, events, eventSceneLinks, giveaways, hyperfyWorlds, mediaAssets, organizations, orgMembers, sceneLibrary, sceneRemovals,
  scenes, streamingServers,
} from '../db/schema.js'
import type { Actor } from '../auth/actor.js'
import { destroyHostedWorldsFor, type HostingDeps } from '../hyperfy/hosting.js'
import { deleteImportFiles, importsGoingWith } from '../services/import/imports.js'
import { deleteOrphanedRoomSets, sceneOwnedRoomSets } from '../room-scan/sets.js'
import { deleteThumbnailFile } from './thumbnail.js'
import { publishSceneTouched, publishVenueEvent } from '../realtime/bus.js'

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
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(and(eq(orgMembers.orgId, scene.orgId), eq(orgMembers.userId, actor.userId), inArray(orgMembers.role, [...ORG_ADMIN_ROLES]), isNull(organizations.deletedAt)))
  return !!m
}

/** A scene just deleted: Hyperfy feed polls wake (they get 404) and its rooms empty and close. */
async function sceneGone(sceneId: string) {
  await publishSceneTouched(sceneId)
  await publishVenueEvent({ type: 'scene_deleted', sceneId }).catch((err) => console.error('[scenes] scene_deleted publish failed:', err))
}

/** Marks the scene deleted (only if it isn't already); false when it was. Wakes Hyperfy feed polls so they get 404. */
export async function softDeleteScene(sceneId: string, by: string | null, now = new Date()): Promise<boolean> {
  const done = await db
    .update(scenes)
    .set({ deletedAt: now, deletedBy: by })
    .where(and(eq(scenes.id, sceneId), liveScene()))
    .returning({ id: scenes.id })
  if (done.length) await sceneGone(sceneId)
  return done.length > 0
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Deleting an organization (LIV-83), in one transaction: the org row is kept and marked deleted (its events, media
 * and streaming servers would cascade away with it otherwise), and each of its scenes is soft-deleted (a scene already
 * deleted keeps its own date), unlinked from the org, and records who may restore it besides its owner: the org's
 * owners and admins at this moment. The purge removes the org row once none of its scenes is left. Returns how many
 * scenes it deleted, or null when there's no such (live) org.
 */
export async function softDeleteOrg(orgId: string, by: string | null, now = new Date()): Promise<number | null> {
  const ids = await db.transaction(async (tx) => {
    const [org] = await tx.update(organizations).set({ deletedAt: now, updatedAt: now })
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt))).returning({ id: organizations.id })
    if (!org) return null
    const admins = (await tx.select({ userId: orgMembers.userId }).from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), inArray(orgMembers.role, [...ORG_ADMIN_ROLES])))).map((m) => m.userId)
    const rows = await tx
      .update(scenes)
      .set({ deletedAt: sql`coalesce(${scenes.deletedAt}, ${now.toISOString()}::timestamptz)`, deletedBy: sql`coalesce(${scenes.deletedBy}, ${by}::uuid)`, deletedOrgId: orgId, restorerIds: admins, orgId: null })
      .where(eq(scenes.orgId, orgId))
      .returning({ id: scenes.id })
    return rows.map((r) => r.id)
  })
  if (ids === null) return null
  for (const id of ids) await sceneGone(id)
  return ids.length
}

/** The name a restored scene takes: its own, or with " (restored)" (" (restored 2)", …) when the owner's live scenes have it. */
export async function restoredName(ownerId: string, name: string, sceneId: string, q: Pick<typeof db, 'select'> = db): Promise<string> {
  const taken = new Set((await q
    .select({ name: scenes.name })
    .from(scenes)
    .where(and(eq(scenes.ownerId, ownerId), liveScene(), sql`${scenes.id} <> ${sceneId}`, sql`${scenes.name} like ${name.replace(/[\\%_]/g, '\\$&') + '%'}`))).map((r) => r.name))
  if (!taken.has(name)) return name
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name} (restored)` : `${name} (restored ${n})`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * A scene of a deleted organization becomes `to`'s own: what the org owned that belongs with the scene moves to them
 * (owner = `to`, org cleared): events linked to the scene and the giveaways linked to those events, the media in the
 * scene's library, the scene's streaming servers; and the scene's Hyperfy worlds are theirs now too.
 */
async function adoptOrgScene(tx: Tx, sceneId: string, orgId: string, to: string) {
  const now = new Date()
  const linkedEvents = tx.select({ id: eventSceneLinks.eventId }).from(eventSceneLinks).where(eq(eventSceneLinks.sceneId, sceneId))
  const movedEvents = await tx.update(events).set({ ownerId: to, orgId: null, updatedAt: now })
    .where(and(inArray(events.id, linkedEvents), eq(events.orgId, orgId))).returning({ id: events.id })
  if (movedEvents.length) {
    const linkedGiveaways = tx.select({ id: eventGiveawayLinks.giveawayId }).from(eventGiveawayLinks)
      .where(inArray(eventGiveawayLinks.eventId, movedEvents.map((e) => e.id)))
    await tx.update(giveaways).set({ ownerId: to, orgId: null }).where(and(inArray(giveaways.id, linkedGiveaways), eq(giveaways.orgId, orgId)))
  }
  const libraryMedia = tx.select({ id: sceneLibrary.mediaAssetId }).from(sceneLibrary).where(and(eq(sceneLibrary.sceneId, sceneId), isNotNull(sceneLibrary.mediaAssetId)))
  await tx.update(mediaAssets).set({ ownerId: to, orgId: null }).where(and(inArray(mediaAssets.id, libraryMedia), eq(mediaAssets.orgId, orgId)))
  await tx.update(streamingServers).set({ ownerId: to, orgId: null }).where(and(eq(streamingServers.sceneId, sceneId), eq(streamingServers.orgId, orgId)))
  await tx.update(hyperfyWorlds).set({ ownerId: to }).where(eq(hyperfyWorlds.sceneId, sceneId))
}

export class RestoreRefused extends Error {
  constructor(public code: 'purging', message: string) {
    super(message)
  }
}

/**
 * Brings a deleted scene back. A scene deleted with its organization becomes `by`'s personal scene (the org is gone),
 * with what the org owned for it (adoptOrgScene). The removals of the delete are cleared: a later delete starts afresh.
 * Returns the restored row and the removals that were done (they don't come back), or null when the scene isn't
 * deleted (any more). Throws RestoreRefused while a purge is under way.
 */
export async function restoreScene(sceneId: string, by: string) {
  const out = await db.transaction(async (tx) => {
    const [scene] = await tx.select().from(scenes).where(eq(scenes.id, sceneId)).for('update')
    if (!scene?.deletedAt) return null
    if (scene.purgingAt) throw new RestoreRefused('purging', 'This scene is being deleted for good right now.')
    const orphaned = !scene.orgId && !!scene.deletedOrgId
    const ownerId = orphaned ? by : scene.ownerId
    const name = await restoredName(ownerId, scene.name, sceneId, tx)
    if (orphaned) await adoptOrgScene(tx, sceneId, scene.deletedOrgId!, by)
    const removed = await tx.delete(sceneRemovals).where(eq(sceneRemovals.sceneId, sceneId)).returning()
    const [row] = await tx
      .update(scenes)
      .set({
        deletedAt: null, deletedBy: null, deletedOrgId: null, restorerIds: null, name, updatedAt: new Date(),
        ...(orphaned ? { ownerId } : {}),
      })
      .where(and(eq(scenes.id, sceneId), isNotNull(scenes.deletedAt), isNull(scenes.purgingAt)))
      .returning()
    return row ? { scene: row, notRestored: removed.filter((r) => r.status === 'done') } : null
  })
  if (out) await publishSceneTouched(sceneId)
  return out
}

/** How long a purge's claim holds before another may take over (a purge that crashed half way). */
const PURGE_CLAIM_MS = 30 * 60_000

/**
 * Removes the scene for good, as deleting did before LIV-83. It first claims the row: only while it's still deleted
 * (and, for the sweep, deleted before `cutoff`) and nobody else is purging it, so a restore that won the race keeps
 * its scene, and a restore can't start while hosted worlds are being destroyed. Then hosted worlds still attached are
 * destroyed (throws HostingError hosted_world_destroy_failed when one couldn't be: the claim is released and nothing
 * is deleted), then the row (still deleted and still ours) and its cascade, the thumbnail, room sets and import files.
 * Media and asset library items stay in their owners' libraries. False when there was nothing to purge.
 */
export async function hardDeleteScene(sceneId: string, opts: { cutoff?: Date; deps?: Partial<HostingDeps> } = {}): Promise<boolean> {
  const now = new Date()
  const [claimed] = await db.update(scenes).set({ purgingAt: now })
    .where(and(
      eq(scenes.id, sceneId), isNotNull(scenes.deletedAt),
      ...(opts.cutoff ? [lt(scenes.deletedAt, opts.cutoff)] : []),
      or(isNull(scenes.purgingAt), lt(scenes.purgingAt, new Date(now.getTime() - PURGE_CLAIM_MS))),
    ))
    .returning()
  if (!claimed) return false
  try {
    // Hosted worlds' rows would cascade away with it, leaving their Fly app, database and files running untracked.
    await destroyHostedWorldsFor({ sceneId }, opts.deps)
  } catch (err) {
    await db.update(scenes).set({ purgingAt: null }).where(and(eq(scenes.id, sceneId), eq(scenes.purgingAt, now)))
    throw err
  }
  // The cascade only unlinks the scene's room sets, so they (and their GLBs) are removed here
  const roomSetsToDelete = await sceneOwnedRoomSets({ sceneId })
  const imports = await importsGoingWith({ sceneId })
  const gone = await db.delete(scenes).where(and(eq(scenes.id, sceneId), isNotNull(scenes.deletedAt), eq(scenes.purgingAt, now))).returning({ id: scenes.id })
  if (!gone.length) return false
  await deleteThumbnailFile(claimed.thumbnailKey)
  await deleteOrphanedRoomSets(roomSetsToDelete)
  await deleteImportFiles(imports)
  await publishSceneTouched(sceneId) // wake waiting Hyperfy feed polls so they get 404 now
  return true
}

/**
 * Hard-deletes every scene deleted more than PURGE_AFTER_DAYS before `now` (one failing, a hosted world, waits for the
 * next run), then the rows of deleted organizations none of whose scenes is left deleted.
 */
export async function purgeDeletedScenes(now: Date, deps?: Partial<HostingDeps>): Promise<{ purged: number; failed: number }> {
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY_MS)
  const due = await db.select({ id: scenes.id }).from(scenes).where(and(isNotNull(scenes.deletedAt), lt(scenes.deletedAt, cutoff)))
  let purged = 0
  let failed = 0
  for (const { id } of due) {
    try {
      if (await hardDeleteScene(id, { cutoff, deps })) purged++
    } catch (err) {
      failed++
      console.error('[scene-purge] purging a deleted scene failed:', id, err instanceof Error ? err.message : err)
    }
  }
  await purgeDeletedOrgs()
  return { purged, failed }
}

/** Deleted organizations with no scene left deleted for them (all purged or restored) go for good, with what's left of theirs. */
export async function purgeDeletedOrgs(): Promise<number> {
  const gone = await db.delete(organizations).where(and(
    isNotNull(organizations.deletedAt),
    sql`NOT EXISTS (SELECT 1 FROM scenes WHERE scenes.deleted_org_id = ${organizations.id} OR scenes.org_id = ${organizations.id})`,
  )).returning({ id: organizations.id })
  return gone.length
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
