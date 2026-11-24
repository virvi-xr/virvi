import { describe, it, expect } from 'vitest'
import {
  ClaimPointType, KIOSK_DEFAULT_COLORS, KIOSK_HOVER_TEXT_DEFAULT, MannequinType, checkKioskProperties, giveawayItemUrn, kioskItemsOf, kioskSettings,
} from '@virvixr/shared'

const G = '0F0E0D0C-0000-4000-8000-000000000001'

/** Giveaway kiosks (claim_point): what may be saved, and what a runtime reads. */
describe('kioskSettings', () => {
  it('fills in every default for an empty kiosk', () => {
    expect(kioskSettings({})).toEqual({
      giveawayId: null, claimPointType: ClaimPointType.MARKETPLACE_IMAGE, enableKiosk: true, enableSpin: false, imgSrc: null, modelSrc: null,
      mannequinType: MannequinType.MATCH_PLAYER, hoverText: KIOSK_HOVER_TEXT_DEFAULT, ...KIOSK_DEFAULT_COLORS, kioskImgSrc: null,
      itemYOffset: 0, itemScale: 1,
    })
    expect(kioskSettings(null).hoverText).toBe('Claim')
  })

  it('keeps valid settings and holds numbers in range', () => {
    const s = kioskSettings({
      giveawayId: G, claimPointType: 3, mannequinType: 1, enableKiosk: false, enableSpin: true, hoverText: '  Grab it ',
      color1: { r: 2, g: -1, b: 0.5 }, itemYOffset: 99, itemScale: 0.01, imgSrc: ' https://x/a.png ',
    })
    expect(s).toMatchObject({
      giveawayId: G.toLowerCase(), claimPointType: ClaimPointType.MANNEQUIN, mannequinType: MannequinType.FEMALE, enableKiosk: false,
      enableSpin: true, hoverText: 'Grab it', color1: { r: 1, g: 0, b: 0.5, a: 1 }, itemYOffset: 10, itemScale: 0.1, imgSrc: 'https://x/a.png',
    })
  })

  it('ignores unknown display and mannequin types', () => {
    expect(kioskSettings({ claimPointType: 9, mannequinType: 'x' })).toMatchObject({ claimPointType: 0, mannequinType: 2 })
  })
})

describe('checkKioskProperties', () => {
  it('tidies what it keeps and never stores the server-made item list', () => {
    const r = checkKioskProperties({ giveawayId: G, hoverText: ' Claim me ', imgSrc: '', color2: { r: 0, g: 0.5, b: 1 }, giveawayItems: [{ urn: 'x' }], other: 1 })
    expect(r).toEqual({ ok: true, value: { giveawayId: G.toLowerCase(), hoverText: 'Claim me', imgSrc: null, color2: { r: 0, g: 0.5, b: 1, a: 1 }, other: 1 } })
  })

  it('clears a giveaway with null or an empty string', () => {
    expect(checkKioskProperties({ giveawayId: '' })).toEqual({ ok: true, value: { giveawayId: null } })
    expect(checkKioskProperties({ giveawayId: null })).toEqual({ ok: true, value: { giveawayId: null } })
  })

  it.each([
    [{ giveawayId: 'nope' }],
    [{ claimPointType: 7 }],
    [{ mannequinType: -1 }],
    [{ enableKiosk: 'yes' }],
    [{ enableSpin: 1 }],
    [{ hoverText: 'x'.repeat(41) }],
    [{ color1: { r: 1, g: 1 } }],
    [{ color3: { r: 1, g: 1, b: 2 } }],
    [{ itemYOffset: 11 }],
    [{ itemScale: 0 }],
    [{ imgSrc: 5 }],
    ['not an object'],
  ])('refuses %j', (props) => {
    expect(checkKioskProperties(props).ok).toBe(false)
  })
})

describe('kiosk items and URNs', () => {
  it('reads the server-made items, tolerating junk', () => {
    expect(kioskItemsOf({ giveawayItems: [{ name: 'Hat', thumbnail: 'https://t/h.png', urn: 'urn:a' }, 5, { name: 3 }] }))
      .toEqual([{ name: 'Hat', thumbnail: 'https://t/h.png', urn: 'urn:a' }, { name: null, thumbnail: null, urn: null }])
    expect(kioskItemsOf({})).toEqual([])
  })

  it('names collection items on Polygon and Amoy', () => {
    expect(giveawayItemUrn('polygon', '0xABCDEF', '3')).toBe('urn:decentraland:matic:collections-v2:0xabcdef:3')
    expect(giveawayItemUrn('polygon-amoy', '0xAB', '0')).toBe('urn:decentraland:amoy:collections-v2:0xab:0')
  })
})
