import { describe, it, expect } from 'vitest'
import { ClaimPointType, MannequinType, kioskSettings } from '@virvixr/shared'
import { BOOTH, kioskParts, partLookKey, placePart } from '../src/kiosk/layout.js'

/** Giveaway kiosks: what each one is drawn from. */
const ITEMS = [
  { name: 'Hat', thumbnail: null, urn: 'urn:decentraland:matic:collections-v2:0xc1:2' },
  { name: 'Cape', thumbnail: 'https://peer.example/cape.png', urn: 'urn:decentraland:matic:collections-v2:0xc1:10' },
]
const roles = (props: Record<string, unknown>, items = ITEMS) => kioskParts(kioskSettings(props), items).map((p) => p.role)
const at = { position: { x: 8, y: 0, z: 8 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9

describe('kioskParts', () => {
  it('a booth has a roof sign, two posts, a panel, a counter, a Claim button with its label, and the item', () => {
    expect(roles({})).toEqual(['post_left', 'post_right', 'roof', 'panel', 'counter', 'button', 'label', 'item'])
    const parts = kioskParts(kioskSettings({ hoverText: 'Get yours', color1: { r: 1, g: 0, b: 0 }, color2: { r: 0, g: 1, b: 0 }, color3: { r: 0, g: 0, b: 1 } }), ITEMS)
    const by = Object.fromEntries(parts.map((p) => [p.role, p]))
    expect(by.roof).toMatchObject({ kind: 'box', color: { r: 1, g: 0, b: 0, a: 1 } })
    expect(by.post_left).toMatchObject({ kind: 'box', color: { r: 1, g: 0, b: 0, a: 1 } })
    expect(by.panel).toMatchObject({ kind: 'box', color: { r: 0, g: 1, b: 0, a: 1 } })
    expect(by.counter).toMatchObject({ kind: 'box', color: { r: 0, g: 0, b: 1, a: 1 } })
    expect(by.label).toMatchObject({ kind: 'text', text: 'Get yours' })
    // The button and label sit on the counter's front, towards the visitors (-z)
    expect(by.button.transform.position.z).toBeLessThan(by.counter.transform.position.z)
    expect(by.label.transform.position.z).toBeLessThan(by.button.transform.position.z)
    expect(by.roof.transform.position.y).toBeGreaterThan(BOOTH.height)
    expect(parts.filter((p) => p.click).map((p) => p.role)).toEqual(['panel', 'counter', 'button', 'item'])
  })

  it('adds the booth image as a banner on the roof sign', () => {
    const parts = kioskParts(kioskSettings({ kioskImgSrc: 'https://cdn/banner.png' }), ITEMS)
    const banner = parts.find((p) => p.role === 'banner')!
    const roof = parts.find((p) => p.role === 'roof')!
    expect(banner).toMatchObject({ kind: 'image', src: 'https://cdn/banner.png' })
    expect(banner.transform.position.y).toBe(roof.transform.position.y)
    expect(banner.transform.position.z).toBeLessThan(roof.transform.position.z - roof.transform.scale.z / 2)
  })

  it('without the booth the item stands on its own', () => {
    expect(roles({ enableKiosk: false })).toEqual(['item'])
  })

  it("shows the giveaway's first marketplace image, the host's image or model, or nothing when there is none", () => {
    const item = (props: Record<string, unknown>, items = ITEMS) => kioskParts(kioskSettings({ enableKiosk: false, ...props }), items)[0]
    expect(item({ claimPointType: ClaimPointType.MARKETPLACE_IMAGE })).toMatchObject({ kind: 'image', src: 'https://peer.example/cape.png' })
    expect(item({ claimPointType: ClaimPointType.MARKETPLACE_IMAGE }, [])).toBeUndefined()
    expect(item({ claimPointType: ClaimPointType.CUSTOM_IMAGE, imgSrc: 'https://cdn/mine.png' })).toMatchObject({ kind: 'image', src: 'https://cdn/mine.png' })
    expect(item({ claimPointType: ClaimPointType.CUSTOM_IMAGE })).toBeUndefined()
    expect(item({ claimPointType: ClaimPointType.MODEL, modelSrc: 'models/prize.glb' })).toMatchObject({ kind: 'model', src: 'models/prize.glb', click: true })
  })

  it('a mannequin wears the giveaway wearables, faces the visitors and has a box to click', () => {
    for (const [type, bodyShape] of [[MannequinType.MALE, 'male'], [MannequinType.FEMALE, 'female'], [MannequinType.MATCH_PLAYER, 'player']] as const) {
      const parts = kioskParts(kioskSettings({ enableKiosk: false, claimPointType: ClaimPointType.MANNEQUIN, mannequinType: type }), ITEMS)
      expect(parts.map((p) => p.role)).toEqual(['item', 'hit'])
      expect(parts[0]).toMatchObject({ kind: 'mannequin', bodyShape, wearables: ITEMS.map((i) => i.urn), click: false })
      expect(parts[0].transform.rotation.y).toBe(180)
      expect(parts[1]).toMatchObject({ kind: 'hit', click: true })
    }
  })

  it('the height offset and scale move and size the item', () => {
    const item = (props: Record<string, unknown>) => kioskParts(kioskSettings({ enableKiosk: false, claimPointType: 1, imgSrc: 'a.png', ...props }), [])[0]
    expect(item({ itemYOffset: 0.5 }).transform.position.y).toBeCloseTo(item({}).transform.position.y + 0.5)
    expect(item({ itemScale: 2 }).transform.scale).toEqual({ x: 2, y: 2, z: 0.01 })
  })

  it('only the item spins', () => {
    expect(kioskParts(kioskSettings({}), ITEMS).filter((p) => p.spins).map((p) => p.role)).toEqual(['item'])
  })

  it('a look key ignores where the part is', () => {
    const [a] = kioskParts(kioskSettings({ enableKiosk: false, itemYOffset: 0 }), ITEMS)
    const [b] = kioskParts(kioskSettings({ enableKiosk: false, itemYOffset: 2 }), ITEMS)
    expect(partLookKey(a)).toBe(partLookKey(b))
  })
})

describe('placePart', () => {
  const counter = kioskParts(kioskSettings({}), ITEMS).find((p) => p.role === 'counter')!

  it('moves kiosk space to the instance', () => {
    const t = placePart(counter, at)
    expect(t.position).toEqual({ x: 8 + counter.transform.position.x, y: counter.transform.position.y, z: 8 + counter.transform.position.z })
    expect(t.rotation).toEqual({ x: 0, y: 0, z: 0 })
    expect(t.scale).toEqual(counter.transform.scale)
  })

  it('turns with the instance: a booth turned 180° faces +z', () => {
    const t = placePart(counter, { ...at, rotation: { x: 0, y: 180, z: 0 } })
    expect(close(t.position.z, 8 - counter.transform.position.z)).toBe(true)
    expect(t.rotation).toEqual({ x: 0, y: 180, z: 0 })
  })

  it('scales kiosk space with the instance', () => {
    const t = placePart(counter, { ...at, scale: { x: 2, y: 2, z: 2 } })
    expect(t.position.y).toBeCloseTo(counter.transform.position.y * 2)
    expect(t.scale.x).toBeCloseTo(counter.transform.scale.x * 2)
  })

  it('a spinning item turns about its up axis', () => {
    const item = kioskParts(kioskSettings({ enableKiosk: false }), ITEMS)[0]
    expect(placePart(item, at, 90).rotation.y).toBeCloseTo(90)
    expect(placePart(counter, at, 90).rotation).toEqual({ x: 0, y: 0, z: 0 })
  })
})
