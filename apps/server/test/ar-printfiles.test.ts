import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { inflateRawSync } from 'node:zlib'
import { ringCodeOf, ringPlaqueSizeMm, ringShapes } from '@virvixr/shared'
import { buildMarkerMeshes, distanceToShape, paperPdf, MARKER_STYLES, screwSpots, stl, threeMf, type Mesh, type Mounting } from '../src/ar/printfiles.js'
import { crc32 } from '../src/ar/zip.js'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { arMarkers, sceneCollaborators } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const ID = 123456
const MOUNTINGS: Mounting[] = ['none', 'tape', 'magnets', 'screws', 'keyhole']

function parseStl(buf: Buffer) {
  const count = buf.readUInt32LE(80)
  const zs: number[] = []
  const xs: number[] = []
  for (let i = 0; i < count; i++) {
    const at = 84 + i * 50 + 12
    for (let v = 0; v < 3; v++) {
      xs.push(buf.readFloatLE(at + v * 12))
      zs.push(buf.readFloatLE(at + v * 12 + 8))
    }
  }
  const range = (a: number[]) => a.reduce((r, n) => [Math.min(r[0], n), Math.max(r[1], n)], [Infinity, -Infinity])
  return { count, z: range(zs), x: range(xs) }
}

/** Reads the entries of a zip written by our writer (sizes come from the central directory). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const n = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(at + 10)
    const crc = buf.readUInt32LE(at + 16)
    const packed = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    expect(method).toBe(8)
    const data = inflateRawSync(buf.subarray(start, start + packed))
    expect(crc32(data)).toBe(crc)
    out.set(name, data)
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** Every directed edge must occur once and its reverse once: a closed, consistently wound surface. */
function openEdges(mesh: Mesh): number {
  const edges = new Map<string, number>()
  for (const [a, b, c] of mesh.tris) {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.set(`${p}>${q}`, (edges.get(`${p}>${q}`) ?? 0) + 1)
  }
  let bad = 0
  for (const [key, n] of edges) {
    const [p, q] = key.split('>')
    if (n !== 1 || edges.get(`${q}>${p}`) !== 1) bad++
  }
  return bad
}

/** Signed volume by the divergence theorem: positive when triangles wind outward. */
function volume(mesh: Mesh): number {
  let v = 0
  for (const [a, b, c] of mesh.tris) {
    const [p, q, r] = [mesh.verts[a], mesh.verts[b], mesh.verts[c]]
    v += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6
  }
  return v
}

