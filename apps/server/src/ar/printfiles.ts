import { ringCodeOf, ringPlaqueSizeMm, ringShapes, type RingShape } from '@virvixr/shared'
import { zip } from './zip.js'

/**
 * Print files for a ring marker: a light base plaque and the dark raised shapes as separate meshes
 * (STL each, or one two-filament 3MF), plus a vector paper PDF. A port of apps/ring-marker's
 * printfiles.py; lengths in mm, x right, y up, z up from the plaque's back.
 */

export type Mounting = 'none' | 'tape' | 'magnets' | 'screws' | 'keyhole'
export const MOUNTINGS: readonly Mounting[] = ['none', 'tape', 'magnets', 'screws', 'keyhole']

/** Normal is dark marks on a light plaque; inverted is light marks on a dark plaque. */
export type MarkerStyle = 'normal' | 'inverted'
export const MARKER_STYLES: readonly MarkerStyle[] = ['normal', 'inverted']

const BASE_MM = 4.0
const RAISED_MM = 0.6
const ARC_STEP_DEG = 1

type P = [number, number]
type P3 = [number, number, number]

// ---------------------------------------------------------------------------------------------
// Mesh

export class Mesh {
  verts: P3[] = []
  tris: [number, number, number][] = []
  private index = new Map<string, number>()
  /** Vertices are only shared within one tag, so parts that merely touch stay separate shells. */
  tag = 0

  v(p: P3): number {
    const q = p.map((c) => Math.round(c * 1e4) / 1e4) as P3
    const key = `${q[0]},${q[1]},${q[2]},${this.tag}`
    let i = this.index.get(key)
    if (i === undefined) {
      i = this.verts.length
      this.verts.push(q)
      this.index.set(key, i)
    }
    return i
  }

  tri(a: P3, b: P3, c: P3) {
    this.tris.push([this.v(a), this.v(b), this.v(c)])
  }

  /** Counter-clockwise seen from outside. */
  quad(a: P3, b: P3, c: P3, d: P3) {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }
}

// ---------------------------------------------------------------------------------------------
// 2D polygons: ear clipping with hole bridging (the plaque faces have rectangles and circles cut out)

const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
const same = (a: P, b: P) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9
const signedArea = (poly: P[]) => poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1] }, 0) / 2

function inTriangle(p: P, a: P, b: P, c: P): boolean {
  const eps = -1e-9
  return cross(a, b, p) >= eps && cross(b, c, p) >= eps && cross(c, a, p) >= eps
}

function earClip(input: P[]): [P, P, P][] {
  const pts = input.slice()
  const out: [P, P, P][] = []
  let i = 0
  let misses = 0
  while (pts.length > 3) {
    const n = pts.length
    const a = pts[(i + n - 1) % n]
    const b = pts[i % n]
    const c = pts[(i + 1) % n]
    let ear = cross(a, b, c) > 1e-9
    if (ear) {
      for (const p of pts) {
        if (same(p, a) || same(p, b) || same(p, c)) continue
        if (inTriangle(p, a, b, c)) { ear = false; break }
      }
    }
    if (ear || misses > n) {
      if (cross(a, b, c) > 1e-9) out.push([a, b, c])
      pts.splice(i % n, 1)
      i = Math.max(0, (i % n) - 1)
      misses = 0
    } else {
      i = (i + 1) % n
      misses++
    }
  }
  if (pts.length === 3 && cross(pts[0], pts[1], pts[2]) > 1e-9) out.push([pts[0], pts[1], pts[2]])
  return out
}

function crosses(p1: P, p2: P, p3: P, p4: P): boolean {
  const d1 = cross(p3, p4, p1)
  const d2 = cross(p3, p4, p2)
  const d3 = cross(p1, p2, p3)
  const d4 = cross(p1, p2, p4)
  return d1 * d2 < -1e-12 && d3 * d4 < -1e-12
}

function insideEvenOdd(p: P, rings: P[][]): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
    }
  }
  return inside
}

