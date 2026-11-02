/**
 * Room sets: one use of a scan (in a scene, or as a library asset), each with its own options and nudges.
 *
 * Creation is split so callers can keep slow work out of their transactions: `prepareRoomSet` checks the plot,
 * generates the GLB and uploads it; `insertRoomSet` writes the row (inside the caller's transaction if given);
 * `commitRoomSet` runs a transaction and deletes the uploaded object if it fails.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { type Plot, type RoomScanLayout } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assetLibraryItems, roomScans, roomSets, sceneElements, sceneLibrary, scenePresets } from '../db/schema.js'
import { createStorage, type StorageProvider } from '../storage/index.js'
import { generateThumbnail } from '../services/thumbnails.js'
import { publishElementChanged, publishSceneTouched } from '../realtime/bus.js'
import { buildRoomSetGlb, DEFAULT_ROOM_SET_OPTIONS, type RoomSetOptions, type RoomStyle } from './build-glb.js'
import { snapDoors, type Nudge } from './geometry.js'
import { plotForLayout } from './plot.js'
import { ROOM_STYLES } from './styles/index.js'

export type RoomSetRow = typeof roomSets.$inferSelect
export type AssetRow = typeof assetLibraryItems.$inferSelect
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Exec = typeof db | Tx

const GLB = 'model/gltf-binary'
const HEX = /^#[0-9a-f]{6}$/i
const MAX_SIGN_TEXT = 80

/** A refusal with the HTTP status and `error` code the routes answer with. */
export class RoomSetError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 422, public code: string) {
    super(code)
  }
}

let storageOverride: StorageProvider | null = null
let defaultStorage: StorageProvider | null = null
/** Tests swap in a memory store; null restores the configured one. */
export function setRoomSetStorage(s: StorageProvider | null): void {
  storageOverride = s
}
function storage(): StorageProvider {
  return storageOverride ?? (defaultStorage ??= createStorage())
}

/** Partial options laid over `base`; null when a given field is invalid (unknown style, not #RRGGBB, not boolean). */
export function parseRoomSetOptions(input: unknown, base: RoomSetOptions = DEFAULT_ROOM_SET_OPTIONS): RoomSetOptions | null {
  if (input === undefined || input === null) return { ...base }
  if (typeof input !== 'object' || Array.isArray(input)) return null
  const o = input as Record<string, unknown>
  const out: RoomSetOptions = { ...base }
  if (o.style !== undefined) {
    if (!ROOM_STYLES.includes(o.style as RoomStyle)) return null
    out.style = o.style as RoomStyle
  }
  for (const k of ['wallColor', 'floorColor'] as const) {
    if (o[k] === undefined) continue
    if (typeof o[k] !== 'string' || !HEX.test(o[k] as string)) return null
    out[k] = (o[k] as string).toUpperCase()
  }
  for (const k of ['ceiling', 'furniture'] as const) {
    if (o[k] === undefined) continue
    if (typeof o[k] !== 'boolean') return null
    out[k] = o[k] as boolean
  }
  if (o.signText !== undefined) {
    if (typeof o.signText !== 'string' || o.signText.length > MAX_SIGN_TEXT) return null
    out.signText = o.signText
  }
  return out
}

