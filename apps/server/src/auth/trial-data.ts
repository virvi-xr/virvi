import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { arDevices, roomScans, roomSets, sceneImports, sceneLibrary, scenes } from '../db/schema.js'
import { getBuildRunner } from '../services/import/build-runner.js'
import { deleteImportFiles, importsGoingWith } from '../services/import/imports.js'
import { deleteThumbnailFile } from '../scenes/thumbnail.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Moves a trial's scene-builder data onto the account it signs in to, inside mergeTrial's transaction: its scenes
 * (with presets, elements, instances, thumbnails), scene imports (a sandbox import stays sandbox, so the account
 * claims it for its place when it deploys it), room scans and sets, and headsets. Scenes stay personal (org_id null).
 * Nothing is checked against the account's limits: they stop new work, not moved work (no plan limits scenes).
 */
export async function moveTrialSceneData(tx: Tx, fromUserId: string, toUserId: string): Promise<void> {
  if (fromUserId === toUserId) return
  await tx.update(scenes).set({ ownerId: toUserId }).where(eq(scenes.ownerId, fromUserId))
  await tx.update(sceneImports).set({ userId: toUserId }).where(eq(sceneImports.userId, fromUserId))
  await tx.update(roomScans).set({ userId: toUserId }).where(eq(roomScans.userId, fromUserId))
  await tx.update(roomSets).set({ userId: toUserId }).where(eq(roomSets.userId, fromUserId))
  await tx.update(arDevices).set({ userId: toUserId }).where(eq(arDevices.userId, fromUserId))
  await tx.update(sceneLibrary).set({ addedBy: toUserId }).where(eq(sceneLibrary.addedBy, fromUserId))
}

export interface TrialLeftovers {
  importIds: string[]
  buildingMachines: string[]
  thumbnailKeys: string[]
}

/** What outlives a trial's row outside the database: its imports' files and build machines, its scenes' thumbnails. Read before the delete. */
export async function trialLeftovers(userId: string): Promise<TrialLeftovers> {
  const importIds = await importsGoingWith({ userId })
  const machines = importIds.length
    ? await db.select({ machineId: sceneImports.machineId }).from(sceneImports)
      .where(and(inArray(sceneImports.id, importIds), inArray(sceneImports.status, ['uploaded', 'building']), isNotNull(sceneImports.machineId)))
    : []
  const thumbs = await db.select({ key: scenes.thumbnailKey }).from(scenes).where(and(eq(scenes.ownerId, userId), isNotNull(scenes.thumbnailKey)))
  return {
    importIds,
    buildingMachines: machines.map((m) => m.machineId!),
    thumbnailKeys: thumbs.map((t) => t.key!),
  }
}

/** Best effort, once the trial's row is gone: stops the builds, then deletes `imports/<id>/` and the thumbnails. */
export async function releaseTrialLeftovers(l: TrialLeftovers): Promise<void> {
  const runner = getBuildRunner()
  for (const id of l.buildingMachines) {
    await runner?.stop(id).catch((err) => console.error(`[trial-sweep] stopping build machine ${id} failed:`, err instanceof Error ? err.message : err))
  }
  await deleteImportFiles(l.importIds)
  for (const key of l.thumbnailKeys) await deleteThumbnailFile(key)
}
