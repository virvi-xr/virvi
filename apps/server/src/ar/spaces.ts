import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { RING_DEFAULT_DIAMETER_MM, randomRingId, ringCodeOf, type ArFloorView, type ArMarkerView, type ArSpaceView } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { arFloors, arMarkers, arSpaces } from '../db/schema.js'
import { publishSceneTouched } from '../realtime/bus.js'
import { liveSceneIds } from '../scenes/live.js'
import { isUuid } from '../auth/scene-from.js'
import { floorScene, markerScene, spaceScene } from './access.js'

type MarkerRow = typeof arMarkers.$inferSelect
type FloorRow = typeof arFloors.$inferSelect
type SpaceRow = typeof arSpaces.$inferSelect

const markerView = (m: MarkerRow): ArMarkerView => ({
  id: m.id,
  ringId: m.ringId,
  code: m.code,
  diameterMm: m.diameterMm,
  whereText: m.whereText,
  pose: m.poseX != null && m.poseY != null && m.poseZ != null && m.headingDeg != null
    ? { x: m.poseX, y: m.poseY, z: m.poseZ, headingDeg: m.headingDeg }
    : null,
})

/** One marker's view by id, or null when it does not exist. */
export async function getMarker(id: string): Promise<ArMarkerView | null> {
  if (!isUuid(id)) return null
  const [row] = await db.select().from(arMarkers).where(eq(arMarkers.id, id))
  return row ? markerView(row) : null
}

const floorView = (f: FloorRow, markers: MarkerRow[]): ArFloorView => ({
  id: f.id,
  name: f.name,
  heightM: f.heightM,
  sortOrder: f.sortOrder,
  markers: markers.filter((m) => m.floorId === f.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(markerView),
})

async function viewsOf(spaces: SpaceRow[]): Promise<ArSpaceView[]> {
  if (!spaces.length) return []
  const floors = await db.select().from(arFloors).where(inArray(arFloors.spaceId, spaces.map((s) => s.id))).orderBy(asc(arFloors.sortOrder), asc(arFloors.heightM))
  const markers = floors.length ? await db.select().from(arMarkers).where(inArray(arMarkers.floorId, floors.map((f) => f.id))) : []
  return spaces.map((s) => ({
    id: s.id,
    sceneId: s.sceneId,
    name: s.name,
    place: s.place,
    lat: s.lat,
    lng: s.lng,
    published: s.published,
    floors: floors.filter((f) => f.spaceId === s.id).map((f) => floorView(f, markers)),
  }))
}

export async function listSpaces(sceneId: string): Promise<ArSpaceView[]> {
  const rows = await db.select().from(arSpaces).where(eq(arSpaces.sceneId, sceneId)).orderBy(asc(arSpaces.createdAt))
  return viewsOf(rows)
}

export async function getSpace(id: string): Promise<ArSpaceView | null> {
  if (!isUuid(id)) return null
  // A deleted scene's spaces (LIV-83) are gone with it: public feeds, analytics and reports get 404
  const [row] = await db.select().from(arSpaces).where(and(eq(arSpaces.id, id), inArray(arSpaces.sceneId, liveSceneIds())))
  return row ? (await viewsOf([row]))[0] : null
}

export async function createSpace(sceneId: string, input: { name: string; place?: string | null }): Promise<ArSpaceView> {
  const id = await db.transaction(async (tx) => {
    const [space] = await tx.insert(arSpaces).values({ sceneId, name: input.name, place: input.place ?? null }).returning({ id: arSpaces.id })
    await tx.insert(arFloors).values({ spaceId: space.id, name: 'Ground floor', heightM: 0, sortOrder: 0 })
    return space.id
  })
  await publishSceneTouched(sceneId)
  return (await getSpace(id))!
}

export async function updateSpace(
  id: string,
  patch: { name?: string; place?: string | null; lat?: number | null; lng?: number | null; published?: boolean },
): Promise<ArSpaceView | null> {
  const sceneId = await spaceScene(id)
  if (!sceneId) return null
  await db.update(arSpaces).set({ ...patch, updatedAt: new Date() }).where(eq(arSpaces.id, id))
  await publishSceneTouched(sceneId)
  return getSpace(id)
}

export async function deleteSpace(id: string): Promise<boolean> {
  const sceneId = await spaceScene(id)
  if (!sceneId) return false
  await db.delete(arSpaces).where(eq(arSpaces.id, id))
  await publishSceneTouched(sceneId)
  return true
}

export async function addFloor(spaceId: string, input: { name: string; heightM: number }): Promise<ArFloorView | null> {
  const sceneId = await spaceScene(spaceId)
  if (!sceneId) return null
  const [{ n }] = await db.select({ n: count() }).from(arFloors).where(eq(arFloors.spaceId, spaceId))
  const [row] = await db.insert(arFloors).values({ spaceId, name: input.name, heightM: input.heightM, sortOrder: n }).returning()
  await publishSceneTouched(sceneId)
  return floorView(row, [])
}

export async function updateFloor(id: string, patch: { name?: string; heightM?: number; sortOrder?: number }): Promise<ArFloorView | null> {
  const sceneId = await floorScene(id)
  if (!sceneId) return null
  const [row] = await db.update(arFloors).set(patch).where(eq(arFloors.id, id)).returning()
  const markers = await db.select().from(arMarkers).where(eq(arMarkers.floorId, id))
  await publishSceneTouched(sceneId)
  return floorView(row, markers)
}

/** 'last_floor' when it is the space's only floor; false when the floor does not exist. */
export async function deleteFloor(id: string): Promise<boolean | 'last_floor'> {
  const [floor] = await db.select().from(arFloors).where(eq(arFloors.id, id))
  if (!floor) return false
  const sceneId = await spaceScene(floor.spaceId)
  if (!sceneId) return false
  const [{ n }] = await db.select({ n: count() }).from(arFloors).where(eq(arFloors.spaceId, floor.spaceId))
  if (n <= 1) return 'last_floor'
  await db.delete(arFloors).where(eq(arFloors.id, id))
  await publishSceneTouched(sceneId)
  return true
}

const isUniqueClash = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.code === '23505' || e?.cause?.code === '23505'
}