/** One finite { dx, dz, yaw } per room, or null. */
export function parseNudges(input: unknown, roomCount: number): Nudge[] | null {
  if (!Array.isArray(input) || input.length !== roomCount) return null
  const out: Nudge[] = []
  for (const n of input) {
    if (!n || typeof n !== 'object') return null
    const { dx, dz, yaw } = n as Record<string, unknown>
    if (![dx, dz, yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) return null
    out.push({ dx: dx as number, dz: dz as number, yaw: yaw as number })
  }
  return out
}

const storedNudges = (row: RoomSetRow): Nudge[] => (Array.isArray(row.nudges) ? (row.nudges as Nudge[]) : [])

/** The scan if `userId` owns it. */
export async function loadOwnedScan(userId: string, scanId: string | null) {
  if (!scanId) return null
  const [scan] = await db.select().from(roomScans).where(and(eq(roomScans.id, scanId), eq(roomScans.userId, userId)))
  return scan ?? null
}

/**
 * The set's GLB and stats, nothing stored. A home larger than the largest plot is 422 too_big; its triangle count
 * never is (Decentraland only warns about a scene over its recommended count).
 */
export async function generateRoomSet(layout: RoomScanLayout, options: RoomSetOptions, nudges: Nudge[]) {
  const plot = plotForLayout(layout, nudges)
  if (!plot) throw new RoomSetError(422, 'too_big')
  const out = await buildRoomSetGlb(layout, options, nudges)
  return { ...out, plot }
}

export interface PreparedRoomSet {
  userId: string
  scanId: string
  options: RoomSetOptions
  nudges: Nudge[]
  glb: Buffer
  triangles: number
  bbox: { x: number; y: number; z: number }
  offset: { x: number; y: number; z: number }
  plot: Plot
  storageKey: string
  glbUrl: string
}

/** Generate and upload a set's GLB under a fresh key. Run it outside any transaction; nothing is written to the DB. */
export async function prepareRoomSet(
  userId: string,
  scan: { id: string; layout: RoomScanLayout },
  options: RoomSetOptions,
  nudges: Nudge[],
): Promise<PreparedRoomSet> {
  const out = await generateRoomSet(scan.layout, options, nudges)
  const storageKey = `room-sets/${userId}/${randomUUID()}.glb`
  const glbUrl = await storage().upload(storageKey, out.glb, GLB)
  return { userId, scanId: scan.id, options, nudges, ...out, storageKey, glbUrl }
}

/** Delete a prepared set's uploaded object (after a failed transaction). Never throws. */
export async function discardRoomSet(prepared: Pick<PreparedRoomSet, 'storageKey'>): Promise<void> {
  try {
    await storage().delete(prepared.storageKey)
  } catch (err) {
    console.error('[room-sets] failed to delete', prepared.storageKey, err)
  }
}

/**
 * Whether a room-set GLB is still used by something that doesn't own it: a scene element pointing at it by URL
 * (a duplicate, a venue booking's copy, a pasted URL) or an asset other than `except.assetItemId`.
 */
async function roomSetObjectInUse(glbUrl: string, except: { assetItemId?: string }): Promise<boolean> {
  const [element] = await db
    .select({ id: sceneElements.id })
    .from(sceneElements)
    .where(sql`${sceneElements.properties}->>'modelSrc' = ${glbUrl}`)
    .limit(1)
  if (element) return true
  const [asset] = await db
    .select({ id: assetLibraryItems.id })
    .from(assetLibraryItems)
    .where(except.assetItemId ? and(eq(assetLibraryItems.cdnUrl, glbUrl), ne(assetLibraryItems.id, except.assetItemId)) : eq(assetLibraryItems.cdnUrl, glbUrl))
    .limit(1)
  return !!asset
}

/**
 * Delete a superseded room-set object, unless something still uses it (see roomSetObjectInUse): then it is kept, so
 * those models don't break. Call it once the set's own element and asset point elsewhere (or, deleting an asset,
 * with that asset as `except`). Never throws.
 */
export async function releaseRoomSetObject(object: { storageKey: string; glbUrl: string }, except: { assetItemId?: string } = {}): Promise<void> {
  try {
    if (await roomSetObjectInUse(object.glbUrl, except)) return
  } catch (err) {
    // Unsure whether it's in use: keep it
    console.error('[room-sets] failed to check', object.storageKey, err)
    return
  }
  await discardRoomSet(object)
}

/** Run `work` in a transaction; if it fails, the prepared upload is deleted and the error rethrown. */
export async function commitRoomSet<T>(prepared: PreparedRoomSet, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(work)
  } catch (err) {
    await discardRoomSet(prepared)
    throw err
  }
}

/** Write the prepared set's row, linked to a scene element or library asset when given. */
export async function insertRoomSet(
  prepared: PreparedRoomSet,
  links: { sceneElementId?: string; assetItemId?: string } = {},
  tx: Exec = db,
): Promise<RoomSetRow> {
  const [row] = await tx
    .insert(roomSets)
    .values({
      scanId: prepared.scanId,
      userId: prepared.userId,
      options: prepared.options,
      nudges: prepared.nudges,
      storageKey: prepared.storageKey,
      glbUrl: prepared.glbUrl,
      triangles: prepared.triangles,
      plot: prepared.plot,
      offset: prepared.offset,
      sceneElementId: links.sceneElementId ?? null,
      assetItemId: links.assetItemId ?? null,
    })
    .returning()
  return row
}

async function requireScan(userId: string, scanId: string | null, missing: RoomSetError) {
  const scan = await loadOwnedScan(userId, scanId)
  if (!scan) throw missing
  return scan
}

/** A set from the owner's scan, unlinked. 404 when the scan isn't theirs; 422 too_big. */
export async function createRoomSet(userId: string, scanId: string, options: RoomSetOptions, nudges: Nudge[]): Promise<RoomSetRow> {
  const scan = await requireScan(userId, scanId, new RoomSetError(404, 'not_found'))
  const prepared = await prepareRoomSet(userId, scan, options, nudges)
  return commitRoomSet(prepared, (tx) => insertRoomSet(prepared, {}, tx))
}

const assetStats = (p: PreparedRoomSet) => ({
  storageKey: p.storageKey,
  cdnUrl: p.glbUrl,
  fileSizeBytes: p.glb.length,
  triangleCount: p.triangles,
  dimensions: { width: p.bbox.x, height: p.bbox.y, depth: p.bbox.z },
})

