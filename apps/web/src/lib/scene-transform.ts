// Scene coordinates to three.js, shared by the wizard's Preview3D and the analytics heatmap (LIV-85). Pure math, no
// three.js import, so the 2D map can use it without pulling three into the analytics page.
//
// Virvi scene coordinates are Decentraland's: metres, x east, y up, z north (left-handed), Euler degrees with
// positive turns clockwise seen from above. three.js is right-handed with north at -Z, so position z is mirrored and
// the turns about x and y are negated; the yaw-pitch-roll order is three.js 'YXZ' (as the Hyperfy app maps it).
// Decentraland also shows a glTF x-mirrored (glTF (x, y, z) at (-x, y, z)); with the z-mirror that is a half turn
// about Y, so every model gets MODEL_TURN inside the group that carries its transform.

export type V3 = { x: number; y: number; z: number }
export type Triple = [number, number, number]
/** A 4×4 matrix, column-major (three.js Matrix4.elements order). */
export type Mat4 = number[]
export interface SceneTransform { position: V3; rotation: V3; scale: V3 }

const DEG = Math.PI / 180

/** The half turn about Y that shows a glTF the way Decentraland does. */
export const MODEL_TURN = Math.PI

export const sceneToThree = (p: V3): Triple => [p.x, p.y, -p.z]
export const threeToScene = (p: Triple | number[]): Triple => [p[0], p[1], -p[2]]

export function toThreeTransform(t: SceneTransform): { position: Triple; rotation: Triple; order: 'YXZ'; scale: Triple } {
  return {
    position: sceneToThree(t.position),
    rotation: [-t.rotation.x * DEG, -t.rotation.y * DEG, t.rotation.z * DEG],
    order: 'YXZ',
    scale: [t.scale.x, t.scale.y, t.scale.z],
  }
}

/** three.js Matrix4.compose of the mapped transform (Euler 'YXZ'). */
export function composeThree(t: SceneTransform): Mat4 {
  const m = toThreeTransform(t)
  const [x, y, z] = m.rotation
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z)
  // Rotation for order YXZ, as three.js's Matrix4.makeRotationFromEuler.
  const ce = c * e, cf = c * f, de = d * e, df = d * f
  const r = [
    ce + df * b, a * f, cf * b - de,
    de * b - cf, a * e, df + ce * b,
    a * d, -b, a * c,
  ]
  const [sx, sy, sz] = m.scale
  const [px, py, pz] = m.position
  return [
    r[0] * sx, r[1] * sx, r[2] * sx, 0,
    r[3] * sy, r[4] * sy, r[5] * sy, 0,
    r[6] * sz, r[7] * sz, r[8] * sz, 0,
    px, py, pz, 1,
  ]
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k]
      out[col * 4 + row] = s
    }
  }
  return out
}

export function applyMat4(m: Mat4, p: Triple | number[]): Triple {
  const [x, y, z] = p
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

/** Each item's three.js world matrix, through its parent chain (a missing parent or a cycle ends the chain). */
export function worldMatrices(items: Array<SceneTransform & { id: string; parentId: string | null }>): Map<string, Mat4> {
  const byId = new Map(items.map((i) => [i.id, i]))
  const out = new Map<string, Mat4>()
  const resolve = (id: string, seen: Set<string>): Mat4 => {
    const done = out.get(id)
    if (done) return done
    const item = byId.get(id)!
    const local = composeThree(item)
    seen.add(id)
    const parent = item.parentId && byId.has(item.parentId) && !seen.has(item.parentId) ? resolve(item.parentId, seen) : null
    const m = parent ? multiply(parent, local) : local
    out.set(id, m)
    return m
  }
  for (const i of items) resolve(i.id, new Set())
  return out
}

/** Convex hull (monotone chain), counter-clockwise. */
function hull(points: Array<{ x: number; z: number }>) {
  const p = [...points].sort((a, b) => a.x - b.x || a.z - b.z)
  if (p.length < 3) return p
  const cross = (o: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x)
  const lower: typeof p = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop()
    lower.push(q)
  }
  const upper: typeof p = []
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/**
 * A model's outline from above, in scene x/z: its box (dimensions, centred on the model's origin in x/z, standing on
 * it in y) through its world matrix and MODEL_TURN.
 */
export function footprintXZ(world: Mat4, dims: V3 | null): Array<{ x: number; z: number }> {
  const hx = (dims?.x || 1) / 2
  const hz = (dims?.z || 1) / 2
  const h = dims?.y || 1
  const pts: Array<{ x: number; z: number }> = []
  for (const x of [-hx, hx]) for (const y of [0, h]) for (const z of [-hz, hz]) {
    // MODEL_TURN: (x, y, z) → (-x, y, -z)
    const [wx, , wz] = applyMat4(world, [-x, y, -z])
    pts.push({ x: wx, z: -wz })
  }
  return hull(pts)
}

/** An orthographic camera straight down over a scene-coordinate box, north up, matching parcel-map's toSvg. */
export function orthoTopDown(b: { minX: number; minZ: number; maxX: number; maxZ: number }, height = 500) {
  const cx = (b.minX + b.maxX) / 2
  const cz = (b.minZ + b.maxZ) / 2
  const w = b.maxX - b.minX
  const h = b.maxZ - b.minZ
  return {
    position: [cx, height, -cz] as Triple,
    target: [cx, 0, -cz] as Triple,
    up: [0, 0, -1] as Triple,
    left: -w / 2,
    right: w / 2,
    top: h / 2,
    bottom: -h / 2,
    near: 0.1,
    far: height * 2,
  }
}
