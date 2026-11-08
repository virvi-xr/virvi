import { describe, it, expect, vi } from 'vitest'
import { FRAME_MAT, defaultFrame, type FrameSettings } from '@virvixr/shared'
import { ItemFrame, frameParts, framePartTransforms } from '../src/managers/frame.js'
import { eulerDegreesToQuat, rotateVector } from '../src/transform/math.js'

const frame = (over: Partial<FrameSettings> = {}): FrameSettings => ({ ...defaultFrame(), ...over })
const one = { x: 1, y: 1, z: 1 }
const zero = { x: 0, y: 0, z: 0 }
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6)

/** Bounds of a part in the picture's own (unrotated) space: [minX, maxX, minY, maxY, minZ, maxZ]. */
const bounds = (p: { position: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } }) => [
  p.position.x - p.scale.x / 2, p.position.x + p.scale.x / 2,
  p.position.y - p.scale.y / 2, p.position.y + p.scale.y / 2,
  p.position.z - p.scale.z / 2, p.position.z + p.scale.z / 2,
]

describe('frameParts (bar transforms around a picture)', () => {
  const cases = [
    { name: 'landscape', scale: { x: 4, y: 2, z: 1 } },
    { name: 'portrait', scale: { x: 1.5, y: 3, z: 1 } },
    { name: 'square', scale: { x: 2, y: 2, z: 1 } },
  ]
  for (const { name, scale } of cases) {
    it(`four bars hug a ${name} picture's edges, outside it, with no gaps at the corners`, () => {
      const parts = frameParts(frame({ thickness: 5 }), scale)
      expect(parts.map((p) => p.role)).toEqual(['top', 'bottom', 'left', 'right'])
      expect(parts.every((p) => p.shape === 'box' && p.color === '#1c1c1c')).toBe(true)
      const t = 0.05 * Math.min(scale.x, scale.y)
      const w = scale.x / 2
      const h = scale.y / 2
      const [top, bottom, left, right] = parts.map(bounds)
      // top and bottom span the full outer width; left and right fill the height between them
      expect([top[0], top[1], top[2], top[3]].map((n) => +n.toFixed(6))).toEqual([-(w + t), w + t, h, h + t].map((n) => +n.toFixed(6)))
      expect([bottom[2], bottom[3]].map((n) => +n.toFixed(6))).toEqual([-(h + t), -h].map((n) => +n.toFixed(6)))
      expect([left[0], left[1], left[2], left[3]].map((n) => +n.toFixed(6))).toEqual([-(w + t), -w, -h, h].map((n) => +n.toFixed(6)))
      expect([right[0], right[1]].map((n) => +n.toFixed(6))).toEqual([w, w + t].map((n) => +n.toFixed(6)))
    })
  }

  it('thickness is a share of the shorter side, so a frame keeps its look when resized', () => {
    const small = frameParts(frame({ thickness: 10 }), { x: 2, y: 1, z: 1 })
    const big = frameParts(frame({ thickness: 10 }), { x: 8, y: 4, z: 1 })
    close(small[0].scale.y, 0.1)
    close(big[0].scale.y, 0.4)
  })

  it('bars are centred on the picture plane, so a frame reads the same from both sides; Classic is the deepest', () => {
    const at = (style: FrameSettings['style']) => frameParts(frame({ style, thickness: 5 }), { x: 2, y: 2, z: 1 })
    for (const style of ['thin', 'classic', 'gallery'] as const) {
      for (const p of at(style)) close(p.position.z, 0)
    }
    expect(at('classic')[0].scale.z).toBeGreaterThan(at('thin')[0].scale.z)
    expect(at('classic')[0].scale.z).toBeGreaterThan(at('gallery')[0].scale.z)
  })

  it('bars never stand out more than 2 cm either side of the picture, however thick (no poking through walls)', () => {
    for (const style of ['thin', 'classic', 'gallery'] as const) {
      const bar = frameParts(frame({ style, thickness: 20 }), { x: 6, y: 3, z: 1 })[0]
      expect(bar.scale.z / 2).toBeLessThanOrEqual(0.02 + 1e-9)
    }
    // a small, slim frame is shallower than the cap: in proportion to its width
    expect(frameParts(frame({ thickness: 1 }), { x: 1, y: 0.5, z: 1 })[0].scale.z).toBeLessThan(0.02)
  })

  it('Gallery puts a mat in four strips around the picture, in its plane and never over it, and the bars around the mat', () => {
    const scale = { x: 3, y: 2, z: 1 }
    const parts = frameParts(frame({ style: 'gallery', thickness: 2, color: '#000000' }), scale)
    expect(parts.map((p) => p.role)).toEqual(['top', 'bottom', 'left', 'right', 'mat', 'mat', 'mat', 'mat'])
    const mats = parts.filter((p) => p.role === 'mat')
    const m = (FRAME_MAT.width / 100) * 2
    let area = 0
    for (const mat of mats) {
      expect(mat).toMatchObject({ shape: 'plane', color: FRAME_MAT.color })
      close(mat.position.z, 0)
      const [x0, x1, y0, y1] = bounds(mat)
      // never inside the picture: each strip lies wholly beyond one of its edges
      const outside = x1 <= -1.5 + 1e-9 || x0 >= 1.5 - 1e-9 || y1 <= -1 + 1e-9 || y0 >= 1 - 1e-9
      expect(outside).toBe(true)
      // and within the mat band
      expect(Math.max(Math.abs(x0), Math.abs(x1))).toBeLessThanOrEqual(1.5 + m + 1e-9)
      expect(Math.max(Math.abs(y0), Math.abs(y1))).toBeLessThanOrEqual(1 + m + 1e-9)
      area += mat.scale.x * mat.scale.y
    }
    // together they fill the band exactly (no gaps, no overlaps)
    close(area, (3 + 2 * m) * (2 + 2 * m) - 3 * 2)
    close(bounds(parts[2])[1], -(1.5 + m)) // the left bar's inner edge is the mat's edge
    expect(parts.slice(0, 4).every((p) => p.color === '#000000')).toBe(true)
  })

  it('stays small: 4 boxes (12 triangles each), and Gallery\'s 4 mat planes (2 each)', () => {
    for (const style of ['thin', 'classic', 'gallery'] as const) {
      const parts = frameParts(frame({ style }), { x: 2, y: 1, z: 1 })
      const tris = parts.reduce((n, p) => n + (p.shape === 'box' ? 12 : 2), 0)
      expect(tris).toBe(style === 'gallery' ? 56 : 48)
    }
  })

  it('a mirrored or flat-z picture is framed by its size; a zero-size one has no frame', () => {
    const mirrored = frameParts(frame(), { x: -2, y: 1, z: -1 })
    const plain = frameParts(frame(), { x: 2, y: 1, z: 1 })
    expect(mirrored).toEqual(plain)
    expect(frameParts(frame(), { x: 0, y: 1, z: 1 })).toEqual([])
  })
})