/** A private library asset (category `room`) backed by a new set of the owner's scan. */
export async function createRoomSetAsset(
  userId: string,
  scanId: string,
  name: string,
  options: RoomSetOptions,
): Promise<{ asset: AssetRow; set: RoomSetRow }> {
  const scan = await requireScan(userId, scanId, new RoomSetError(404, 'not_found'))
  const prepared = await prepareRoomSet(userId, scan, options, [])
  const out = await commitRoomSet(prepared, async (tx) => {
    const [asset] = await tx
      .insert(assetLibraryItems)
      .values({ name, category: 'room', ...assetStats(prepared), isPublic: false, uploadedBy: userId })
      .returning()
    const set = await insertRoomSet(prepared, { assetItemId: asset.id }, tx)
    return { asset, set }
  })
  try {
    const thumbnailUrl = await generateThumbnail(prepared.glb, GLB, out.asset.id)
    if (thumbnailUrl) {
      await db.update(assetLibraryItems).set({ thumbnailUrl }).where(eq(assetLibraryItems.id, out.asset.id))
      out.asset.thumbnailUrl = thumbnailUrl
    }
  } catch (err) {
    // Thumbnails are non-critical, as for uploaded assets
    console.warn('[room-sets] thumbnail failed:', err)
  }
  return out
}

/**
 * Regenerate one set with new options and/or nudges (snapping doors first when asked), under a new key. Its scene
 * element's modelSrc or library asset follows; the old object is deleted once the rows are updated, unless something else still uses it.
 * 404 unless `userId` owns the set; 409 scan_deleted when its scan is gone; 400 invalid_options / invalid_nudges.
 */
export async function updateRoomSet(
  userId: string,
  setId: string,
  changes: { options?: unknown; nudges?: unknown; snap?: unknown },
): Promise<RoomSetRow> {
  const [row] = await db.select().from(roomSets).where(and(eq(roomSets.id, setId), eq(roomSets.userId, userId)))
  if (!row) throw new RoomSetError(404, 'not_found')
  const options = parseRoomSetOptions(changes.options, row.options as RoomSetOptions)
  if (!options) throw new RoomSetError(400, 'invalid_options')
  const scan = await requireScan(userId, row.scanId, new RoomSetError(409, 'scan_deleted'))
  let nudges = storedNudges(row)
  if (changes.nudges !== undefined) {
    const parsed = parseNudges(changes.nudges, scan.layout.rooms.length)
    if (!parsed) throw new RoomSetError(400, 'invalid_nudges')
    nudges = parsed
  }
  if (changes.snap === true) nudges = snapDoors(scan.layout, nudges)

  const prepared = await prepareRoomSet(userId, scan, options, nudges)
  const out = await commitRoomSet(prepared, async (tx) => {
    const [set] = await tx
      .update(roomSets)
      .set({
        options, nudges, storageKey: prepared.storageKey, glbUrl: prepared.glbUrl, triangles: prepared.triangles,
        plot: prepared.plot, offset: prepared.offset, updatedAt: new Date(),
      })
      .where(eq(roomSets.id, row.id))
      .returning()
    let sceneElement: { sceneId: string; presetId: string; elementId: string; elementType: string } | null = null
    if (set.sceneElementId) {
      const element = await tx.query.sceneElements.findFirst({ where: eq(sceneElements.id, set.sceneElementId), with: { preset: true } })
      if (element) {
        const properties = { ...((element.properties as Record<string, unknown> | null) ?? {}), modelSrc: prepared.glbUrl }
        await tx.update(sceneElements).set({ properties, updatedAt: new Date() }).where(eq(sceneElements.id, element.id))
        sceneElement = { sceneId: element.preset.sceneId, presetId: element.presetId, elementId: element.id, elementType: element.type }
      }
    }
    if (set.assetItemId) {
      await tx.update(assetLibraryItems).set(assetStats(prepared)).where(eq(assetLibraryItems.id, set.assetItemId))
    }
    return { set, sceneElement }
  })
  await releaseRoomSetObject(row)
  if (out.sceneElement) {
    await publishElementChanged({ ...out.sceneElement, deleted: false })
    await publishSceneTouched(out.sceneElement.sceneId)
  }
  return out.set
}

/** Generate and upload a copy of the set behind a room-set asset (the snapshot rule), ready for `insertRoomSet`. */
export async function prepareRoomSetCopy(assetItemId: string, userId: string): Promise<PreparedRoomSet> {
  const [source] = await db.select().from(roomSets).where(and(eq(roomSets.assetItemId, assetItemId), eq(roomSets.userId, userId)))
  if (!source) throw new RoomSetError(404, 'not_found')
  const scan = await requireScan(userId, source.scanId, new RoomSetError(409, 'scan_deleted'))
  return prepareRoomSet(userId, scan, source.options as RoomSetOptions, storedNudges(source))
}

