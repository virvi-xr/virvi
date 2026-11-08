/**
 * LIV-83: the where-clauses readers of `scenes` use to leave deleted scenes out (see scenes/deleted.ts). Kept apart
 * from deleted.ts so lists, feeds and sweeps can import it without pulling in the delete machinery.
 */
import { eq, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenes } from '../db/schema.js'

/** The where-clause every reader of `scenes` adds to leave deleted scenes out. */
export const liveScene = () => isNull(scenes.deletedAt)

/** Ids of the scenes that aren't deleted, as a subquery (for tables keyed on scene_id). */
export const liveSceneIds = () => db.select({ id: scenes.id }).from(scenes).where(liveScene())

/** True when the scene exists and is deleted. */
export async function isSceneDeleted(sceneId: string): Promise<boolean> {
  const [row] = await db.select({ deletedAt: scenes.deletedAt }).from(scenes).where(eq(scenes.id, sceneId))
  return !!row?.deletedAt
}
