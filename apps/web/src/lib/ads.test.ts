import { describe, it, expect } from 'vitest'
import type { LevelCounts } from '@virvixr/shared'
import { VideoSourceType } from '@virvixr/shared'
import { shapeLabel, isHttpsUrl, clickRate, offImageLabel, adModeHint, contentLabel, reviewBadge, isAdsMode, candidateBadges, adSpaceErrorText, adSpaceRefreshKey } from './ads'

const zero = { scene: 0, screen: 0, look: 0, click: 0 }
const counts = (screen: number, click: number): LevelCounts => ({ ...zero, screen, click, unverified: { ...zero } })

describe('shapeLabel', () => {
  it('names every shape', () => {
    expect(shapeLabel('16:9')).toBe('16:9 landscape')
    expect(shapeLabel('1:1')).toBe('1:1 square')
    expect(shapeLabel('9:16')).toBe('9:16 portrait')
    expect(shapeLabel('2:5')).toBe('2:5 tall')
  })
})

describe('isHttpsUrl', () => {
  it('accepts https urls only', () => {
    expect(isHttpsUrl('https://example.com/a?b=1')).toBe(true)
    expect(isHttpsUrl('http://example.com')).toBe(false)
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpsUrl('example.com')).toBe(false)
    expect(isHttpsUrl('')).toBe(false)
  })
})

describe('clickRate', () => {
  it('is verified clicks over verified screen', () => {
    expect(clickRate(counts(1000, 13))).toBe('1.3%')
    expect(clickRate(counts(4, 1))).toBe('25.0%')
  })
  it('ignores unverified counts', () => {
    const c = counts(100, 5)
    c.unverified = { scene: 9, screen: 900, look: 9, click: 900 }
    expect(clickRate(c)).toBe('5.0%')
  })
  it('is a dash when nobody saw it on screen', () => {
    expect(clickRate(counts(0, 0))).toBe('—')
  })
})

describe('offImageLabel', () => {
  it('offers the off image in image mode and as the fallback in the ads modes', () => {
    expect(offImageLabel(1)).toBe('Off Image URL')
    expect(offImageLabel(4)).toBe('Fallback Image URL (shown when no ad can play)')
    expect(offImageLabel(5)).toBe('Fallback Image URL (shown when no ad can play)')
    expect(offImageLabel(6)).toBe('Holding Image URL (shown between showings)')
    for (const t of [0, 2, 3]) expect(offImageLabel(t)).toBeNull()
  })
})

describe('adModeHint', () => {
  it('describes the ads modes without claiming ads need an admin placement', () => {
    expect(adModeHint(4)).toBe('Shows ads while no stream is live. House ads fill it unless a partner ad is placed on it.')
    expect(adModeHint(5)).toBe('Plays the playlist with an ad after every video. House ads fill it unless a partner ad is placed on it.')
    expect(adModeHint(1)).toBeNull()
  })
})

describe('contentLabel', () => {
  it('words each owner setting', () => {
    expect(contentLabel('family')).toBe('Family-friendly only')
    expect(contentLabel('all')).toBe('Allow all (includes mature ads such as alcohol)')
    expect(contentLabel('approve')).toBe('Approve each ad')
  })
})

describe('reviewBadge', () => {
  const r = (status: 'pending' | 'approved' | 'rejected', audience: 'family' | 'mature' | null = null) =>
    ({ status, audience, reason: null, reviewerKind: null, reviewedAt: null })
  it('words each review state', () => {
    expect(reviewBadge(r('pending'))).toEqual({ text: 'Awaiting review', tone: 'pending' })
    expect(reviewBadge(r('approved', 'family'))).toEqual({ text: 'Approved · Family-friendly', tone: 'ok' })
    expect(reviewBadge(r('approved', 'mature'))).toEqual({ text: 'Approved · Mature', tone: 'ok' })
    expect(reviewBadge(r('rejected'))).toEqual({ text: 'Rejected', tone: 'bad' })
  })
})

describe('isAdsMode', () => {
  it('is true only for the two ads modes', () => {
    expect(isAdsMode(VideoSourceType.ADS)).toBe(true)
    expect(isAdsMode(VideoSourceType.PLAYLIST_ADS)).toBe(true)
    expect(isAdsMode(VideoSourceType.IMAGE)).toBe(false)
  })
})

describe('candidateBadges', () => {
  it('labels house or partner, then the audience when there is one', () => {
    expect(candidateBadges({ house: true, audience: 'family' })).toEqual(['House', 'Family-friendly'])
    expect(candidateBadges({ house: false, audience: 'mature' })).toEqual(['Partner', 'Mature'])
    expect(candidateBadges({ house: false, audience: null })).toEqual(['Partner'])
  })
})

describe('adSpaceErrorText', () => {
  it('maps known codes to sentences and everything else to a generic one', () => {
    expect(adSpaceErrorText({ message: 'not_an_ad_space' })).toBe("This element isn't an ad space.")
    expect(adSpaceErrorText({ message: 'ad_not_a_candidate' })).toBe("That ad can't show in this space any more. Refresh and try again.")
    expect(adSpaceErrorText({ message: 'content_must_be_family_all_or_approve' })).toBe('Choose one of the three settings.')
    expect(adSpaceErrorText({ message: 'boom' })).toBe('Something went wrong. Try again.')
    expect(adSpaceErrorText(undefined)).toBe('Something went wrong. Try again.')
  })
})

describe('adSpaceRefreshKey', () => {
  it('changes with an ad space shape or formats and a screen ad shape or off type', () => {
    expect(adSpaceRefreshKey({ shape: '1:1', formats: 'both' })).not.toBe(adSpaceRefreshKey({ shape: '16:9', formats: 'both' }))
    expect(adSpaceRefreshKey({ shape: '1:1', formats: 'both' })).not.toBe(adSpaceRefreshKey({ shape: '1:1', formats: 'image' }))
    expect(adSpaceRefreshKey({ adShape: '1:1', offType: 4 })).not.toBe(adSpaceRefreshKey({ adShape: '2:5', offType: 4 }))
    expect(adSpaceRefreshKey({ adShape: '1:1', offType: 4 })).not.toBe(adSpaceRefreshKey({ adShape: '1:1', offType: 5 }))
    expect(adSpaceRefreshKey({ shape: '1:1', formats: 'both' })).toBe(adSpaceRefreshKey({ shape: '1:1', formats: 'both' }))
  })
})
