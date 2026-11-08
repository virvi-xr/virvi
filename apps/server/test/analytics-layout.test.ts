import { describe, it, expect } from 'vitest'
import { resolveLayout, type LayoutItem } from '../src/analytics/layout.js'

const item = (id: string, parentId: string | null = null, enabled = true): LayoutItem & { enabled: boolean } => ({
  id, parentId, enabled, type: 'model', name: id, src: null, dimensions: null,
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
})

describe('resolveLayout (LIV-85)', () => {
  it('keeps only items whose whole parent chain is present and enabled', () => {
    const out = resolveLayout([item('c', 'b'), item('b', 'a'), item('a', null, false), item('x'), item('y', 'x'), item('z', 'gone')], 100)
    expect(out.map((i) => i.id).sort()).toEqual(['x', 'y'])
    expect(out[0]).not.toHaveProperty('enabled')
  })

  it('survives a parent cycle', () => {
    expect(resolveLayout([item('a', 'b'), item('b', 'a'), item('r')], 100).map((i) => i.id)).toEqual(['r'])
  })

  it('the item cap never keeps a child without its parent', () => {
    // Children listed before parents, as the database may return them.
    const raw = [...Array.from({ length: 5 }, (_, n) => item(`child${n}`, `root${n}`)), ...Array.from({ length: 5 }, (_, n) => item(`root${n}`))]
    const out = resolveLayout(raw, 6)
    expect(out).toHaveLength(6)
    const ids = new Set(out.map((i) => i.id))
    for (const i of out) if (i.parentId) expect(ids.has(i.parentId)).toBe(true)
  })
})