export async function addMarker(floorId: string, input: { diameterMm?: number; whereText?: string | null }): Promise<ArMarkerView | null> {
  const sceneId = await floorScene(floorId)
  if (!sceneId) return null
  for (let attempt = 0; attempt < 8; attempt++) {
    const ringId = randomRingId()
    try {
      const [row] = await db
        .insert(arMarkers)
        .values({ floorId, ringId, code: ringCodeOf(ringId), diameterMm: input.diameterMm ?? RING_DEFAULT_DIAMETER_MM, whereText: input.whereText ?? null })
        .returning()
      await publishSceneTouched(sceneId)
      return markerView(row)
    } catch (err) {
      if (!isUniqueClash(err)) throw err
    }
  }
  throw new Error('could not allocate a unique ring id')
}

export async function updateMarker(id: string, patch: { diameterMm?: number; whereText?: string | null }): Promise<ArMarkerView | null> {
  const sceneId = await markerScene(id)
  if (!sceneId) return null
  const [row] = await db.update(arMarkers).set(patch).where(eq(arMarkers.id, id)).returning()
  await publishSceneTouched(sceneId)
  return markerView(row)
}

export async function deleteMarker(id: string): Promise<boolean> {
  const sceneId = await markerScene(id)
  if (!sceneId) return false
  await db.delete(arMarkers).where(eq(arMarkers.id, id))
  await publishSceneTouched(sceneId)
  return true
}

export type MarkerPose = { x: number; y: number; z: number; headingDeg: number; heightAboveFloorM: number }

/**
 * Saves where the ring is. Warns `floor_height_off` when the ring's floor (y minus its height above the floor)
 * is more than 0.5 m from the floor's recorded height. Heading is stored in [0, 360).
 */
export async function setMarkerPose(id: string, pose: MarkerPose): Promise<{ marker: ArMarkerView; warnings: Array<'floor_height_off'> } | null> {
  const sceneId = await markerScene(id)
  if (!sceneId) return null
  const headingDeg = ((pose.headingDeg % 360) + 360) % 360
  const [row] = await db
    .update(arMarkers)
    .set({ poseX: pose.x, poseY: pose.y, poseZ: pose.z, headingDeg, poseRecordedAt: new Date() })
    .where(eq(arMarkers.id, id))
    .returning()
  if (!row) return null
  const [floor] = await db.select({ heightM: arFloors.heightM }).from(arFloors).where(eq(arFloors.id, row.floorId))
  const warnings: Array<'floor_height_off'> = floor && Math.abs(pose.y - pose.heightAboveFloorM - floor.heightM) > 0.5 ? ['floor_height_off'] : []
  await publishSceneTouched(sceneId)
  return { marker: markerView(row), warnings }
}
