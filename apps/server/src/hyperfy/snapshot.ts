import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { SerializedScene } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { scenes, scenePresets } from '../db/schema.js'
import { serializePreset } from '../services/scene-serializer.js'
import { withLiveStatus } from '../streaming/live-status.js'

/** Row order shifts when Postgres rewrites a row, so order by id to keep the hash a function of content. */
function stable<T>(value: T): T {
  if (Array.isArray(value)) {
    const items = value.map(stable)
    const key = (x: unknown) => (x && typeof x === 'object' ? String((x as { sk?: unknown }).sk ?? '') : '')
    return (items.every((x) => key(x)) ? [...items].sort((a, b) => key(a).localeCompare(key(b))) : items) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stable(v)])) as T
  }
  return value
}

/**
 * The scene's whole active preset, exactly as the Decentraland room sends it, plus a version
 * (SHA-256 of its JSON). Null when the scene doesn't exist or is deleted; `scene: null` when it has no active preset.
 */
export async function sceneSnapshot(sceneId: string): Promise<{ version: string; scene: SerializedScene | null } | null> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { id: true, activePresetId: true, deletedAt: true } })
  // A deleted scene (LIV-83) is gone to its feeds: Hyperfy and AR get 404
  if (!scene || scene.deletedAt) return null
  const preset = scene.activePresetId
    ? await db.query.scenePresets.findFirst({
        where: eq(scenePresets.id, scene.activePresetId),
        with: { elements: { with: { instances: true } } },
      })
    : null
  const serialized = preset ? stable((await withLiveStatus(serializePreset(preset))) as unknown as SerializedScene) : null
  return { version: createHash('sha256').update(JSON.stringify(serialized)).digest('hex'), scene: serialized }
}