describe('framePartTransforms (world placement)', () => {
  it('follows the picture: moved, and rotated about its centre', () => {
    const parts = framePartTransforms(frame({ thickness: 10 }), { position: { x: 5, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 1, z: 1 } })
    const right = parts.find((p) => p.role === 'right')!
    const flat = framePartTransforms(frame({ thickness: 10 }), { position: zero, rotation: zero, scale: { x: 2, y: 1, z: 1 } }).find((p) => p.role === 'right')!
    // unrotated, the right bar sits w/2 + t/2 = 1.05 m along +x (and a little in front, -z)
    close(flat.transform.position.x, 1.05)
    // a quarter turn about y carries that offset onto the z axis, around the picture's centre
    close(right.transform.position.x, 5 + flat.transform.position.z) // left-handed: +z turns to +x
    close(right.transform.position.y, 2)
    close(right.transform.position.z, 3 - 1.05) // and +x to -z
    expect(right.transform.rotation).toEqual({ x: 0, y: 90, z: 0 })
    expect(right.transform.scale).toEqual(flat.transform.scale)
  })
})

describe('framePartTransforms from either side', () => {
  /** A part's centre in the picture's own axes, recovered from its world placement. */
  const localOf = (world: { x: number; y: number; z: number }, t: { position: any; rotation: any }) => {
    const q = eulerDegreesToQuat(t.rotation)
    const d = { x: world.x - t.position.x, y: world.y - t.position.y, z: world.z - t.position.z }
    const axis = (v: { x: number; y: number; z: number }) => rotateVector(q, v)
    const dot = (a: any, b: any) => a.x * b.x + a.y * b.y + a.z * b.z
    return { x: dot(d, axis({ x: 1, y: 0, z: 0 })), y: dot(d, axis({ x: 0, y: 1, z: 0 })), z: dot(d, axis({ x: 0, y: 0, z: 1 })) }
  }
  const placements = [
    // the HUD's Media Library place: in front of the player, turned to face them (yaw + 180)
    { name: 'HUD placement (yaw + 180)', rotation: { x: 0, y: 37 + 180, z: 0 } },
    // a wall snap: turned to face along the wall's normal, tilted a little
    { name: 'wall snap', rotation: { x: -12, y: 90, z: 0 } },
  ]
  for (const { name, rotation } of placements) {
    it(`a Gallery frame on a ${name} keeps the mat in the picture plane and off the picture, with the bars centred on it`, () => {
      const t = { position: { x: 8, y: 1.6, z: 8 }, rotation, scale: { x: 2, y: 1.2, z: 1 } }
      const parts = framePartTransforms(frame({ style: 'gallery', thickness: 4 }), t)
      for (const p of parts) {
        const l = localOf(p.transform.position, t)
        close(l.z, 0) // in the picture plane: nothing between the picture and a viewer on either side
        close(l.x, p.position.x)
        close(l.y, p.position.y)
        expect(p.transform.rotation).toEqual(rotation)
        if (p.role === 'mat') {
          const [x0, x1, y0, y1] = [l.x - p.scale.x / 2, l.x + p.scale.x / 2, l.y - p.scale.y / 2, l.y + p.scale.y / 2]
          expect(x1 <= -1 + 1e-9 || x0 >= 1 - 1e-9 || y1 <= -0.6 + 1e-9 || y0 >= 0.6 - 1e-9).toBe(true)
        }
      }
    })
  }
})

