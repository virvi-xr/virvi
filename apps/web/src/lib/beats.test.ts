import { describe, expect, it, vi } from 'vitest'
import { BEAT_IMAGE_MIN_PX, BEAT_MIN_PRESENT_DEFAULT_MINUTES, BEAT_SUPPLY_CAP_DEFAULT, type PublicBeat } from '@virvixr/shared'
import {
  BEAT_FROZEN_NOTE, BEAT_IMAGE_HINT, BEAT_NO_REFUND, BEAT_TEST_BADGE, BEATS_UNAVAILABLE, beatActions, beatBody, beatEditBody, beatFieldError, beatFormError,
  beatHref, beatsNavVisible, blankBeat, claimantRow, claimantWallets, confirmBeatAction, fromLocalInput, newBeatHref, paymentNote, reviewModel,
  toLocalInput, type BeatAvailability, type BeatClaimant,
  BEAT_REFUND_NOTE, beatApiPath, fieldsOfPatch, pollPayment, sceneBeatsPath, shownFieldError, BEATS_NETWORK_UNAVAILABLE, beatsPayable,
} from './beats'

const NOW = new Date('2026-11-14T12:00:00Z')
const HOUR = 3_600_000
const on: BeatAvailability = { enabled: true, chain: 'polygon', test: false, canCreate: true }
const amoy: BeatAvailability = { enabled: true, chain: 'polygon-amoy', test: true, canCreate: true }
const off: BeatAvailability = { enabled: false, chain: 'polygon', test: false, canCreate: false }
const unconfigured: BeatAvailability = { enabled: true, chain: 'polygon', test: false, canCreate: false, reason: 'not_configured' }

function beat(over: Partial<PublicBeat> = {}): PublicBeat {
  return {
    id: 'b1', chain: 'polygon', tokenId: null, name: 'Launch', description: '', imageUrl: 'https://cdn/x.png',
    startsAt: new Date(NOW.getTime() + HOUR).toISOString(), endsAt: new Date(NOW.getTime() + 3 * HOUR).toISOString(),
    minPresentSeconds: 300, supplyCap: 100, tradeable: false, status: 'draft', sceneIds: ['s1'],
    counts: { claimed: 0, minting: 0, minted: 0, failed: 0 }, frozen: false, test: false,
    holdMints: false, mintsReleasedAt: null, mintsHeldUntil: null, scheduledEndsAt: null, heldClaims: 0, artStatus: 'pending', ...over,
  }
}

describe('nav', () => {
  it('is hidden when BEATs are disabled or not yet known', () => {
    expect(beatsNavVisible(off, { trial: false, scenePass: false })).toBe(false)
    expect(beatsNavVisible(null, { trial: false, scenePass: false })).toBe(false)
  })
  it('shows when enabled, but never for a trial or a scene pass', () => {
    expect(beatsNavVisible(on, { trial: false, scenePass: false })).toBe(true)
    expect(beatsNavVisible(on, { trial: true, scenePass: false })).toBe(false)
    expect(beatsNavVisible(on, { trial: false, scenePass: true })).toBe(false)
  })
  it('says BEATs are not available yet', () => {
    expect(BEATS_UNAVAILABLE).toBe("BEATs aren't available yet.")
  })
})

describe('review step', () => {
  const quote = { cents: 600, lines: [{ label: 'Base price, up to 100 tokens', cents: 500 }, { label: '50 more tokens', cents: 100 }], refundableUnclaimed: false as const }
  it('shows 600 cents as $6.00 for cap 150, with the lines and the no-refund sentence', () => {
    const r = reviewModel(quote, { test: false, creditCents: 0 })
    expect(r.total).toBe('$6.00')
    expect(r.lines).toEqual([{ label: 'Base price, up to 100 tokens', amount: '$5.00' }, { label: '50 more tokens', amount: '$1.00' }])
    expect(r.note).toBe("You pay for the cap up front. Unclaimed BEATs aren't refunded.")
    expect(BEAT_NO_REFUND).toBe(r.note)
  })
  it('offers card, and credit only when the balance covers the total', () => {
    expect(reviewModel(quote, { test: false, creditCents: 599 }).buttons).toEqual([{ method: 'card', label: 'Pay with card' }])
    expect(reviewModel(quote, { test: false, creditCents: 600 }).buttons).toEqual([
      { method: 'card', label: 'Pay with card' }, { method: 'credit', label: 'Use credit' },
    ])
  })
  it('on Amoy shows only "Create test BEAT"', () => {
    const free = { cents: 0, lines: [{ label: 'Test BEAT on Polygon Amoy', cents: 0 }], refundableUnclaimed: false as const }
    expect(reviewModel(free, { test: true, creditCents: 10_000 }).buttons).toEqual([{ method: 'test', label: 'Create test BEAT' }])
  })
})

