import { describe, expect, it } from 'vitest'
import type { Plot } from '@virvixr/shared'
import type { WizardAsset } from '../api'
import { budgetStatus, fitToBudget } from './budget'
import type { PlacedItem } from './placement'

const plot: Plot = { width: 1, depth: 1, base: { x: 0, y: 0 } }
const asset = (id: string, tris: number | null, bytes = 1000): WizardAsset => ({
  id, name: id, thumbnailUrl: null, cdnUrl: null, dimensions: null, triangleCount: tris, fileSizeBytes: bytes,
})
const item = (a: WizardAsset, i: number): PlacedItem => ({ key: `k${i}`, asset: a, x: 1, z: 1, rotationY: 0 })

describe('budgetStatus', () => {
  it('counts a duplicated asset bytes once', () => {
    const a = asset('a', 100, 5000)
    const s = budgetStatus([item(a, 0), item(a, 1)], plot, { maxAllowedBytes: 100_000, usedBytes: 20_000 })
    expect(s.bytes).toEqual({ used: 5000, remaining: 75_000 })
    expect(s.triangles).toEqual({ used: 200, limit: 10_000 })
    expect(s.entities.limit).toBe(180)
    expect(s.over).toBeNull()
  })
  it('warns about a triangle overage in plain words, without stopping anything', () => {
    const a = asset('a', 4350)
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => item(a, i))
    const s = budgetStatus(items, { ...plot, width: 4 }, null)
    expect(s.over).toBeNull()
    expect(s.warning).toBe('This scene has 43,500 triangles, more than the 40,000 Decentraland recommends for this plot. It still deploys, but it may run slowly for visitors.')
    expect(budgetStatus(items.slice(0, 9), { ...plot, width: 4 }, null).warning).toBeNull()
  })
  it('has no limits without a plot', () => {
    const s = budgetStatus([item(asset('a', 99999999), 0)], null, null)
    expect(s.triangles.limit).toBeNull()
    expect(s.over).toBeNull()
    expect(s.warning).toBeNull()
  })
  it('flags storage overage', () => {
    const s = budgetStatus([item(asset('a', 1, 5_000_000), 0)], plot, { maxAllowedBytes: 6_000_000, usedBytes: 4_000_000 })
    expect(s.over).toMatch(/storage/)
  })
  it('treats missing triangle counts as zero', () => {
    expect(budgetStatus([item(asset('a', null), 0)], plot, null).triangles.used).toBe(0)
  })
})

describe('fitToBudget', () => {
  it('drops from the end for the item limit only, never for triangles', () => {
    const heavy = Array.from({ length: 12 }, (_, i) => item(asset('a', 1500), i))
    expect(fitToBudget(heavy, plot)).toEqual({ items: heavy, dropped: 0 })
    const r = fitToBudget(Array.from({ length: 182 }, (_, i) => item(asset('t', 1), i)), plot)
    expect(r.items.map((i) => i.key).slice(-1)).toEqual(['k179'])
    expect(r.dropped).toBe(2)
  })
})

describe('a room set', () => {
  it('counts the room as one more item and its triangles', () => {
    const items = Array.from({ length: 180 }, (_, i) => item(asset('a', 1), i))
    expect(budgetStatus(items, plot, null).over).toBeNull()
    const s = budgetStatus(items, plot, null, { triangles: 500 })
    expect(s.entities).toEqual({ used: 181, limit: 180 })
    expect(s.triangles.used).toBe(680)
    expect(s.over).toBe('This plot fits about 180 items; that would make it 181')
  })
  it('a room with no count yet still takes an entity', () => {
    expect(budgetStatus([], plot, null, { triangles: null }).entities.used).toBe(1)
  })
  it('fitToBudget leaves room for the set', () => {
    const a = asset('a', 1500)
    const items = Array.from({ length: 12 }, (_, i) => item(a, i))
    expect(fitToBudget(items, plot, { triangles: 3000 }).items).toHaveLength(12)
    const tiny = Array.from({ length: 180 }, (_, i) => item(asset('t', 1), i))
    expect(fitToBudget(tiny, plot, { triangles: null }).items).toHaveLength(179)
  })
})
