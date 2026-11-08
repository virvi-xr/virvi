import { describe, it, expect } from 'vitest'
import { placeLayout, iconFor } from './layout'
import type { LayoutItem } from './types'

const item = (o: Partial<LayoutItem>): LayoutItem => ({
  id: 'i', parentId: null, type: 'model', name: 'Thing', src: null, dimensions: null,
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, ...o,
})

describe('bird\'s-eye layout', () => {
  it('models get a world matrix and a footprint; other elements an icon at their world position', () => {
    const { models, icons } = placeLayout([
      item({ id: 'stage', name: 'Stage', src: 'https://cdn/x.glb', dimensions: { x: 4, y: 3, z: 2 }, position: { x: 20, y: 0, z: 10 }, rotation: { x: 0, y: 90, z: 0 } }),
      item({ id: 'screen', type: 'video', name: 'Main Screen', parentId: 'stage', position: { x: 0, y: 3, z: 2 } }),
    ])
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: 'stage', name: 'Stage', src: 'https://cdn/x.glb' })
    expect(Math.min(...models[0].footprint.map((p) => p.z))).toBeCloseTo(8)
    expect(icons).toHaveLength(1)
    expect(icons[0]).toMatchObject({ id: 'screen', name: 'Main Screen', type: 'video' })
    expect(icons[0].x).toBeCloseTo(22)
    expect(icons[0].z).toBeCloseTo(10)
    expect(icons[0].y).toBeCloseTo(3)
  })

  it('scale stretches the footprint', () => {
    const { models } = placeLayout([item({ dimensions: { x: 1, y: 1, z: 1 }, scale: { x: 3, y: 1, z: 1 } })])
    const xs = models[0].footprint.map((p) => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3)
  })

  it('every element type has a short icon label', () => {
    for (const t of ['image', 'video', 'nft', 'sound', 'widget', 'custom', 'ad_space', 'other']) {
      expect(iconFor(t).glyph.length).toBeGreaterThan(0)
      expect(iconFor(t).label.length).toBeGreaterThan(0)
    }
    expect(iconFor('video').label).toBe('Screen')
  })
})
