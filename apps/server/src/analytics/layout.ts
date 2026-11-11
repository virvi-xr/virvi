import { and, eq, inArray } from 'drizzle-orm'
import type { Vec3 } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assetLibraryItems, sceneElements, scenes } from '../db/schema.js'
import { liveScene } from '../scenes/live.js'
import { flatProperties } from '../services/scene-serializer.js'

/** One placed instance, in scene coordinates (Virvi/Decentraland: metres, x east, y up, z north, Euler degrees). */
export interface LayoutItem {
  id: string
  /** The instance this one is placed relative to (its transform is local to the parent's). */
  parentId: string | null
  type: string
  name: string
  /** A model's GLB, when it is a web URL the dashboard can load. */
  src: string | null
  /** A model's size from the asset library, for its footprint when the GLB can't be drawn. */
  dimensions: Vec3 | null
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

const MAX_ITEMS = 2000

const vec = (raw: unknown, fallback: number): Vec3 => {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const n = (k: string) => (typeof v[k] === 'number' && Number.isFinite(v[k]) ? (v[k] as number) : fallback)
  return { x: n('x'), y: n('y'), z: n('z') }
}

/** Asset library dimensions are { width, height, depth }. */
function dims(raw: unknown): Vec3 | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const [x, y, z] = [d.width ?? d.x, d.height ?? d.y, d.depth ?? d.z]
  return [x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0) ? { x: x as number, y: y as number, z: z as number } : null
}

/**
 * The items to draw: those whose whole parent chain is here and enabled. A child of a disabled instance, or of an
 * instance of a disabled element (never loaded), is left out rather than drawn in scene coordinates at the wrong spot.
 * The cap keeps parents before children (by depth), so it never keeps a child whose parent it cut.
 */
export function resolveLayout(raw: Array<LayoutItem & { enabled: boolean }>, max: number): LayoutItem[] {
  const byId = new Map(raw.map((i) => [i.id, i]))
  const depth = new Map<string, number | null>()
  const depthOf = (id: string, seen: Set<string>): number | null => {
    if (depth.has(id)) return depth.get(id)!
    const i = byId.get(id)
    let d: number | null = null
    if (i?.enabled && !seen.has(id)) {
      seen.add(id)
      const p = i.parentId === null ? -1 : depthOf(i.parentId, seen)
      d = p === null ? null : p + 1
    }
    depth.set(id, d)
    return d
  }
  const kept: Array<{ item: LayoutItem; depth: number }> = []
  for (const { enabled: _enabled, ...item } of raw) {
    const d = depthOf(item.id, new Set())
    if (d !== null) kept.push({ item, depth: d })
  }
  return kept.sort((a, b) => a.depth - b.depth).slice(0, max).map((k) => k.item)
}

/**
 * The scene's live preset: every enabled instance of its enabled elements whose parents are drawn too (see
 * resolveLayout). Null without a live preset.
 */
export async function sceneLayout(virviSceneId: string): Promise<{ items: LayoutItem[] } | null> {
  const [row] = await db.select({ presetId: scenes.activePresetId }).from(scenes).where(and(eq(scenes.id, virviSceneId), liveScene()))
  if (!row?.presetId) return null
  const elements = await db.query.sceneElements.findMany({
    where: and(eq(sceneElements.presetId, row.presetId), eq(sceneElements.enabled, true)),
    with: { instances: true },
  })
  const srcOf = new Map<string, string | null>()
  for (const e of elements) {
    const src = e.type === 'model' ? flatProperties(e.properties).modelSrc : null
    srcOf.set(e.id, typeof src === 'string' && /^https?:\/\//i.test(src) ? src : null)
  }
  const srcs = [...new Set([...srcOf.values()].filter((v): v is string => !!v))]
  const sizes = new Map<string, Vec3 | null>()
  if (srcs.length) {
    for (const a of await db.select({ cdnUrl: assetLibraryItems.cdnUrl, dimensions: assetLibraryItems.dimensions }).from(assetLibraryItems).where(inArray(assetLibraryItems.cdnUrl, srcs))) {
      if (a.cdnUrl && !sizes.get(a.cdnUrl)) sizes.set(a.cdnUrl, dims(a.dimensions))
    }
  }
  const items: Array<LayoutItem & { enabled: boolean }> = []
  for (const e of elements) {
    for (const i of e.instances) {
      const src = srcOf.get(e.id) ?? null
      items.push({
        id: i.id,
        enabled: i.enabled,
        parentId: i.parentInstanceId,
        type: e.type,
        name: e.name,
        src,
        dimensions: src ? (sizes.get(src) ?? null) : null,
        position: vec(i.position, 0),
        rotation: vec(i.rotation, 0),
        scale: vec(i.scale, 1),
      })
    }
  }
  return { items: resolveLayout(items, MAX_ITEMS) }
}
