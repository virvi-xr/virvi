import { describe, it, expect } from 'vitest'
import { buildPool, drawWinners, type PoolEntry } from '../src/raffles/draw.js'

const SNAPS = [{ entryIds: ['a', 'b'] }, { entryIds: ['b', 'c'] }, { entryIds: ['c'] }]
const SEED = '00'.repeat(32)
const seedN = (i: number) => i.toString(16).padStart(64, '0')

describe('buildPool', () => {
  it('one_per_person gives each entrant one ticket', () => {
    expect(buildPool('one_per_person', SNAPS, new Set())).toEqual([
      { entryId: 'a', tickets: 1 }, { entryId: 'b', tickets: 1 }, { entryId: 'c', tickets: 1 },
    ])
  })
  it('weighted gives one ticket per snapshot present', () => {
    expect(buildPool('weighted', SNAPS, new Set())).toEqual([
      { entryId: 'a', tickets: 1 }, { entryId: 'b', tickets: 2 }, { entryId: 'c', tickets: 2 },
    ])
  })
  it('exclude removes entries', () => {
    expect(buildPool('weighted', SNAPS, new Set(['b'])).map((e) => e.entryId)).toEqual(['a', 'c'])
  })
  it('sorts by entry id and drops empty pools', () => {
    expect(buildPool('one_per_person', [{ entryIds: ['z', 'm'] }], new Set()).map((e) => e.entryId)).toEqual(['m', 'z'])
    expect(buildPool('one_per_person', [], new Set())).toEqual([])
  })
})

describe('drawWinners', () => {
  const pool: PoolEntry[] = [{ entryId: 'a', tickets: 1 }, { entryId: 'b', tickets: 2 }, { entryId: 'c', tickets: 2 }]
  it('is replayable', () => {
    expect(drawWinners(pool, 3, SEED, 'd1')).toEqual(drawWinners(pool, 3, SEED, 'd1'))
  })
  it('a different draw id changes the first pick', () => {
    const firsts = new Set(['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => drawWinners(pool, 1, SEED, id)[0]))
    expect(firsts.size).toBeGreaterThan(1)
    expect(drawWinners(pool, 1, SEED, 'd1')[0]).not.toBe(drawWinners(pool, 1, SEED, 'd2')[0])
  })
  it('never repeats an id', () => {
    for (let i = 0; i < 50; i++) {
      const w = drawWinners(pool, 2, seedN(i), 'x')
      expect(new Set(w).size).toBe(2)
    }
  })
  it('returns every entry when count exceeds the pool', () => {
    const w = drawWinners([{ entryId: 'a', tickets: 1 }, { entryId: 'b', tickets: 1 }, { entryId: 'c', tickets: 1 }], 5, SEED, 'd1')
    expect([...w].sort()).toEqual(['a', 'b', 'c'])
  })
  it('empty pool gives none', () => {
    expect(drawWinners([], 3, SEED, 'd1')).toEqual([])
  })
  it('does not change the pool it is given', () => {
    const copy = structuredClone(pool)
    drawWinners(pool, 3, SEED, 'd1')
    expect(pool).toEqual(copy)
  })
  it('follows the ticket weights', () => {
    const p: PoolEntry[] = [{ entryId: 'a', tickets: 1 }, { entryId: 'b', tickets: 3 }]
    let b = 0
    for (let i = 0; i < 4000; i++) if (drawWinners(p, 1, seedN(i), 'w')[0] === 'b') b++
    expect(b / 4000).toBeGreaterThan(0.7)
    expect(b / 4000).toBeLessThan(0.8)
  })
  it('known answer (published v1 test vector)', () => {
    const p: PoolEntry[] = [{ entryId: 'a', tickets: 1 }, { entryId: 'b', tickets: 1 }, { entryId: 'c', tickets: 1 }]
    expect(drawWinners(p, 3, SEED, 'd1')).toEqual(['b', 'a', 'c'])
  })
})