/** Triangles (counter-clockwise) covering `outer` minus `holes`. Outer is counter-clockwise, holes any winding, strictly inside. */
export function triangulate(outer: P[], holes: P[][] = []): [P, P, P][] {
  let poly = outer.slice()
  const rest = holes.map((h) => (signedArea(h) > 0 ? h.slice().reverse() : h.slice())) // holes clockwise
  const order = rest.map((_, i) => i).sort((a, b) => Math.max(...rest[b].map((p) => p[0])) - Math.max(...rest[a].map((p) => p[0])))
  const pending = new Set(order)
  for (const hi of order) {
    pending.delete(hi)
    const hole = rest[hi]
    const others = [...pending].map((j) => rest[j])
    let mi = 0
    hole.forEach((p, k) => { if (p[0] > hole[mi][0]) mi = k })
    const m = hole[mi]
    const edges: [P, P][] = []
    for (const ring of [poly, hole, ...others]) ring.forEach((p, k) => edges.push([p, ring[(k + 1) % ring.length]]))
    const candidates = poly.map((p, k) => k).sort((a, b) => Math.hypot(poly[a][0] - m[0], poly[a][1] - m[1]) - Math.hypot(poly[b][0] - m[0], poly[b][1] - m[1]))
    let vi = -1
    for (const k of candidates) {
      const v = poly[k]
      if (edges.some(([p, q]) => crosses(m, v, p, q))) continue
      const mid: P = [(m[0] + v[0]) / 2, (m[1] + v[1]) / 2]
      if (!insideEvenOdd(mid, [poly, hole, ...others])) continue
      vi = k
      break
    }
    if (vi < 0) throw new Error('cannot bridge hole')
    poly = [...poly.slice(0, vi + 1), ...hole.slice(mi), ...hole.slice(0, mi + 1), poly[vi], ...poly.slice(vi + 1)]
  }
  return earClip(poly)
}

// ---------------------------------------------------------------------------------------------
// Shapes as polygons and surfaces

const rad = (deg: number) => (deg * Math.PI) / 180

/** Counter-clockwise points on an arc, from `fromDeg` to `toDeg` (maths angles, from +x), both ends included. */
function arc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): P[] {
  const n = Math.max(1, Math.ceil((toDeg - fromDeg) / ARC_STEP_DEG - 1e-9))
  return Array.from({ length: n + 1 }, (_, k) => {
    const a = rad(fromDeg + ((toDeg - fromDeg) * k) / n)
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as P
  })
}
const circle = (cx: number, cy: number, r: number): P[] => arc(cx, cy, r, 0, 360).slice(0, -1)
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const reversed = (p: P[]): P[] => p.slice().reverse()
const at = (p: P, z: number): P3 => [p[0], p[1], z]

/** A flat face at height z, normal up or down. */
function face(mesh: Mesh, outer: P[], holes: P[][], z: number, up: boolean) {
  for (const [a, b, c] of triangulate(outer, holes)) {
    if (up) mesh.tri(at(a, z), at(b, z), at(c, z))
    else mesh.tri(at(a, z), at(c, z), at(b, z))
  }
}

/**
 * A wall between two rings of equal length (lower at z0, upper at z1). The material lies to the
 * left of each edge, so outer boundaries run counter-clockwise and holes clockwise.
 */
function band(mesh: Mesh, lower: P[], upper: P[], z0: number, z1: number) {
  for (let i = 0; i < lower.length; i++) {
    const j = (i + 1) % lower.length
    mesh.quad(at(lower[i], z0), at(lower[j], z0), at(upper[j], z1), at(upper[i], z1))
  }
}
const wall = (mesh: Mesh, ring: P[], z0: number, z1: number) => band(mesh, ring, ring, z0, z1)

// ---------------------------------------------------------------------------------------------
// Screw positions

const SHAFT_MM = 3.5
const HEAD_MM = 7
const HEAD_CLEAR_MM = 1.5 // head circle to any raised shape
const EDGE_CLEAR_MM = 2 // head circle to the plaque edge

/** Distance from a point to a raised shape (0 inside it). */
export function distanceToShape(s: RingShape, x: number, y: number): number {
  if (s.kind === 'rect') return Math.hypot(Math.max(s.x0 - x, 0, x - s.x1), Math.max(s.y0 - y, 0, y - s.y1))
  const r = Math.hypot(x, y)
  if (s.kind === 'disc') return Math.max(0, r - s.r)
  const deg = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 // clockwise from +y
  const full = s.a1 - s.a0 >= 360 - 1e-9
  const a0 = s.a0 % 360
  if (full || (deg >= a0 && deg <= a0 + (s.a1 - s.a0)) || (deg + 360 >= a0 && deg + 360 <= a0 + (s.a1 - s.a0))) {
    return r < s.r0 ? s.r0 - r : r > s.r1 ? r - s.r1 : 0
  }
  let best = Infinity
  for (const a of [s.a0, s.a1]) {
    const dx = Math.sin(rad(a))
    const dy = Math.cos(rad(a))
    const t = Math.min(s.r1, Math.max(s.r0, x * dx + y * dy))
    best = Math.min(best, Math.hypot(x - t * dx, y - t * dy))
  }
  return best
}