describe('form', () => {
  it('starts with the spec defaults', () => {
    const f = blankBeat(NOW)
    expect(f.minPresentMinutes).toBe(BEAT_MIN_PRESENT_DEFAULT_MINUTES)
    expect(f.supplyCap).toBe(BEAT_SUPPLY_CAP_DEFAULT)
    expect(f.tradeable).toBe(false)
    expect(blankBeat(NOW, 's9').sceneIds).toEqual(['s9'])
  })
  it('says what the artwork must be', () => {
    expect(BEAT_IMAGE_HINT).toBe(`Square, at least ${BEAT_IMAGE_MIN_PX} × ${BEAT_IMAGE_MIN_PX}`)
  })
  it('blocks review until the required fields are filled', () => {
    const ok = { ...blankBeat(NOW, 's1'), name: 'Launch', imageMediaId: 'm1', imageUrl: 'u' }
    expect(beatFormError(ok)).toBeNull()
    expect(beatFormError({ ...ok, name: ' ' })?.field).toBe('name')
    expect(beatFormError({ ...ok, imageMediaId: null })?.field).toBe('image')
    expect(beatFormError({ ...ok, sceneIds: [] })?.field).toBe('scenes')
    expect(beatFormError({ ...ok, supplyCap: 0 })?.field).toBe('cap')
    expect(beatFormError({ ...ok, supplyCap: 5001 })?.field).toBe('cap')
    expect(beatFormError({ ...ok, minPresentMinutes: 121 })?.field).toBe('minutes')
    expect(beatFormError({ ...ok, endsAt: ok.startsAt })?.field).toBe('window')
  })
  it('sends the create body with ISO times', () => {
    const f = { ...blankBeat(NOW, 's1'), name: ' Launch ', imageMediaId: 'm1', imageUrl: 'u', startsAt: '2026-11-15T10:00', endsAt: '2026-11-15T12:00' }
    const b = beatBody(f)
    expect(b).toMatchObject({ name: 'Launch', sceneIds: ['s1'], imageMediaId: 'm1', minPresentMinutes: 5, supplyCap: 100, tradeable: false })
    expect(b.startsAt).toBe(new Date('2026-11-15T10:00').toISOString())
  })
  it('an edit of a paid BEAT leaves out the supply and tradeable', () => {
    const f = { ...blankBeat(NOW, 's1'), name: 'Launch', imageMediaId: 'm1', imageUrl: 'u' }
    expect(beatEditBody(f, 'paid')).not.toHaveProperty('supplyCap')
    expect(beatEditBody(f, 'paid')).not.toHaveProperty('tradeable')
    expect(beatEditBody(f, 'draft')).toHaveProperty('supplyCap', 100)
  })
  it('round-trips local datetime inputs', () => {
    expect(fromLocalInput(toLocalInput('2026-11-15T10:30:00.000Z'))).toBe('2026-11-15T10:30:00.000Z')
  })
  it('has the frozen and test copy', () => {
    expect(BEAT_FROZEN_NOTE).toBe('Name, description and artwork are locked once the first BEAT is minted.')
    expect(BEAT_TEST_BADGE).toBe('Test (Polygon Amoy)')
  })
})

describe('server errors', () => {
  const err = (code: string, message?: string) => Object.assign(new Error(code), { status: 400, body: { error: code, message } })
  it('places each code beside its field', () => {
    expect(beatFieldError(err('bad_name', 'Give the BEAT a name of 1 to 60 characters.'))).toEqual({ field: 'name', message: 'Give the BEAT a name of 1 to 60 characters.' })
    expect(beatFieldError(err('bad_window', 'The BEAT must start in the future.'))).toEqual({ field: 'window', message: 'The BEAT must start in the future.' })
    expect(beatFieldError(err('overlap')).field).toBe('window')
    expect(beatFieldError(err('bad_cap')).field).toBe('cap')
    expect(beatFieldError(err('bad_scenes')).field).toBe('scenes')
    expect(beatFieldError(err('bad_image')).field).toBe('image')
    expect(beatFieldError(err('forbidden')).field).toBe('form')
    expect(beatFieldError(err('locked')).field).toBe('form')
  })
  it('gives a plain message when the server sends none', () => {
    expect(beatFieldError(err('bad_image')).message).toBe('Pick a square image of at least 512 by 512 pixels from your library.')
  })
  it('says something went wrong for an unknown code', () => {
    expect(beatFieldError(err('weird', 'Internal detail'))).toEqual({ field: 'form', message: 'Something went wrong. Try again.' })
    expect(beatFieldError(new Error('Failed to fetch'))).toEqual({ field: 'form', message: 'Something went wrong. Try again.' })
  })
})

