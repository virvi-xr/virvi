import { describe, it, expect } from 'vitest'
import { filterCollection, itemSubtitle, kindCounts, type CollectionItem } from './collection'

const item = (over: Partial<CollectionItem>): CollectionItem => ({
  id: Math.random().toString(), kind: 'wearable', name: 'Hat', image: null, rarity: 'common', slot: 'hat', network: 'MATIC',
  contractAddress: '0x1', tokenId: '1', wallet: '0xa', url: 'https://decentraland.org/marketplace/x', ...over,
})

describe('collection page (LIV-160)', () => {
  const items = [
    item({ name: 'Cap', rarity: 'common' }),
    item({ name: 'Crown', rarity: 'legendary', wallet: '0xb' }),
    item({ name: 'Wave', kind: 'emote', slot: 'dance', rarity: 'rare' }),
    item({ name: 'sam.dcl.eth', kind: 'ens', slot: null, rarity: null }),
    item({ name: 'Golden State', kind: 'estate', slot: null, rarity: null }),
  ]
  it('filters by kind, wallet and name, rarest first', () => {
    expect(filterCollection(items, { kind: 'wearable', wallet: 'all', query: '' }).map((i) => i.name)).toEqual(['Crown', 'Cap'])
    expect(filterCollection(items, { kind: 'land', wallet: 'all', query: '' }).map((i) => i.name)).toEqual(['Golden State'])
    expect(filterCollection(items, { kind: 'all', wallet: '0xb', query: '' }).map((i) => i.name)).toEqual(['Crown'])
    expect(filterCollection(items, { kind: 'all', wallet: 'all', query: 'SAM' }).map((i) => i.name)).toEqual(['sam.dcl.eth'])
  })
  it('counts each kind for the filter labels', () => {
    expect(kindCounts(items)).toEqual({ all: 5, wearable: 2, emote: 1, ens: 1, land: 1 })
  })
  it('describes an item in plain words', () => {
    expect(itemSubtitle(item({ slot: 'upper_body', rarity: 'epic' }))).toBe('Upper body, Epic')
    expect(itemSubtitle(item({ kind: 'ens', slot: null, rarity: null }))).toBe('Name')
  })
})