describe('ring marker meshes and STL', () => {
  it('STL triangle counts are sane and the file size matches', () => {
    const { base, raised } = buildMarkerMeshes(ID, 140, 'magnets')
    const baseStl = stl(base)
    const raisedStl = stl(raised)
    expect(baseStl.length).toBe(84 + 50 * base.tris.length)
    expect(raisedStl.length).toBe(84 + 50 * raised.tris.length)
    expect(baseStl.readUInt32LE(80)).toBe(base.tris.length)
    expect(base.tris.length).toBeGreaterThan(12)
    expect(raised.tris.length).toBeGreaterThan(300)
    expect(buildMarkerMeshes(ID, 140, 'none').base.tris.length).toBe(12)
  })

  it('names the STL object after the ARC', () => {
    const { base } = buildMarkerMeshes(ID, 140, 'none')
    expect(stl(base).subarray(0, 80).toString('ascii').replace(/\0+$/, '')).toBe('Virvi ARC')
  })

  it('the base is 4 mm thick and the raised parts end at 4.6 mm', () => {
    const { base, raised } = buildMarkerMeshes(ID, 140, 'none')
    const b = parseStl(stl(base))
    const r = parseStl(stl(raised))
    expect(b.z[0]).toBeCloseTo(0, 4)
    expect(b.z[1]).toBeCloseTo(4, 4)
    expect(r.z[0]).toBeCloseTo(4, 4)
    expect(r.z[1]).toBeCloseTo(4.6, 4)
  })

  it('the plaque is the plaque size wide', () => {
    const b = parseStl(stl(buildMarkerMeshes(ID, 140, 'none').base))
    expect(b.x[1] - b.x[0]).toBeCloseTo(ringPlaqueSizeMm(140), 2)
    const small = parseStl(stl(buildMarkerMeshes(ID, 80, 'none').base))
    expect(small.x[1] - small.x[0]).toBeCloseTo(ringPlaqueSizeMm(80), 2)
  })

  it('tape mounting cuts a 1 mm recess', () => {
    const none = buildMarkerMeshes(ID, 140, 'none').base
    const tape = buildMarkerMeshes(ID, 140, 'tape').base
    expect(none.verts.some((v) => Math.abs(v[2] - 1) < 1e-6)).toBe(false)
    const floor = tape.verts.filter((v) => Math.abs(v[2] - 1) < 1e-6)
    expect(floor.length).toBe(4)
    const half = ringPlaqueSizeMm(140) / 2
    expect(Math.max(...floor.map((v) => v[0]))).toBeCloseTo(half - 8, 3)
  })

  it('magnets cut four 2.2 mm deep pockets 10.4 mm wide, 12 mm in from the corners', () => {
    const { base } = buildMarkerMeshes(ID, 140, 'magnets')
    const half = ringPlaqueSizeMm(140) / 2
    const floor = base.verts.filter((v) => Math.abs(v[2] - 2.2) < 1e-6)
    expect(floor.length).toBe(4 * 360)
    expect(Math.max(...floor.map((v) => v[0]))).toBeCloseTo(half - 12 + 5.2, 3)
    expect(Math.min(...floor.map((v) => v[1]))).toBeCloseTo(-(half - 12) - 5.2, 3)
  })

  it('screws cut two countersunk holes in opposite corners, heads clear of every raised shape by 1.5 mm', () => {
    const half = ringPlaqueSizeMm(140) / 2
    const spots = screwSpots(ID, 140)!
    expect(spots).toHaveLength(2)
    const [tl, br] = spots
    expect(tl[0]).toBeLessThan(0)
    expect(tl[1]).toBeGreaterThan(0)
    expect(br[0]).toBeGreaterThan(0)
    expect(br[1]).toBeLessThan(0)
    const shapes = ringShapes(ID, 140)
    for (const [x, y] of spots) {
      for (const sh of shapes) expect(distanceToShape(sh, x, y) - 3.5).toBeGreaterThanOrEqual(1.5 - 1e-9)
      expect(half - Math.abs(x) - 3.5).toBeGreaterThanOrEqual(2 - 1e-9)
      expect(half - Math.abs(y) - 3.5).toBeGreaterThanOrEqual(2 - 1e-9)
    }
    // the mesh really has them: head circle (r 3.5) at z=4, shaft (r 1.75) at z=0
    const { base, raised } = buildMarkerMeshes(ID, 140, 'screws')
    for (const [x, y] of spots) {
      const head = base.verts.filter((v) => Math.abs(v[2] - 4) < 1e-6 && Math.hypot(v[0] - x, v[1] - y) < 3.6)
      expect(head.length).toBe(360)
      expect(Math.max(...head.map((v) => Math.hypot(v[0] - x, v[1] - y)))).toBeCloseTo(3.5, 3)
      const shaft = base.verts.filter((v) => Math.abs(v[2]) < 1e-6 && Math.hypot(v[0] - x, v[1] - y) < 1.8)
      expect(Math.max(...shaft.map((v) => Math.hypot(v[0] - x, v[1] - y)))).toBeCloseTo(1.75, 3)
      // independent of distanceToShape: no raised vertex within 1.5 mm of the head circle
      for (const v of raised.verts) expect(Math.hypot(v[0] - x, v[1] - y)).toBeGreaterThan(3.5 + 1.5 - 0.5)
    }
  })

  it('screws report no room when the corners are crowded', () => {
    expect(screwSpots(1, 60)).toBeNull()
    expect(() => buildMarkerMeshes(1, 60, 'screws')).toThrow('no_room_for_screws')
  })

  it('keyhole thickens the plaque to 6 mm behind a 30 mm square', () => {
    const { base } = buildMarkerMeshes(ID, 140, 'keyhole')
    const half = ringPlaqueSizeMm(140) / 2
    const back = base.verts.filter((v) => Math.abs(v[2] + 2) < 1e-6)
    expect(back.length).toBeGreaterThan(8)
    expect(Math.max(...back.map((v) => v[1]))).toBeCloseTo(half, 3)
    expect(Math.min(...back.map((v) => v[1]))).toBeCloseTo(half - 30, 3)
    expect(Math.max(...back.map((v) => v[0]))).toBeCloseTo(15, 3)
  })

  it.each(MOUNTINGS)('the %s base and the raised part are closed surfaces', (mounting) => {
    const { base, raised } = buildMarkerMeshes(ID, 140, mounting)
    expect(openEdges(base)).toBe(0)
    expect(openEdges(raised)).toBe(0)
  })

  it('the cuts remove the volume they should and the surfaces wind outward', () => {
    const vol = (m: Mounting) => volume(buildMarkerMeshes(ID, 140, m).base)
    expect(vol('none')).toBeCloseTo(150 * 150 * 4, 1)
    expect(vol('tape')).toBeCloseTo(150 * 150 * 4 - 134 * 134 * 1, 1)
    expect(vol('magnets')).toBeGreaterThan(150 * 150 * 4 - 4 * Math.PI * 5.2 * 5.2 * 2.2 - 1)
    expect(vol('magnets')).toBeLessThan(150 * 150 * 4 - 4 * Math.PI * 5.2 * 5.2 * 2.2 * 0.999)
    const sink = (Math.PI * 1.75 * 1.75 * 2.25) + (Math.PI * 1.75 / 3) * (3.5 * 3.5 + 3.5 * 1.75 + 1.75 * 1.75) // shaft + frustum
    expect(150 * 150 * 4 - vol('screws')).toBeGreaterThan(2 * sink * 0.99)
    expect(150 * 150 * 4 - vol('screws')).toBeLessThan(2 * sink * 1.0001)
    expect(vol('keyhole')).toBeGreaterThan(150 * 150 * 4 + 30 * 30 * 2 - 30 * 14 * 6 - 1000)
    expect(vol('keyhole')).toBeLessThan(150 * 150 * 4 + 30 * 30 * 2)
    expect(volume(buildMarkerMeshes(ID, 140, 'none').raised)).toBeGreaterThan(0)
  })

  it('builds the largest allowed marker', () => {
    const { base, raised } = buildMarkerMeshes(ID, 256, 'magnets')
    expect(base.tris.length).toBeGreaterThan(12)
    expect(raised.tris.length).toBeGreaterThan(300)
  })
})

