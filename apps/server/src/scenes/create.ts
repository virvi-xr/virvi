import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenePresets, scenes } from '../db/schema.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** A new scene with its `Default` preset made active, inside the caller's transaction. */
export async function insertSceneWithDefaultPreset(tx: Tx, ownerId: string, name: string): Promise<{ sceneId: string; presetId: string }> {
  const [scene] = await tx.insert(scenes).values({ ownerId, name }).returning({ id: scenes.id })
  const [preset] = await tx.insert(scenePresets).values({ sceneId: scene.id, name: 'Default' }).returning({ id: scenePresets.id })
  await tx.update(scenes).set({ activePresetId: preset.id }).where(eq(scenes.id, scene.id))
  return { sceneId: scene.id, presetId: preset.id }
}
