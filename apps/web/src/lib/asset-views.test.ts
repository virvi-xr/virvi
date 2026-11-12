import { describe, it, expect } from 'vitest'
import { readAssetView, assetViewHref, assetListScope, visibilityLabel } from './asset-views'

const sp = (q: string) => new URLSearchParams(q)

describe('asset library views', () => {
  it('reads the view from the link, defaulting to All Models', () => {
    expect(readAssetView(sp(''))).toEqual({ view: 'all', kind: 'all' })
    expect(readAssetView(sp('view=mine'))).toEqual({ view: 'mine', kind: 'all' })
    expect(readAssetView(sp('view=mine&kind=studio'))).toEqual({ view: 'mine', kind: 'studio' })
    expect(readAssetView(sp('view=mine&kind=bogus'))).toEqual({ view: 'mine', kind: 'all' })
    expect(readAssetView(sp('view=bogus&kind=studio'))).toEqual({ view: 'all', kind: 'all' })
    expect(readAssetView(sp('view=community&kind=studio'))).toEqual({ view: 'community', kind: 'all' })
  })
  it('writes a link that keeps the view', () => {
    expect(assetViewHref('all', 'all')).toBe('/assets')
    expect(assetViewHref('mine', 'all')).toBe('/assets?view=mine')
    expect(assetViewHref('mine', 'uploads')).toBe('/assets?view=mine&kind=uploads')
    expect(assetViewHref('all', 'studio')).toBe('/assets')
    expect(assetViewHref('community', 'studio')).toBe('/assets?view=community')
  })
  it('All Models asks for public models only; My Models for the caller\'s own', () => {
    expect(assetListScope('all', 'all')).toEqual({ scope: 'public' })
    expect(assetListScope('mine', 'all')).toEqual({ mine: 'all' })
    expect(assetListScope('mine', 'studio')).toEqual({ mine: 'studio' })
    expect(assetListScope('community', 'all')).toEqual({ scope: 'community' })
  })
  it('labels an asset Public or Private', () => {
    expect(visibilityLabel({ isPublic: true })).toBe('Public')
    expect(visibilityLabel({ isPublic: false })).toBe('Private')
  })
})