/**
 * Countersunk screw holes in the top-left and bottom-right corners: in each, the spot (searched on a
 * 0.5 mm grid) with the most room around its head. Null when a corner has no spot that keeps the
 * head 1.5 mm from every raised shape and 2 mm from the plaque edge.
 */
export function screwSpots(markerId: number, diameterMm: number): P[] | null {
  const shapes = ringShapes(markerId, diameterMm)
  const h = ringPlaqueSizeMm(diameterMm) / 2
  const reach = HEAD_MM / 2
  const spots: P[] = []
  for (const sign of [1, -1]) {
    let best: P | null = null
    let bestSlack = -Infinity
    for (let u = EDGE_CLEAR_MM + reach; u <= 30; u += 0.5) {
      for (let v = EDGE_CLEAR_MM + reach; v <= 30; v += 0.5) {
        const x = sign * -(h - u) // top-left: x negative, y positive; bottom-right mirrors it
        const y = sign * (h - v)
        // slack: how far the head is past the requirements (negative = too close)
        let slack = Math.min(u, v) - reach - EDGE_CLEAR_MM
        for (const sh of shapes) slack = Math.min(slack, distanceToShape(sh, x, y) - reach - HEAD_CLEAR_MM)
        if (best === null || slack > bestSlack) { bestSlack = slack; best = [x, y] }
      }
    }
    if (!best || bestSlack < 0) return null
    spots.push(best)
  }
  return spots
}

// ---------------------------------------------------------------------------------------------
// The base plaque and its mounting cuts

function keyholeOutlines(cx: number, cy: number) {
  // Entry circle (8 mm head) at the bottom, a 4 mm slot rising 10 mm; behind it a 9 mm wide channel the head slides in.
  const J = Math.asin(Math.sqrt(16 - 4) / 4) * (180 / Math.PI) // where the slot meets the entry circle
  const opening = [...arc(cx, cy, 4, 180 - J, 360 + J), ...arc(cx, cy + 10, 2, 0, 180)]
  const channel = [...arc(cx, cy, 4.5, 180, 360), ...arc(cx, cy + 10, 4.5, 0, 180)]
  return { opening: dropRepeats(opening), channel: dropRepeats(channel) }
}

function dropRepeats(poly: P[]): P[] {
  return poly.filter((p, i) => !same(p, poly[(i + 1) % poly.length]))
}

function buildBase(markerId: number, diameterMm: number, mounting: Mounting): Mesh {
  const sizeMm = ringPlaqueSizeMm(diameterMm)
  const mesh = new Mesh()
  const h = sizeMm / 2
  const plate = rect(-h, -h, h, h)

  if (mounting === 'keyhole') {
    const boss = rect(-15, h - 30, 15, h)
    const { opening, channel } = keyholeOutlines(0, h - 20)
    const plateSplit: P[] = [[-h, -h], [h, -h], [h, h], [15, h], [-15, h], [-h, h]]
    const notched: P[] = [[-h, -h], [h, -h], [h, h], [15, h], [15, h - 30], [-15, h - 30], [-15, h], [-h, h]]
    face(mesh, plateSplit, [], BASE_MM, true)
    wall(mesh, plateSplit, 0, BASE_MM)
    face(mesh, notched, [], 0, false)
    wall(mesh, boss, -2, 0)
    face(mesh, boss, [opening], -2, false)
    wall(mesh, reversed(opening), -2, 0)
    face(mesh, channel, [opening], 0, true)
    wall(mesh, reversed(channel), 0, 2)
    face(mesh, channel, [], 2, false)
    return mesh
  }

  const backHoles: P[][] = [] // pockets and through holes seen in the back face
  const frontHoles: P[][] = [] // holes through the front face
  if (mounting === 'tape') {
    const pocket = rect(-h + 8, -h + 8, h - 8, h - 8)
    backHoles.push(pocket)
    wall(mesh, reversed(pocket), 0, 1)
    face(mesh, pocket, [], 1, false)
  } else if (mounting === 'magnets') {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const pocket = circle(sx * (h - 12), sy * (h - 12), 5.2)
        backHoles.push(pocket)
        wall(mesh, reversed(pocket), 0, 2.2)
        face(mesh, pocket, [], 2.2, false)
      }
    }
  } else if (mounting === 'screws') {
    const spots = screwSpots(markerId, diameterMm)
    if (!spots) throw new Error('no_room_for_screws')
    const sinkDepth = (HEAD_MM - SHAFT_MM) / 2 // 45 degree countersink from the head to the shaft
    for (const [x, y] of spots) {
      const head = circle(x, y, HEAD_MM / 2)
      const shaft = circle(x, y, SHAFT_MM / 2)
      frontHoles.push(head)
      backHoles.push(shaft)
      band(mesh, reversed(shaft), reversed(shaft), 0, BASE_MM - sinkDepth)
      band(mesh, reversed(shaft), reversed(head), BASE_MM - sinkDepth, BASE_MM)
    }
  }
  face(mesh, plate, frontHoles, BASE_MM, true)
  face(mesh, plate, backHoles, 0, false)
  wall(mesh, plate, 0, BASE_MM)
  return mesh
}

