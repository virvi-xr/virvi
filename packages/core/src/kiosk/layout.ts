/**
 * Giveaway kiosks (claim_point): what a kiosk is drawn from. Pure, so it is unit-tested; KioskManager makes the
 * entities. A kiosk is the giveaway's item (its marketplace image, the host's image, a 3D model or a mannequin wearing
 * the giveaway's wearables), optionally in a POAP-style booth: two side posts and a roof sign in colour 1 (with an
 * optional banner image on the sign's front), a display panel at the back in colour 2, and a counter in colour 3 with a
 * Claim button on its front. Primitives only (six boxes, a banner and a label), no models to download.
 *
 * Kiosk space: metres, the floor centre at the origin, the front (where visitors stand) towards -z. Parts are placed in
 * the world with the instance's position, rotation and scale.
 */
import { ClaimPointType, MannequinType, type KioskColor, type KioskItem, type KioskSettings, type TransformData, type Vec3 } from '@virvixr/shared'
import { add, eulerDegreesToQuat, quatFromAxisAngle, quatMultiply, quatToEulerDegrees, rotateVector } from '../transform/math.js'

export type KioskPartRole = 'post_left' | 'post_right' | 'roof' | 'banner' | 'panel' | 'counter' | 'button' | 'label' | 'item' | 'hit'

export type KioskPartLook =
  | { kind: 'box'; color: KioskColor }
  | { kind: 'image'; src: string }
  | { kind: 'text'; text: string; fontSize: number }
  | { kind: 'model'; src: string }
  | { kind: 'mannequin'; bodyShape: 'male' | 'female' | 'player'; wearables: string[] }
  /** An invisible box that takes the click (around a mannequin, which can't take one itself). */
  | { kind: 'hit' }

export type KioskPart = KioskPartLook & {
  role: KioskPartRole
  /** In kiosk space. */
  transform: TransformData
  /** Clicking it opens the giveaway card. */
  click: boolean
  /** Turns with the spin (the item only). */
  spins: boolean
}

/** The booth's size: width, depth and post height. */
export const BOOTH = { width: 2, depth: 1.2, height: 2.6 } as const
const ROOF_H = 0.5
const COUNTER_H = 1
const COUNTER_D = 0.4
const ZERO: Vec3 = { x: 0, y: 0, z: 0 }
const ONE: Vec3 = { x: 1, y: 1, z: 1 }
/** Degrees a spinning item turns each second. */
export const KIOSK_SPIN_DEG_PER_S = 45

const part = (role: KioskPartRole, look: KioskPartLook, position: Vec3, scale: Vec3 = ONE, opts: { click?: boolean; spins?: boolean; rotation?: Vec3 } = {}): KioskPart =>
  ({ ...look, role, transform: { position, rotation: opts.rotation ?? ZERO, scale }, click: opts.click ?? false, spins: opts.spins ?? false })

/** What the item shows, or null when there is nothing to show (no image or model picked, no marketplace image yet). */
function itemLook(s: KioskSettings, items: KioskItem[]): KioskPartLook | null {
  switch (s.claimPointType) {
    case ClaimPointType.MARKETPLACE_IMAGE: {
      const src = items.find((i) => i.thumbnail)?.thumbnail
      return src ? { kind: 'image', src } : null
    }
    case ClaimPointType.CUSTOM_IMAGE:
      return s.imgSrc ? { kind: 'image', src: s.imgSrc } : null
    case ClaimPointType.MODEL:
      return s.modelSrc ? { kind: 'model', src: s.modelSrc } : null
    case ClaimPointType.MANNEQUIN: {
      const bodyShape = s.mannequinType === MannequinType.MALE ? 'male' : s.mannequinType === MannequinType.FEMALE ? 'female' : 'player'
      return { kind: 'mannequin', bodyShape, wearables: items.map((i) => i.urn).filter((u): u is string => !!u) }
    }
    default:
      return null
  }
}

