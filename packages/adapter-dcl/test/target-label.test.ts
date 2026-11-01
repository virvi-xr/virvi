import { describe, it, expect } from 'vitest'
import { resolveTargetLabel, UNNAMED_TARGET, type TargetLookups } from '../src/target-label.js'

const lookups = (o: { names?: Record<number, string>; parents?: Record<number, number>; models?: Record<number, string> }): TargetLookups => ({
  nameOf: (e) => o.names?.[e],
  parentOf: (e) => o.parents?.[e],
  modelSrcOf: (e) => o.models?.[e],
})

describe('resolveTargetLabel', () => {
  it("uses the entity's own Name first", () => {
    expect(resolveTargetLabel(5, lookups({ names: { 5: 'Door', 1: 'Parent' }, parents: { 5: 1 }, models: { 5: 'a/b.glb' } }))).toBe('Door')
  })

  it('walks up to the nearest named ancestor', () => {
    expect(resolveTargetLabel(5, lookups({ names: { 2: 'Bar', 1: 'Station' }, parents: { 5: 4, 4: 3, 3: 2, 2: 1 } }))).toBe('Bar')
  })

  it('falls back to the glTF file name', () => {
    expect(resolveTargetLabel(5, lookups({ models: { 5: 'models/chair.glb' } }))).toBe('chair.glb')
  })

  it('an ancestor name beats the glTF file name', () => {
    expect(resolveTargetLabel(5, lookups({ names: { 1: 'Lounge' }, parents: { 5: 1 }, models: { 5: 'models/chair.glb' } }))).toBe('Lounge')
  })

  it('is the constant label when nothing is known, never entity:<n>', () => {
    expect(resolveTargetLabel(539, lookups({}))).toBe('Unnamed object')
    expect(UNNAMED_TARGET).toBe('Unnamed object')
  })

  it('ignores empty names', () => {
    expect(resolveTargetLabel(5, lookups({ names: { 5: '' }, models: { 5: 'x/y.glb' } }))).toBe('y.glb')
  })

  it('survives parent cycles', () => {
    expect(resolveTargetLabel(1, lookups({ parents: { 1: 2, 2: 1 } }))).toBe('Unnamed object')
  })

  it('gives up after 16 steps up', () => {
    const parents: Record<number, number> = {}
    for (let i = 1; i <= 40; i++) parents[i] = i + 1
    expect(resolveTargetLabel(1, lookups({ parents, names: { 17: 'Far' } }))).toBe('Far')
    expect(resolveTargetLabel(1, lookups({ parents, names: { 18: 'Too far' } }))).toBe('Unnamed object')
  })
})