// ---------------------------------------------------------------------------------------------
// The raised shapes

function sectorExtrude(mesh: Mesh, s: Extract<RingShape, { kind: 'sector' }>, z0: number, z1: number) {
  const full = s.a1 - s.a0 >= 360 - 1e-9
  const n = Math.max(1, Math.ceil((s.a1 - s.a0) / ARC_STEP_DEG - 1e-9))
  // angles run clockwise from +y
  const p = (r: number, i: number, z: number): P3 => {
    const a = rad(s.a0 + ((s.a1 - s.a0) * i) / n)
    return [r * Math.sin(a), r * Math.cos(a), z]
  }
  for (let i = 0; i < n; i++) {
    const j = i + 1
    mesh.quad(p(s.r0, i, z1), p(s.r0, j, z1), p(s.r1, j, z1), p(s.r1, i, z1)) // top
    mesh.quad(p(s.r0, j, z0), p(s.r0, i, z0), p(s.r1, i, z0), p(s.r1, j, z0)) // bottom
    mesh.quad(p(s.r1, j, z0), p(s.r1, i, z0), p(s.r1, i, z1), p(s.r1, j, z1)) // outer wall
    mesh.quad(p(s.r0, i, z0), p(s.r0, j, z0), p(s.r0, j, z1), p(s.r0, i, z1)) // inner wall
  }
  if (!full) {
    mesh.quad(p(s.r0, n, z0), p(s.r1, n, z0), p(s.r1, n, z1), p(s.r0, n, z1)) // end cap (clockwise side)
    mesh.quad(p(s.r1, 0, z0), p(s.r0, 0, z0), p(s.r0, 0, z1), p(s.r1, 0, z1)) // start cap
  }
}

function discExtrude(mesh: Mesh, r: number, z0: number, z1: number) {
  const ring = circle(0, 0, r)
  face(mesh, ring, [], z1, true)
  face(mesh, ring, [], z0, false)
  wall(mesh, ring, z0, z1)
}

type RectShape = Extract<RingShape, { kind: 'rect' }>
const EPS = 1e-6
const near = (a: number, b: number) => Math.abs(a - b) < EPS

