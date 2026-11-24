import { describe, expect, it } from 'vitest'
import { ClaimPointType, kioskSettings } from '@virvixr/shared'
import { colorToHex, hexToColor, kioskGiveawayNote, kioskGiveawayOptions, kioskItemNote, kioskSaveError, NEW_KIOSK_PROPERTIES } from './kiosk'
import type { GiveawaySummary } from './drops'

const NOW = Date.parse('2026-11-24T12:00:00Z')
const summary = (over: Partial<GiveawaySummary> = {}): GiveawaySummary => ({
  id: 'g1', name: 'Launch party', chain: 'polygon', enabled: true, walletAddress: null, builderUrl: '', startsAt: null, endsAt: null, claimCap: null,
  minPresentSeconds: 300, pausedReason: null, deleteState: null, createdAt: '2026-11-01T00:00:00Z', ...over,
})

describe('kiosk colours', () => {
  it('round-trips a colour through #rrggbb', () => {
    expect(colorToHex({ r: 1, g: 0, b: 0.5, a: 1 })).toBe('#ff0080')
    expect(hexToColor('#FF0080')).toEqual({ r: 1, g: 0, b: 0.502, a: 1 })
    expect(colorToHex(hexToColor('#6b45ed')!)).toBe('#6b45ed')
    expect(hexToColor('red')).toBeNull()
  })
})

describe('kiosk giveaway picker', () => {
  it("lists the host's giveaways with their status, after No giveaway yet", () => {
    expect(kioskGiveawayOptions([summary(), summary({ id: 'g2', name: 'Old', enabled: false })], null, NOW)).toEqual([
      { value: '', label: 'No giveaway yet' },
      { value: 'g1', label: 'Launch party (On)' },
      { value: 'g2', label: 'Old (Off)' },
    ])
  })

  it("keeps a giveaway the viewer can't see, and leaves out ones being deleted", () => {
    const opts = kioskGiveawayOptions([summary({ id: 'g3', deleteState: 'returning' })], 'gX', NOW)
    expect(opts).toEqual([{ value: '', label: 'No giveaway yet' }, { value: 'gX', label: 'Someone else’s giveaway', disabled: true }])
  })

  it('says what to do next', () => {
    expect(kioskGiveawayNote([], { giveawayId: null })).toMatch(/Drops page/)
    expect(kioskGiveawayNote([summary()], { giveawayId: null })).toMatch(/adds this scene/)
    expect(kioskGiveawayNote([summary()], { giveawayId: 'g1' })).toBeNull()
  })
})

describe('kiosk notes and errors', () => {
  it('says what each display still needs', () => {
    expect(kioskItemNote(kioskSettings({ claimPointType: ClaimPointType.CUSTOM_IMAGE }))).toBe('Pick an image to show.')
    expect(kioskItemNote(kioskSettings({ claimPointType: ClaimPointType.MODEL, modelSrc: 'a.glb' }))).toBeNull()
    expect(kioskItemNote(kioskSettings(NEW_KIOSK_PROPERTIES))).toMatch(/pick a giveaway/)
  })

  it('turns refusals into plain lines', () => {
    expect(kioskSaveError({ body: { error: 'not_found', message: 'Giveaway not found.' } })).toBe("That giveaway isn't one of yours.")
    expect(kioskSaveError({ body: { error: 'giveaways_off' } })).toMatch(/switched on/)
    expect(kioskSaveError({ body: { error: 'bad_kiosk', message: 'Keep the hover text to 40 characters.' } })).toBe('Keep the hover text to 40 characters.')
    expect(kioskSaveError(new Error('x'))).toBe('Something went wrong. Try again.')
  })
})