/**
 * A scene-owned copy of the set behind a room-set asset: a new GLB object, the same options and nudges, unlinked.
 * Later changes to the asset never reach it.
 */
export async function copyRoomSetForScene(assetItemId: string, userId: string): Promise<RoomSetRow> {
  const prepared = await prepareRoomSetCopy(assetItemId, userId)
  return commitRoomSet(prepared, (tx) => insertRoomSet(prepared, {}, tx))
}

/** The set behind the room-set asset whose GLB is `modelSrc`, or null (for any other model, without a query). */
async function assetSetForModel(modelSrc: unknown): Promise<RoomSetRow | null> {
  if (typeof modelSrc !== 'string' || !modelSrc.includes('/room-sets/')) return null
  const [row] = await db.select().from(roomSets).where(and(eq(roomSets.glbUrl, modelSrc), isNotNull(roomSets.assetItemId)))
  return row ?? null
}

/**
 * Placing a model in a scene: when `modelSrc` is a room-set asset's GLB, generate and upload the scene's own copy
 * (run it outside any transaction, then `insertRoomSet` it linked to the new element). The copy belongs to the
 * asset's owner, who may place it anywhere; anyone else only in a scene whose library holds the asset (403).
 * Null for any other model, and for an asset whose scan is gone: it can never change again, so it's placed as is.
 */
export async function prepareRoomSetForPlacement(modelSrc: unknown, sceneId: string, userId: string): Promise<PreparedRoomSet | null> {
  const source = await assetSetForModel(modelSrc)
  if (!source) return null
  if (source.userId !== userId) {
    const [linked] = await db
      .select({ id: sceneLibrary.id })
      .from(sceneLibrary)
      .where(and(eq(sceneLibrary.sceneId, sceneId), eq(sceneLibrary.assetItemId, source.assetItemId!)))
    if (!linked) throw new RoomSetError(403, 'Forbidden')
  }
  try {
    return await prepareRoomSetCopy(source.assetItemId!, source.userId)
  } catch (err) {
    if (err instanceof RoomSetError && err.code === 'scan_deleted') return null
    throw err
  }
}

/**
 * The scene-owned sets placed by an element, or by any element of a scene. Read them before deleting the element or
 * scene (the link goes null with it), then hand them to `deleteOrphanedRoomSets`. Library-asset sets aren't included.
 */
export async function sceneOwnedRoomSets(where: { elementId: string } | { sceneId: string }): Promise<RoomSetRow[]> {
  const owned = isNull(roomSets.assetItemId)
  if ('elementId' in where) return db.select().from(roomSets).where(and(eq(roomSets.sceneElementId, where.elementId), owned))
  const rows = await db
    .select({ set: roomSets })
    .from(roomSets)
    .innerJoin(sceneElements, eq(sceneElements.id, roomSets.sceneElementId))
    .innerJoin(scenePresets, eq(scenePresets.id, sceneElements.presetId))
    .where(and(eq(scenePresets.sceneId, where.sceneId), owned))
  return rows.map((r) => r.set)
}

/**
 * Delete the rows of sets whose element is gone, then release each GLB (kept while something else still uses it).
 * The delete it follows has already happened, so this logs failures instead of throwing.
 */
export async function deleteOrphanedRoomSets(rows: RoomSetRow[]): Promise<void> {
  if (rows.length === 0) return
  try {
    await db.delete(roomSets).where(inArray(roomSets.id, rows.map((r) => r.id)))
  } catch (err) {
    console.error('[room-sets] failed to delete orphaned sets', rows.map((r) => r.id), err)
    return
  }
  for (const row of rows) await releaseRoomSetObject(row)
}

/** Each element's room set id, for the elements that have one: one query. */
export async function roomSetIdsByElement(elementIds: string[]): Promise<Map<string, string>> {
  if (elementIds.length === 0) return new Map()
  const rows = await db
    .select({ id: roomSets.id, elementId: roomSets.sceneElementId })
    .from(roomSets)
    .where(inArray(roomSets.sceneElementId, elementIds))
  return new Map(rows.map((r) => [r.elementId!, r.id]))
}

/** The owner's set with its scan's room labels (null once the scan is deleted). 404 for anyone else. */
export async function getRoomSet(userId: string, setId: string): Promise<RoomSetRow & { rooms: string[] | null }> {
  const [row] = await db.select().from(roomSets).where(and(eq(roomSets.id, setId), eq(roomSets.userId, userId)))
  if (!row) throw new RoomSetError(404, 'not_found')
  const scan = await loadOwnedScan(userId, row.scanId)
  return { ...row, rooms: scan ? scan.layout.rooms.map((r) => r.label) : null }
}
