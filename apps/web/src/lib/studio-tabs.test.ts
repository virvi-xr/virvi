import { describe, expect, it } from 'vitest'
import {
  DESIGN_CHOICES, STUDIO_TABS, choiceBody, choiceKind, designKindLabel, designTabFor, designTabNoun, designTabTitle, filterDesigns,
  visibleStudioTabs, type StudioDesign,
} from './studio'

type D = Pick<StudioDesign, 'kind' | 'sceneShape'> & { id: string }
const designs: D[] = [
  { id: 'w', kind: 'wearable', sceneShape: null },
  { id: 'e', kind: 'emote', sceneShape: null },
  { id: 'b', kind: 'scene', sceneShape: 'building' },
  { id: 'c', kind: 'scene', sceneShape: 'decor' },
  { id: 'old', kind: 'scene' }, // an older server sends no shape: a building, as the server reads it
]
const ids = (ds: D[]) => ds.map((d) => d.id)

describe('filterDesigns', () => {
  it('splits wearables and emotes by kind, buildings and decor by shape', () => {
    expect(ids(filterDesigns(designs, 'wearable'))).toEqual(['w'])
    expect(ids(filterDesigns(designs, 'emote'))).toEqual(['e'])
    expect(ids(filterDesigns(designs, 'building'))).toEqual(['b', 'old'])
    expect(ids(filterDesigns(designs, 'decor'))).toEqual(['c'])
  })
  it('All designs keeps everything', () => {
    expect(ids(filterDesigns(designs, 'all'))).toEqual(ids(designs))
  })
})

describe('the Studio tabs', () => {
  it('reads the tab from ?kind=, anything else is All designs', () => {
    expect(designTabFor('decor')).toBe('decor')
    expect(designTabFor('wearable')).toBe('wearable')
    expect(designTabFor(null)).toBe('all')
    expect(designTabFor('scene')).toBe('all')
    expect(designTabFor('furniture')).toBe('all')
  })
  it('titles and empty-state words', () => {
    expect(['wearable', 'emote', 'building', 'decor', 'all'].map((t) => designTabTitle(t as never))).toEqual(['Wearables', 'Emotes', 'Buildings', 'Decor', 'Design Studio'])
    expect(designTabNoun('decor')).toBe('decor')
    expect(designTabNoun('building')).toBe('buildings')
    expect(designTabNoun('all')).toBe('designs')
  })
  it('lists Scenes first and All designs last; only Scenes where the Design Studio is off', () => {
    expect(STUDIO_TABS.map((t) => t.label)).toEqual(['Scenes', 'Wearables', 'Emotes', 'Buildings', 'Decor', 'All designs'])
    expect(STUDIO_TABS.map((t) => t.href)).toEqual(['/scenes', '/studio?kind=wearable', '/studio?kind=emote', '/studio?kind=building', '/studio?kind=decor', '/studio'])
    expect(visibleStudioTabs(false).map((t) => t.tab)).toEqual(['scenes'])
    expect(visibleStudioTabs(true)).toHaveLength(6)
  })
})

describe('design choices', () => {
  it('offers Wearable, Emote, Building and Decor', () => {
    expect(DESIGN_CHOICES.map(([, l]) => l)).toEqual(['Wearable', 'Emote', 'Building', 'Decor'])
  })
  it('a building or decor creates a scene design with that shape', () => {
    expect(choiceBody('building')).toEqual({ kind: 'scene', sceneShape: 'building' })
    expect(choiceBody('decor')).toEqual({ kind: 'scene', sceneShape: 'decor' })
    expect(choiceBody('wearable')).toEqual({ kind: 'wearable' })
    expect(choiceKind('decor')).toBe('scene')
    expect(choiceKind('emote')).toBe('emote')
  })
  it('names a design by its shape', () => {
    expect(designs.map(designKindLabel)).toEqual(['Wearable', 'Emote', 'Building', 'Decor', 'Building'])
  })
})