describe('3MF', () => {
  it('is a zip with a model file naming two parts and two filaments', () => {
    const { base, raised } = buildMarkerMeshes(ID, 140, 'tape')
    const files = unzip(threeMf(base, raised))
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model'])
    const model = files.get('3D/3dmodel.model')!.toString('utf8')
    expect(model.match(/<mesh>/g)).toHaveLength(2)
    expect(model.match(/<base name=/g)).toHaveLength(2)
    expect(model).toContain('unit="millimeter"')
    expect(model.match(/<component objectid=/g)).toHaveLength(2)
    expect(model).toContain('pindex="0"')
    expect(model).toContain('pindex="1"')
    expect(model.match(/<vertex /g)!.length).toBe(base.verts.length + raised.verts.length)
    expect(model.match(/<triangle /g)!.length).toBe(base.tris.length + raised.tris.length)
    expect(model).toContain('name="ARC" type="model"><components>')
  })
})

describe('3MF marker styles', () => {
  const model = (style?: 'normal' | 'inverted') => {
    const { base, raised } = buildMarkerMeshes(ID, 140, 'tape')
    return unzip(style ? threeMf(base, raised, style) : threeMf(base, raised)).get('3D/3dmodel.model')!.toString('utf8')
  }

  it('normal is byte-identical to the call without a style', () => {
    const { base, raised } = buildMarkerMeshes(ID, 140, 'tape')
    expect(threeMf(base, raised, 'normal').equals(threeMf(base, raised))).toBe(true)
    expect(model()).toContain('<base name="base (light)" displaycolor="#F2F2F2"/><base name="raised (dark)" displaycolor="#1A1A1A"/>')
  })

  it('inverted swaps the colours and part names, base dark and raised light', () => {
    const m = model('inverted')
    expect(m).toContain('<base name="base (dark)" displaycolor="#1A1A1A"/><base name="raised (light)" displaycolor="#F2F2F2"/>')
    expect(m).toContain('<object id="2" name="base (dark)"')
    expect(m).toContain('<object id="3" name="raised (light)"')
    expect(m).not.toContain('base (light)')
    expect(m).not.toContain('raised (dark)')
  })

  it('inverted has the same meshes as normal', () => {
    const strip = (x: string) => x.replace(/<basematerials.*<\/basematerials>/, '').replace(/name="[^"]*"/g, '')
    expect(strip(model('inverted'))).toBe(strip(model('normal')))
  })

  it('exports the style list', () => {
    expect(MARKER_STYLES).toEqual(['normal', 'inverted'])
  })
})

