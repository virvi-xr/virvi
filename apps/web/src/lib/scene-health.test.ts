import { describe, it, expect } from 'vitest'
import { fill, formatBytes, metricLine, overNote, targetLabel, textureMemoryLine, type BudgetMetric } from './scene-health'

const m = (over: Partial<BudgetMetric>): BudgetMetric => ({ key: 'triangles', used: 12_000, limit: 10_000, state: 'over', blocks: false, ...over })

describe('scene budget wording (LIV-41)', () => {
  it('reads each metric against its limit', () => {
    expect(metricLine(m({}))).toBe('12,000 of 10,000')
    expect(metricLine(m({ key: 'bytes', used: 3 * 1024 * 1024, limit: 15 * 1024 * 1024 }))).toBe('3.0 MB of 15.0 MB')
    expect(metricLine(m({ key: 'bytes', used: 2048, limit: null }))).toBe('2 KB')
    expect(formatBytes(10)).toBe('1 KB')
  })

  it('fills the bar up to 100%', () => {
    expect(fill(m({}))).toBe(100)
    expect(fill(m({ used: 5_000 }))).toBe(50)
    expect(fill(m({ limit: null }))).toBe(0)
  })

  it('says what going over means: a refused deploy, or only a slower scene', () => {
    expect(overNote(m({}))).toBe('It still deploys, but may run slowly for visitors.')
    expect(overNote(m({ key: 'entities', blocks: true }))).toBe("Over this, Decentraland won't take the deploy.")
    expect(overNote(m({ state: 'close' }))).toBeNull()
  })

  it('names where the budget applies', () => {
    expect(targetLabel({ id: 'd', name: 'club.dcl.eth', kind: 'world', parcels: 4, state: 'within', metrics: [] })).toBe('club.dcl.eth (World, 4 parcels)')
    expect(targetLabel({ id: null, name: 'One parcel', kind: 'none', parcels: 1, state: 'within', metrics: [] })).toBe('Not set up to deploy yet: shown for one parcel')
  })

  it('sums texture memory in plain words', () => {
    expect(textureMemoryLine({ bytes: 48 * 1024 * 1024, textures: 3 })).toBe('Textures use about 48.0 MB of graphics memory (3 textures).')
    expect(textureMemoryLine({ bytes: 0, textures: 0 })).toBeNull()
  })
})