/** The corner squares: neighbours that share an edge become one shell with no wall between them; squares that only touch at a corner stay separate. */
function rectsExtrude(mesh: Mesh, rects: RectShape[], z0: number, z1: number) {
  const parent = rects.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const edgeNeighbour = (a: RectShape, b: RectShape) =>
    (near(a.x1, b.x0) && near(a.y0, b.y0) && near(a.y1, b.y1)) || (near(a.y1, b.y0) && near(a.x0, b.x0) && near(a.x1, b.x1))
  rects.forEach((a, i) => rects.forEach((b, j) => { if (edgeNeighbour(a, b)) parent[find(i)] = find(j) }))
  const has = (f: (b: RectShape) => boolean) => rects.some(f)
  const startTag = mesh.tag
  rects.forEach((r, i) => {
    mesh.tag = startTag + 1 + find(i)
    const ring = rect(r.x0, r.y0, r.x1, r.y1)
    mesh.quad(at(ring[0], z1), at(ring[1], z1), at(ring[2], z1), at(ring[3], z1))
    mesh.quad(at(ring[0], z0), at(ring[3], z0), at(ring[2], z0), at(ring[1], z0))
    const sides: [boolean, number][] = [
      [has((b) => near(b.y1, r.y0) && near(b.x0, r.x0) && near(b.x1, r.x1)), 0],
      [has((b) => near(b.x0, r.x1) && near(b.y0, r.y0) && near(b.y1, r.y1)), 1],
      [has((b) => near(b.y0, r.y1) && near(b.x0, r.x0) && near(b.x1, r.x1)), 2],
      [has((b) => near(b.x1, r.x0) && near(b.y0, r.y0) && near(b.y1, r.y1)), 3],
    ]
    for (const [shared, k] of sides) {
      if (!shared) mesh.quad(at(ring[k], z0), at(ring[(k + 1) % 4], z0), at(ring[(k + 1) % 4], z1), at(ring[k], z1))
    }
  })
  mesh.tag = startTag + 1 + rects.length
}

/** The base (light, z 0 to 4, minus the mounting cuts) and the raised part (dark, z 4 to 4.6), same origin. */
export function buildMarkerMeshes(markerId: number, diameterMm: number, mounting: Mounting = 'none'): { base: Mesh; raised: Mesh } {
  const base = buildBase(markerId, diameterMm, mounting)
  const raised = new Mesh()
  const z0 = BASE_MM
  const z1 = BASE_MM + RAISED_MM
  const rects: RectShape[] = []
  for (const s of ringShapes(markerId, diameterMm)) {
    raised.tag++
    if (s.kind === 'sector') sectorExtrude(raised, s, z0, z1)
    else if (s.kind === 'disc') discExtrude(raised, s.r, z0, z1)
    else rects.push(s)
  }
  raised.tag++
  rectsExtrude(raised, rects, z0, z1)
  return { base, raised }
}

// ---------------------------------------------------------------------------------------------
// File formats

/** Binary STL. */
export function stl(mesh: Mesh, name = 'Virvi ring marker'): Buffer {
  const buf = Buffer.alloc(84 + 50 * mesh.tris.length)
  buf.write(name.slice(0, 80), 0, 'latin1')
  buf.writeUInt32LE(mesh.tris.length, 80)
  mesh.tris.forEach(([a, b, c], i) => {
    const pa = mesh.verts[a]
    const pb = mesh.verts[b]
    const pc = mesh.verts[c]
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]
    const w = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    const len = Math.hypot(n[0], n[1], n[2]) || 1
    let at = 84 + i * 50
    for (const x of [n[0] / len, n[1] / len, n[2] / len, ...pa, ...pb, ...pc]) { buf.writeFloatLE(x, at); at += 4 }
    buf.writeUInt16LE(0, at)
  })
  return buf
}

/**
 * A 3MF with the two meshes as parts of one object, each with its own base material, so slicers
 * (Bambu Studio, PrusaSlicer) load two parts and let you give each a filament.
 */
export function threeMf(base: Mesh, raised: Mesh, style: MarkerStyle = 'normal'): Buffer {
  const parts: [string, Mesh, string][] = style === 'inverted'
    ? [['base (dark)', base, '#1A1A1A'], ['raised (light)', raised, '#F2F2F2']]
    : [['base (light)', base, '#F2F2F2'], ['raised (dark)', raised, '#1A1A1A']]
  const mats = parts.map(([n, , c]) => `<base name="${n}" displaycolor="${c}"/>`).join('')
  const objects = parts.map(([name, m], i) => {
    const vs = m.verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')
    const ts = m.tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')
    return `<object id="${i + 2}" name="${name}" type="model" pid="1" pindex="${i}"><mesh><vertices>${vs}</vertices><triangles>${ts}</triangles></mesh></object>`
  })
  const wrapperId = parts.length + 2
  const comps = parts.map((_, i) => `<component objectid="${i + 2}"/>`).join('')
  objects.push(`<object id="${wrapperId}" name="marker" type="model"><components>${comps}</components></object>`)
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    `<resources><basematerials id="1">${mats}</basematerials>${objects.join('')}</resources>` +
    `<build><item objectid="${wrapperId}"/></build></model>`
  return zip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    },
    { name: '3D/3dmodel.model', data: model },
  ])
}