describe('paper PDF', () => {
  it('normal is byte-identical to the call without a style', () => {
    expect(paperPdf(ID, 140, 'normal').equals(paperPdf(ID, 140))).toBe(true)
  })

  it('inverted fills the plaque black and draws the marks in white', () => {
    const normal = paperPdf(ID, 140).toString('latin1')
    const inverted = paperPdf(ID, 140, 'inverted').toString('latin1')
    const side = ringPlaqueSizeMm(140)
    const k = 72 / 25.4
    const left = (215.9 - side) / 2
    const pageH = 279.4 * k
    const n = (v: number) => String(Math.round(v * 1000) / 1000)
    const fill = `0 g\n${n(left * k)} ${n(pageH - (25 + side) * k)} ${n(side * k)} ${n(side * k)} re f\n1 g`
    expect(inverted).toContain(fill)
    expect(normal).not.toContain('1 g')
    // the marks are the same shapes, after the white colour switch
    const marks = (t: string) => t.slice(t.indexOf('re S'))
    expect(inverted.indexOf('1 g')).toBeGreaterThan(inverted.indexOf('re S'))
    // text and the check bar go back to black
    const afterMarks = inverted.slice(inverted.lastIndexOf('1 g'))
    expect(afterMarks).toContain('0 g')
    expect(afterMarks).toContain('(100 mm) Tj')
    expect(afterMarks).toContain('Do not use "fit to page"')
    expect(marks(inverted).length).toBeGreaterThan(marks(normal).length)
  })

  it('inverted keeps a valid cross-reference table', () => {
    const text = paperPdf(ID, 140, 'inverted').toString('latin1')
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
  })

  it('says to print at 100% and carries the code', () => {
    const pdf = paperPdf(ID, 140)
    const text = pdf.toString('latin1')
    expect(text.startsWith('%PDF-')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text).toContain(ringCodeOf(ID))
    expect(text).toContain(`virvi.io/s/${ringCodeOf(ID)}`)
    expect(text).toContain('100%')
    expect(text).toContain(`(Virvi ARC ${ringCodeOf(ID)})`)
    expect(text).toContain('ARC 140 mm.')
    expect(text).toContain('the ARC is the wrong size.')
    expect(text).not.toMatch(/ring/i)
    expect(text).toContain('/MediaBox [0 0 612 792]')
    expect(text).not.toContain('/Image')
  })

  it('has a cross-reference table that points at its objects', () => {
    const buf = paperPdf(ID, 140)
    const text = buf.toString('latin1')
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]))
    entries.forEach((off, i) => expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`))
    expect(entries.length).toBeGreaterThanOrEqual(5)
  })

  it('refuses a plaque that does not fit on Letter', () => {
    expect(() => paperPdf(ID, 256)).toThrow('too_large_for_paper')
  })
})

describe('print file download route', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })
  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

  async function setup() {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const space = (await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/ar/spaces`, headers: as(owner), payload: { name: 'Arcade' } })).json()
    const marker = (await app.inject({ method: 'POST', url: `/api/ar/floors/${space.floors[0].id}/markers`, headers: as(owner), payload: {} })).json()
    return { owner, scene, marker }
  }

  it('names the file', async () => {
    const s = await setup()
    const res = await app.inject({ method: 'GET', url: `/api/ar/markers/${s.marker.id}/files?format=stl-base`, headers: as(s.owner) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe(`attachment; filename="virvi-arc-${s.marker.code}-140mm-base.stl"`)
    expect(res.headers['content-type']).toBe('model/stl')
    expect(parseStl(res.rawPayload).count).toBe(12)
    expect(res.rawPayload.subarray(0, 80).toString('ascii').replace(/\0+$/, '')).toBe(`Virvi ARC ${s.marker.code} base`)
  })

  it('serves every format, and mounting changes the base', async () => {
    const s = await setup()
    const get = (q: string) => app.inject({ method: 'GET', url: `/api/ar/markers/${s.marker.id}/files?${q}`, headers: as(s.owner) })
    const types: Record<string, [string, string]> = {
      'stl-raised': ['model/stl', 'stl'],
      '3mf': ['model/3mf', '3mf'],
      pdf: ['application/pdf', 'pdf'],
      svg: ['image/svg+xml', 'svg'],
    }
    for (const [format, [type, ext]] of Object.entries(types)) {
      const res = await get(`format=${format}`)
      expect(res.statusCode, format).toBe(200)
      expect(res.headers['content-type']).toContain(type)
      const suffix = format === 'stl-raised' ? '-raised' : ''
      expect(res.headers['content-disposition']).toContain(`virvi-arc-${s.marker.code}-140mm${suffix}.${ext}`)
    }
    expect((await get('format=svg')).body).toContain('<svg')
    const keyhole = await get('format=stl-base&mounting=keyhole')
    expect(parseStl(keyhole.rawPayload).count).toBeGreaterThan(12)
    expect(parseStl(keyhole.rawPayload).z[0]).toBeCloseTo(-2, 4)
  })

  it('style: inverted adds -inverted to the filename, normal and missing do not, STLs are identical', async () => {
    const s = await setup()
    const get = (q: string) => app.inject({ method: 'GET', url: `/api/ar/markers/${s.marker.id}/files?${q}`, headers: as(s.owner) })
    const code = s.marker.code
    for (const [format, suffix, ext] of [['pdf', '', 'pdf'], ['3mf', '', '3mf'], ['stl-base', '-base', 'stl'], ['stl-raised', '-raised', 'stl']] as const) {
      const inv = await get(`format=${format}&style=inverted`)
      expect(inv.statusCode, format).toBe(200)
      expect(inv.headers['content-disposition']).toBe(`attachment; filename="virvi-arc-${code}-140mm${suffix}-inverted.${ext}"`)
      const normal = await get(`format=${format}&style=normal`)
      const missing = await get(`format=${format}`)
      expect(normal.headers['content-disposition']).toBe(`attachment; filename="virvi-arc-${code}-140mm${suffix}.${ext}"`)
      expect(normal.rawPayload.equals(missing.rawPayload), format).toBe(true)
      if (format.startsWith('stl')) expect(inv.rawPayload.equals(normal.rawPayload), format).toBe(true)
      else expect(inv.rawPayload.equals(normal.rawPayload), format).toBe(false)
    }
  })

  it('rejects an unknown style', async () => {
    const s = await setup()
    const res = await app.inject({ method: 'GET', url: `/api/ar/markers/${s.marker.id}/files?format=pdf&style=bogus`, headers: as(s.owner) })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an unknown format or mounting', async () => {
    const s = await setup()
    for (const q of ['', 'format=obj', 'format=stl-base&mounting=glue']) {
      const res = await app.inject({ method: 'GET', url: `/api/ar/markers/${s.marker.id}/files?${q}`, headers: as(s.owner) })
      expect(res.statusCode, q).toBe(400)
    }
  })

  it('refuses a PDF for a plaque too big for Letter', async () => {
    const s = await setup()
    await app.inject({ method: 'PUT', url: `/api/ar/markers/${s.marker.id}`, headers: as(s.owner), payload: { diameterMm: 250 } })
    const res = await app.inject({ method: 'GET', url: `/api/ar/markers/${s.marker.id}/files?format=pdf`, headers: as(s.owner) })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'too_large_for_paper' })
    expect((await app.inject({ method: 'GET', url: `/api/ar/markers/${s.marker.id}/files?format=stl-base`, headers: as(s.owner) })).statusCode).toBe(200)
  })

  it('answers 400 no_room_for_screws when the corners are crowded', async () => {
    const s = await setup()
    await app.inject({ method: 'PUT', url: `/api/ar/markers/${s.marker.id}`, headers: as(s.owner), payload: { diameterMm: 60 } })
    await db.update(arMarkers).set({ ringId: 1 }).where(eq(arMarkers.id, s.marker.id))
    const url = `/api/ar/markers/${s.marker.id}/files`
    const res = await app.inject({ method: 'GET', url: `${url}?format=stl-base&mounting=screws`, headers: as(s.owner) })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'no_room_for_screws' })
    expect((await app.inject({ method: 'GET', url: `${url}?format=stl-base&mounting=tape`, headers: as(s.owner) })).statusCode).toBe(200)
  })

  it('needs build access: a viewer and a stranger are refused, an unknown marker is 404', async () => {
    const s = await setup()
    const viewer = await createUser()
    const stranger = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId: s.scene.id, userId: viewer.id, role: 'viewer' })
    const url = `/api/ar/markers/${s.marker.id}/files?format=svg`
    expect((await app.inject({ method: 'GET', url, headers: as(viewer) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url, headers: as(stranger) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: `/api/ar/markers/00000000-0000-4000-8000-000000000000/files?format=svg`, headers: as(s.owner) })).statusCode).toBe(404)
  })
})
