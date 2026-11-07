/**
 * The deployed placements snapshot (LIV-134, `virvi/placements.json`, written by the server for Virvi-built scenes).
 *
 * placeDeployedModels() reads it with the SDK's readFile and creates each placed model (Transform + GltfContainer)
 * before anything talks to Virvi. Decentraland's LOD/map builder runs scenes for 90 frames with no network and
 * made-up scene metadata, so these entities are the only way Virvi models reach the map and the distant view; visitors
 * also see the buildings before the live scene arrives.
 *
 * Handoff: when the live scene arrives, the model manager adopts each entity by its instance id (adoptPlaced, through
 * DclAdapter.adoptEntity), so nothing is removed and recreated; whatever live state didn't adopt (deleted copies,
 * another preset, models it can't load) is removed (releasePlaced, at the live scene's init or preset switch). If Virvi
 * never connects, they stay.
 *
 * Ruling (LIV-134): adopt rather than delete-and-recreate — why: the adopted entity already has the same model and
 * transform, so the adapter's setters see no difference and send nothing; a new entity would make the explorer load
 * the model again (a visible pop).
 */
import { engine, Transform, GltfContainer, ColliderLayer, type Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { PLACEMENTS_FILE, decodePlacements, type Placement } from '@virvixr/shared'

/** Placed entities not yet adopted, by instance id. */
const placed = new Map<string, Entity>()
/** Once live state has arrived (released), nothing more is placed: it would never be adopted. */
let released = false

/** The visible-mesh collision mask the live runtime gives a model with collisions (DclAdapter.setCollider 'mesh'). */
export const PLACED_COLLISION_MASK = ColliderLayer.CL_PHYSICS

/** Creates each placement not already placed; returns how many are waiting to be adopted. */
export function placeModels(list: Placement[]): number {
  if (released) return 0
  for (const p of list) {
    if (placed.has(p.instanceId)) continue
    const e = engine.addEntity()
    // The same calls DclAdapter.setTransform / setGltfModel make, so adoption finds nothing to change
    Transform.create(e, {
      position: Vector3.create(p.position.x, p.position.y, p.position.z),
      rotation: Quaternion.fromEulerDegrees(p.rotation.x, p.rotation.y, p.rotation.z),
      scale: Vector3.create(p.scale.x, p.scale.y, p.scale.z),
    })
    GltfContainer.create(e, p.collisions ? { src: p.src, visibleMeshesCollisionMask: PLACED_COLLISION_MASK } : { src: p.src })
    placed.set(p.instanceId, e)
  }
  return placed.size
}

/** UTF-8 bytes to text without TextDecoder (Decentraland's LOD sandbox has none). Invalid bytes become U+FFFD. */
export function utf8(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++]
    let cp = 0xfffd
    if (b < 0x80) cp = b
    else if (b >= 0xc0 && b < 0xe0 && i < bytes.length) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f)
    else if (b >= 0xe0 && b < 0xf0 && i + 1 < bytes.length) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
    else if (b >= 0xf0 && b < 0xf8 && i + 2 < bytes.length) cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
    out += String.fromCodePoint(cp)
  }
  return out
}

export type DeployedFileReader = (fileName: string) => Promise<Uint8Array | null | undefined>

const readDeployedFile: DeployedFileReader = async (fileName) => {
  const { readFile } = await import('~system/Runtime' as any)
  return (await readFile({ fileName }))?.content
}

/**
 * How long, in engine time, startup waits for the snapshot before connecting without it. Counted from frames, since
 * Decentraland's LOD sandbox has no timers; there the read settles in the first frame, well inside its 90 (3 s).
 */
export const PLACEMENTS_READ_TIMEOUT_S = 5

/** Resolves once `seconds` of engine frames have run, or as soon as `stop()` says so; its system is then removed. */
function framesElapsed(seconds: number, stop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let elapsed = 0
    const timer = (dt: number) => {
      elapsed += dt
      if (!stop() && elapsed < seconds) return
      engine.removeSystem(timer)
      resolve()
    }
    engine.addSystem(timer)
  })
}

/**
 * Places the scene's deployed snapshot; returns how many models were placed. A scene without one (or an unreadable
 * one) places nothing and carries on. Never throws. Await it before connecting to Virvi, so the live scene can adopt.
 *
 * Ruling (LIV-134 review): a read that hasn't settled after PLACEMENTS_READ_TIMEOUT_S of frames resolves 0, so a
 * stalled content fetch never keeps the scene from connecting. A read that settles later still goes through
 * placeModels — why: before live state arrives the copies are adopted as usual, and once it has (releasePlaced)
 * placeModels places nothing, so a late snapshot can neither duplicate nor orphan anything, while a scene whose Virvi
 * API is down still gets its buildings.
 */
export async function placeDeployedModels(read: DeployedFileReader = readDeployedFile, timeoutSeconds = PLACEMENTS_READ_TIMEOUT_S): Promise<number> {
  let settled = false
  const reading = (async () => {
    try {
      const bytes = await read(PLACEMENTS_FILE)
      if (!bytes || !bytes.length) return 0
      return placeModels(decodePlacements(utf8(bytes)))
    } catch {
      return 0 // no snapshot deployed (readFile throws for a missing file)
    } finally {
      settled = true
    }
  })()
  return Promise.race([reading, framesElapsed(timeoutSeconds, () => settled).then(() => 0)])
}

/** Hands over the placed entity for this instance (once); null when none is waiting. */
export function adoptPlaced(instanceId: string): Entity | null {
  const e = placed.get(instanceId)
  if (e === undefined) return null
  placed.delete(instanceId)
  return e
}

/** Removes every placed entity live state didn't adopt; nothing is placed after this. */
export function releasePlaced(): void {
  released = true
  for (const e of placed.values()) engine.removeEntity(e)
  placed.clear()
}

/** Tests only: forget every placed entity and start over. */
export function resetPlacedForTests(): void {
  placed.clear()
  released = false
}