describe('ItemFrame', () => {
  function adapter(withShapes = true) {
    let next = 100
    const live = new Set<number>()
    const a: any = {
      createEntity: vi.fn(() => { const e = next++; live.add(e); return e }),
      destroyEntity: vi.fn((e: number) => live.delete(e)),
      setTransform: vi.fn(),
    }
    if (withShapes) a.setSolidShape = vi.fn()
    return { a, live }
  }
  const at = (scale = { x: 2, y: 1, z: 1 }) => ({ position: zero, rotation: zero, scale })

  it('draws four bars, then only moves them while the frame is the same', () => {
    const { a, live } = adapter()
    const f = new ItemFrame(a)
    f.draw(frame(), at())
    expect(live.size).toBe(4)
    expect(a.setSolidShape).toHaveBeenCalledTimes(4)
    expect(a.setSolidShape).toHaveBeenCalledWith(expect.any(Number), 'box', { r: 0x1c / 255, g: 0x1c / 255, b: 0x1c / 255 })
    const before = [...live]
    f.draw(frame(), at({ x: 4, y: 3, z: 1 }))
    expect([...live]).toEqual(before)
    expect(a.setSolidShape).toHaveBeenCalledTimes(4)
    const lastTop = a.setTransform.mock.calls.filter((c: any[]) => c[0] === before[0]).at(-1)[1]
    close(lastTop.scale.x, 4 + 2 * 0.06)
  })

  it('redraws for a new style or colour, and removes everything for none', () => {
    const { a, live } = adapter()
    const f = new ItemFrame(a)
    f.draw(frame(), at())
    f.draw(frame({ style: 'gallery' }), at())
    expect(live.size).toBe(8)
    f.draw(frame({ style: 'gallery', color: '#ff0000' }), at())
    expect(live.size).toBe(8)
    expect(a.setSolidShape).toHaveBeenLastCalledWith(expect.any(Number), 'plane', expect.anything())
    f.draw(null, at())
    expect(live.size).toBe(0)
    f.draw(frame(), at())
    f.dispose()
    expect(live.size).toBe(0)
  })

  it('draws nothing on a platform without solid shapes', () => {
    const { a, live } = adapter(false)
    const f = new ItemFrame(a)
    f.draw(frame(), at())
    expect(live.size).toBe(0)
    expect(a.createEntity).not.toHaveBeenCalled()
  })

  it('a scale of one is a 1 m picture', () => {
    expect(frameParts(frame({ thickness: 10 }), one)[0].scale.y).toBeCloseTo(0.1)
  })
})