// ---------------------------------------------------------------------------------------------
// Paper PDF: US Letter, vector shapes, hand-written objects

const LETTER_MM: P = [215.9, 279.4]
const PT_PER_MM = 72 / 25.4
const MAX_PLAQUE_ON_LETTER_MM = 196 // 10 mm margins each side; leaves room for the title above and the check bar below

const num = (n: number) => String(Math.round(n * 1000) / 1000)
const pdfText = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)

export function paperPdf(markerId: number, diameterMm: number, style: MarkerStyle = 'normal'): Buffer {
  const side = ringPlaqueSizeMm(diameterMm)
  if (side > MAX_PLAQUE_ON_LETTER_MM) throw new Error('too_large_for_paper')
  const code = ringCodeOf(markerId)
  const k = PT_PER_MM
  const pageH = LETTER_MM[1] * k
  const ops: string[] = []
  const X = (mm: number) => num(mm * k)
  const Y = (mmFromTop: number) => num(pageH - mmFromTop * k)
  const text = (xMm: number, yMm: number, size: number, s: string, font = 'F1') =>
    ops.push(`BT /${font} ${size} Tf ${X(xMm)} ${Y(yMm)} Td (${pdfText(s)}) Tj ET`)

  const left = (LETTER_MM[0] - side) / 2
  const top = 25
  const cx = (left + side / 2) * k
  const cy = pageH - (top + side / 2) * k
  const poly = (pts: P[]) => pts.map(([x, y], i) => `${num(cx + x * k)} ${num(cy + y * k)} ${i ? 'l' : 'm'}`).join(' ') + ' h'

  text(15, 14, 16, `Virvi ring marker  ${code}`, 'F2')
  ops.push('0 G 0.6 w', `${X(left)} ${Y(top + side)} ${num(side * k)} ${num(side * k)} re S`)
  ops.push('0 g')
  if (style === 'inverted') ops.push(`${X(left)} ${Y(top + side)} ${num(side * k)} ${num(side * k)} re f`, '1 g')
  for (const s of ringShapes(markerId, diameterMm)) {
    if (s.kind === 'rect') {
      ops.push(`${num(cx + s.x0 * k)} ${num(cy + s.y0 * k)} ${num((s.x1 - s.x0) * k)} ${num((s.y1 - s.y0) * k)} re f`)
    } else if (s.kind === 'disc') {
      ops.push(`${poly(circle(0, 0, s.r))} f`)
    } else if (s.a1 - s.a0 >= 360 - 1e-9) {
      ops.push(`${poly(circle(0, 0, s.r1))} ${poly(circle(0, 0, s.r0))} f*`)
    } else {
      const n = Math.max(1, Math.ceil((s.a1 - s.a0) / ARC_STEP_DEG - 1e-9))
      const pt = (r: number, i: number): P => { const a = rad(s.a0 + ((s.a1 - s.a0) * i) / n); return [r * Math.sin(a), r * Math.cos(a)] }
      const outer = Array.from({ length: n + 1 }, (_, i) => pt(s.r1, i))
      const inner = Array.from({ length: n + 1 }, (_, i) => pt(s.r0, n - i))
      ops.push(`${poly([...outer, ...inner])} f`)
    }
  }
  if (style === 'inverted') ops.push('0 g') // the text and check bar stay black on the white page
  const below = top + side
  text(15, below + 10, 11, `Plaque ${num(side)} mm square, ring ${num(diameterMm)} mm.`)
  text(15, below + 16, 11, 'Print at 100% (actual size). Do not use "fit to page".', 'F2')
  text(15, below + 22, 11, 'The bar below must measure 100 mm; if it does not, the marker is the wrong size.')
  const barY = below + 28
  ops.push('0 g', `${X(15)} ${Y(barY + 3)} ${num(100 * k)} ${num(3 * k)} re f`)
  for (let t = 0; t <= 100; t += 10) ops.push(`${X(15 + t)} ${Y(barY)} m ${X(15 + t)} ${Y(barY - 2)} l S`)
  text(118, barY + 2.5, 11, '100 mm')
  text(15, barY + 12, 11, `${code}   virvi.io/s/${code}`)

  const content = ops.join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