describe('claimants', () => {
  const list: BeatClaimant[] = [
    { wallet: '0x1234567890abcdef1234567890abcdef12345678', displayName: '<b>Ana</b>', status: 'minted', claimedAt: null, mintedAt: null, txUrl: 'https://polygonscan.com/tx/0xaa' },
    { wallet: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', displayName: null, status: 'minted', claimedAt: null, mintedAt: null, txUrl: null },
  ]
  it('copies every full wallet, one per line', () => {
    expect(claimantWallets(list)).toBe('0x1234567890abcdef1234567890abcdef12345678\n0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')
  })
  it('shortens the wallet, keeps the name as typed and links the tx only when there is one', () => {
    expect(claimantRow(list[0])).toEqual({ short: '0x1234…5678', wallet: list[0].wallet, name: '<b>Ana</b>', status: 'Minted', txUrl: 'https://polygonscan.com/tx/0xaa' })
    expect(claimantRow(list[1]).txUrl).toBeNull()
    expect(claimantRow(list[1]).name).toBeNull()
  })
})

describe('actions', () => {
  const past = new Date(NOW.getTime() - HOUR).toISOString()
  it('a draft before the start: pay, edit, cancel', () => {
    expect(beatActions(beat({ status: 'draft' }), NOW)).toEqual(['pay', 'edit', 'cancel'])
  })
  it('paid before the start: edit, cancel, raise cap', () => {
    expect(beatActions(beat({ status: 'paid' }), NOW)).toEqual(['edit', 'cancel', 'raise_cap'])
  })
  it('paid but past its start (not yet live): raise cap only', () => {
    expect(beatActions(beat({ status: 'paid', startsAt: past }), NOW)).toEqual(['raise_cap'])
  })
  it('live: raise cap and end early', () => {
    expect(beatActions(beat({ status: 'live', startsAt: past }), NOW)).toEqual(['raise_cap', 'end_early'])
  })
  it('live past its end: end early only', () => {
    expect(beatActions(beat({ status: 'live', startsAt: past, endsAt: new Date(NOW.getTime() - 1000).toISOString() }), NOW)).toEqual(['end_early'])
  })
  it('ended or cancelled: nothing', () => {
    expect(beatActions(beat({ status: 'ended', startsAt: past }), NOW)).toEqual([])
    expect(beatActions(beat({ status: 'cancelled' }), NOW)).toEqual([])
  })
  it('a draft past its start: cancel is gone, edit stays to pick a new time', () => {
    expect(beatActions(beat({ status: 'draft', startsAt: past }), NOW)).toEqual(['edit'])
  })
  it('frozen: no edit', () => {
    expect(beatActions(beat({ status: 'paid', frozen: true }), NOW)).toEqual(['cancel', 'raise_cap'])
  })
  it('asks before cancel and end early only', () => {
    expect(confirmBeatAction('cancel', beat({ status: 'draft' }))).toBe('Cancel this BEAT?')
    expect(confirmBeatAction('end_early')).toMatch(/End this BEAT now\?/)
    expect(confirmBeatAction('edit')).toBeNull()
  })
})

describe('Stripe return', () => {
  const started = NOW.getTime()
  it('says the payment was cancelled', () => {
    expect(paymentNote('cancelled', beat(), null, started, NOW)).toEqual({ text: 'Payment cancelled.', settled: true })
  })
  it('waits for the webhook while the BEAT is still a draft', () => {
    expect(paymentNote('p1', beat({ status: 'draft' }), null, started, NOW)).toEqual({ text: 'Payment received. Confirming it…', settled: false })
    const late = new Date(started + 3 * 60_000)
    expect(paymentNote('p1', beat({ status: 'draft' }), null, started, late)?.text).toMatch(/hasn’t confirmed/)
  })
  it('is settled once paid', () => {
    expect(paymentNote('p1', beat({ status: 'paid' }), null, started, NOW)).toEqual({ text: 'Payment received.', settled: true })
  })
  it('a cap raise waits until the new cap shows', () => {
    expect(paymentNote('p1', beat({ status: 'paid', supplyCap: 100 }), 150, started, NOW)?.settled).toBe(false)
    expect(paymentNote('p1', beat({ status: 'paid', supplyCap: 150 }), 150, started, NOW)?.settled).toBe(true)
  })
  it('nothing to say without a payment', () => {
    expect(paymentNote(null, beat(), null, started, NOW)).toBeNull()
  })
})

describe('links', () => {
  it('follows the scenes pattern for static export', () => {
    expect(beatHref('b1')).toBe('/beats?id=b1')
    expect(newBeatHref('s1')).toBe('/beats/new?scene=s1')
    expect(newBeatHref()).toBe('/beats/new')
  })
})

describe('fix round 1', () => {
  it('a paid BEAT\'s cancel promises a full refund, without naming the card (credit is refunded as credit)', () => {
    expect(BEAT_REFUND_NOTE).toBe("You'll get a full refund.")
    expect(confirmBeatAction('cancel', beat({ status: 'paid' }))).toBe("Cancel this BEAT? You'll get a full refund.")
    expect(confirmBeatAction('cancel', beat({ status: 'paid' }))).not.toMatch(/card/)
    expect(confirmBeatAction('cancel', beat({ status: 'draft' }))).toBe('Cancel this BEAT?')
  })

  it('encodes beat and scene ids in API paths', () => {
    expect(beatApiPath('../admin/x')).toBe('/api/beats/..%2Fadmin%2Fx')
    expect(beatApiPath('../admin/x', 'cancel')).toBe('/api/beats/..%2Fadmin%2Fx/cancel')
    expect(beatApiPath('b1', 'quote')).toBe('/api/beats/b1/quote')
    expect(sceneBeatsPath('s/1?x')).toBe('/api/scenes/s%2F1%3Fx/beats')
  })

  it('keeps polling after a failed reload, and stops once the BEAT shows paid', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP 502'))
      .mockResolvedValueOnce(beat({ status: 'paid' }))
    const seen: PublicBeat[] = []
    await pollPayment({
      load, onBeat: (b) => seen.push(b), settled: (b) => b.status !== 'draft', delayMs: () => 0, wait: async () => {}, stopped: () => false,
    })
    expect(load).toHaveBeenCalledTimes(2)
    expect(seen.map((b) => b.status)).toEqual(['paid'])
  })

  it('stops polling when the page goes away', async () => {
    let stop = false
    const load = vi.fn(async () => { stop = true; return beat({ status: 'draft' }) })
    await pollPayment({ load, onBeat: () => {}, settled: () => false, delayMs: () => 0, wait: async () => {}, stopped: () => stop })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('maps each edited input to its field', () => {
    expect(fieldsOfPatch({ name: 'x' })).toEqual(['name'])
    expect(fieldsOfPatch({ imageMediaId: 'm', imageUrl: 'u' })).toEqual(['image'])
    expect(fieldsOfPatch({ startsAt: 'x' })).toEqual(['window'])
    expect(fieldsOfPatch({ minPresentMinutes: 3 })).toEqual(['minutes', 'window'])
    expect(fieldsOfPatch({ sceneIds: [] })).toEqual(['scenes'])
    expect(fieldsOfPatch({ supplyCap: 3 })).toEqual(['cap'])
  })

  it("clears a field's server error once the host edits that field, and only that field", () => {
    const err = { field: 'name' as const, message: 'Give the BEAT a name of 1 to 60 characters.' }
    expect(shownFieldError(err, new Set())).toEqual(err)
    expect(shownFieldError(err, new Set(['cap']))).toEqual(err)
    expect(shownFieldError(err, new Set(['name']))).toBeNull()
    expect(shownFieldError({ field: 'window', message: 'm' }, new Set(fieldsOfPatch({ minPresentMinutes: 1 })))).toBeNull()
    expect(shownFieldError(null, new Set(['name']))).toBeNull()
  })
})

describe('an unconfigured network (not_configured)', () => {
  const past = new Date(NOW.getTime() - HOUR).toISOString()
  it('keeps the BEATs nav', () => {
    expect(beatsNavVisible(unconfigured, { trial: false, scenePass: false })).toBe(true)
  })
  it('says existing BEATs are safe', () => {
    expect(BEATS_NETWORK_UNAVAILABLE).toBe('BEATs on this network are temporarily unavailable. Existing BEATs are safe.')
  })
  it('is not payable, so the detail offers no Pay or Raise cap', () => {
    expect(beatsPayable(unconfigured)).toBe(false)
    expect(beatsPayable(on)).toBe(true)
    expect(beatActions(beat({ status: 'draft' }), NOW, { payable: false })).toEqual(['edit', 'cancel'])
    expect(beatActions(beat({ status: 'live', startsAt: past }), NOW, { payable: false })).toEqual(['end_early'])
    expect(beatActions(beat({ status: 'paid' }), NOW, { payable: true })).toEqual(['edit', 'cancel', 'raise_cap'])
  })
})
