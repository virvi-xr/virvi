import { describe, it, expect, vi } from 'vitest'
import { FRAME_MAT, defaultFrame, type FrameSettings } from '@virvixr/shared'
import { ItemFrame, frameParts, framePartTransforms } from '../src/managers/frame.js'

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

  it('Classic stands further out in front (-z) than Thin', () => {
    const thin = frameParts(frame({ style: 'thin', thickness: 5 }), { x: 2, y: 2, z: 1 })
    const classic = frameParts(frame({ style: 'classic', thickness: 5 }), { x: 2, y: 2, z: 1 })
    const front = (p: (typeof thin)[number]) => bounds(p)[4]
    expect(front(classic[0])).toBeLessThan(front(thin[0]))
    expect(classic[0].scale.z).toBeGreaterThan(thin[0].scale.z)
  })

  it('Gallery puts a mat plane just behind the picture and the bars around the mat', () => {
    const scale = { x: 3, y: 2, z: 1 }
    const parts = frameParts(frame({ style: 'gallery', thickness: 2, color: '#000000' }), scale)
    expect(parts.map((p) => p.role)).toEqual(['top', 'bottom', 'left', 'right', 'mat'])
    const mat = parts[4]
    const m = (FRAME_MAT.width / 100) * 2
    expect(mat).toMatchObject({ shape: 'plane', color: FRAME_MAT.color })
    close(mat.scale.x, 3 + 2 * m)
    close(mat.scale.y, 2 + 2 * m)
    expect(mat.position.z).toBeGreaterThan(0) // behind: the picture's front is -z
    expect(mat.position.z).toBeLessThan(bounds(parts[0])[5]) // and inside the bars' depth, so no gap shows
    close(bounds(parts[2])[1], -(1.5 + m)) // the left bar's inner edge is the mat's edge
    expect(parts.slice(0, 4).every((p) => p.color === '#000000')).toBe(true)
  })

  it('stays within about 50 triangles: 4 boxes (12 each) and at most one plane (2)', () => {
    for (const style of ['thin', 'classic', 'gallery'] as const) {
      const parts = frameParts(frame({ style }), { x: 2, y: 1, z: 1 })
      const tris = parts.reduce((n, p) => n + (p.shape === 'box' ? 12 : 2), 0)
      expect(tris).toBeLessThanOrEqual(50)
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
    expect(live.size).toBe(5)
    f.draw(frame({ style: 'gallery', color: '#ff0000' }), at())
    expect(live.size).toBe(5)
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