/** The kiosk's parts in kiosk space. */
export function kioskParts(s: KioskSettings, items: KioskItem[]): KioskPart[] {
  const parts: KioskPart[] = []
  const booth = s.enableKiosk
  const { width: W, depth: D, height: H } = BOOTH
  const front = -D / 2
  if (booth) {
    const c1 = { kind: 'box' as const, color: s.color1 }
    parts.push(part('post_left', c1, { x: -(W / 2 - 0.05), y: H / 2, z: 0 }, { x: 0.1, y: H, z: D }))
    parts.push(part('post_right', c1, { x: W / 2 - 0.05, y: H / 2, z: 0 }, { x: 0.1, y: H, z: D }))
    parts.push(part('roof', c1, { x: 0, y: H + ROOF_H / 2, z: 0 }, { x: W + 0.2, y: ROOF_H, z: D + 0.2 }))
    if (s.kioskImgSrc) {
      parts.push(part('banner', { kind: 'image', src: s.kioskImgSrc }, { x: 0, y: H + ROOF_H / 2, z: front - 0.1 - 0.01 }, { x: W, y: ROOF_H - 0.06, z: 1 }))
    }
    parts.push(part('panel', { kind: 'box', color: s.color2 }, { x: 0, y: H / 2, z: D / 2 - 0.05 }, { x: W - 0.2, y: H, z: 0.06 }, { click: true }))
    parts.push(part('counter', { kind: 'box', color: s.color3 }, { x: 0, y: COUNTER_H / 2, z: front + COUNTER_D / 2 }, { x: W - 0.2, y: COUNTER_H, z: COUNTER_D }, { click: true }))
    // The Claim button on the counter's front, in colour 1, labelled with the hover text
    parts.push(part('button', c1, { x: 0, y: COUNTER_H * 0.72, z: front - 0.02 }, { x: 0.9, y: 0.24, z: 0.04 }, { click: true }))
    parts.push(part('label', { kind: 'text', text: s.hoverText, fontSize: 2 }, { x: 0, y: COUNTER_H * 0.72, z: front - 0.05 }))
  }

  const look = itemLook(s, items)
  if (!look) return parts
  const k = s.itemScale
  const dy = s.itemYOffset
  const z = booth ? 0.1 : 0
  switch (look.kind) {
    case 'image':
      // Above the counter in a booth, at eye height on its own; a thin box takes the click
      parts.push(part('item', look, { x: 0, y: (booth ? 1.75 : 1.2) + dy, z }, { x: k, y: k, z: 0.01 }, { click: true, spins: true }))
      break
    case 'model':
      parts.push(part('item', look, { x: 0, y: (booth ? COUNTER_H : 0) + dy, z }, { x: k, y: k, z: k }, { click: true, spins: true }))
      break
    case 'mannequin':
      // Faces the visitors (an avatar faces +z); behind the counter in a booth
      parts.push(part('item', look, { x: 0, y: dy, z: booth ? 0.2 : 0 }, { x: k, y: k, z: k }, { spins: true, rotation: { x: 0, y: 180, z: 0 } }))
      parts.push(part('hit', { kind: 'hit' }, { x: 0, y: dy + 0.9 * k, z: booth ? 0.2 : 0 }, { x: 0.7 * k, y: 1.8 * k, z: 0.5 * k }, { click: true }))
      break
  }
  return parts
}

/** How a part looks, without where it is: when this changes, the part's entity is made again. */
export function partLookKey(p: KioskPart): string {
  const { transform: _t, ...look } = p
  return JSON.stringify(look)
}

/**
 * A part's world transform for a kiosk instance at `at`: the instance's scale stretches kiosk space, its rotation turns
 * it, its position moves it. A spinning part also turns `spinDeg` about its own up axis.
 */
export function placePart(p: KioskPart, at: TransformData, spinDeg = 0): TransformData {
  const q = eulerDegreesToQuat(at.rotation)
  const local = p.transform
  const scaled = { x: local.position.x * at.scale.x, y: local.position.y * at.scale.y, z: local.position.z * at.scale.z }
  let rot = quatMultiply(q, eulerDegreesToQuat(local.rotation))
  if (p.spins && spinDeg) rot = quatMultiply(rot, quatFromAxisAngle({ x: 0, y: 1, z: 0 }, spinDeg))
  const plain = (v: Vec3) => v.x === 0 && v.y === 0 && v.z === 0
  return {
    position: add(at.position, rotateVector(q, scaled)),
    // An unturned part keeps the instance's own angles as they were typed
    rotation: plain(local.rotation) && !(p.spins && spinDeg) ? at.rotation : quatToEulerDegrees(rot),
    scale: { x: local.scale.x * at.scale.x, y: local.scale.y * at.scale.y, z: local.scale.z * at.scale.z },
  }
}
