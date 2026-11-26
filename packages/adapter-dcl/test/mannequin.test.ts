import { describe, it, expect } from 'vitest'
import { BODY_FEMALE, BODY_MALE, mannequinShape } from '../src/mannequin.js'

/** A giveaway kiosk's mannequin as a Decentraland AvatarShape. */
describe('mannequinShape', () => {
  it('a male or female base body wears the giveaway wearables', () => {
    expect(mannequinShape('m', { bodyShape: 'male', wearables: ['urn:hat', 'urn:hat'] }, null))
      .toEqual({ id: 'm', name: '', bodyShape: BODY_MALE, wearables: ['urn:hat'], emotes: [] })
    expect(mannequinShape('m', { bodyShape: 'female', wearables: [] }, null).bodyShape).toBe(BODY_FEMALE)
  })

  it("dressed like the visitor: their body, colours and outfit, the giveaway's wearables put on last", () => {
    const skin = { r: 0.8, g: 0.6, b: 0.5 }
    const s = mannequinShape('m', { bodyShape: 'player', wearables: ['urn:hat'] }, {
      bodyShapeUrn: BODY_FEMALE, wearableUrns: ['urn:hat', 'urn:shirt'], skinColor: skin,
    })
    expect(s).toMatchObject({ bodyShape: BODY_FEMALE, wearables: ['urn:shirt', 'urn:hat'], skinColor: skin })
  })

  it("before the visitor's avatar is known, a base male body", () => {
    expect(mannequinShape('m', { bodyShape: 'player', wearables: ['urn:hat'] }, null)).toMatchObject({ bodyShape: BODY_MALE, wearables: ['urn:hat'] })
  })
})
