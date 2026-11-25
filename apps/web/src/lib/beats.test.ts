import { describe, expect, it, vi } from 'vitest'
import type { CollectedBeat } from '@virvixr/shared'
import { BEAT_IMAGE_MIN_PX, BEAT_MIN_PRESENT_DEFAULT_MINUTES, BEAT_SUPPLY_CAP_DEFAULT, type PublicBeat } from '@virvixr/shared'
import { walletLookupHref, beatsExplainerFor, beatToInput,
  BEAT_FROZEN_NOTE, BEAT_IMAGE_HINT, BEAT_NO_REFUND, BEAT_TEST_BADGE, BEATS_UNAVAILABLE, beatActions, beatWindow, formatWhen, beatBody, beatEditBody, beatFieldError, beatFormError,
  beatHref, beatsNavVisible, blankBeat, claimantRow, claimantWallets, confirmBeatAction, fromLocalInput, newBeatHref, paymentNote, reviewModel,
  toLocalInput, type BeatAvailability, type BeatClaimant,
  BEAT_REFUND_NOTE, beatApiPath, fieldsOfPatch, pollPayment, sceneBeatsPath, shownFieldError, BEATS_NETWORK_UNAVAILABLE, beatsPayable,
  TRADEABLE_HINT, SUPPLY_HINT, PAID_SUPPLY_HINT, LOCATION_SCENE_ONLY, blankLocation, cancelledNote, claimantsHeading, locationBody, locationLine,
  reviewSummary, beatLocked, COUNT_LABELS, CLAIM_STATUS_LABELS, claimantHeld,
  filterCollected, shortWallet, walletPageHref, walletFromPath, type CollectedFilter,
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
    holdMints: false, autoClaim: true, mintsReleasedAt: null, mintsHeldUntil: null, scheduledEndsAt: null, heldClaims: 0, artStatus: 'pending', retired: false,
    location: { type: 'scene', label: 'A', platform: null, url: null, venue: null, city: null, country: null, address: null, mapUrl: null }, ...over,
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
  const quote = { cents: 600, lines: [{ label: 'Up to 100 BEATs', cents: 500 }, { label: '50 more BEATs', cents: 100 }], refundableUnclaimed: false as const }
  it('shows 600 cents as $6.00 for cap 150, with the lines and the no-refund sentence', () => {
    const r = reviewModel(quote, { test: false, creditCents: 0 })
    expect(r.total).toBe('$6.00')
    expect(r.lines).toEqual([{ label: 'Up to 100 BEATs', amount: '$5.00' }, { label: '50 more BEATs', amount: '$1.00' }])
    expect(r.note).toBe("You pay for the cap up front. Unclaimed BEATs aren't refunded.")
    expect(BEAT_NO_REFUND).toBe(r.note)
  })
  it('offers card, and credit only when the balance covers the total (saying the credit when it is short)', () => {
    expect(reviewModel(quote, { test: false, creditCents: 599 }).buttons).toEqual([{ method: 'card', label: 'Pay with card' }])
    expect(reviewModel(quote, { test: false, creditCents: 300 }).credit).toBe('Your Virvi credit: $3.00, not enough for this BEAT.')
    expect(reviewModel(quote, { test: false, creditCents: 0 }).credit).toBeNull()
    expect(reviewModel(quote, { test: false, creditCents: 600 }).buttons).toEqual([
      { method: 'card', label: 'Pay with card' }, { method: 'credit', label: 'Use credit' },
    ])
  })
  it('on Amoy shows only "Create test BEAT"', () => {
    const free = { cents: 0, lines: [{ label: 'Test BEAT (free, practice network)', cents: 0 }], refundableUnclaimed: false as const }
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
    expect(beatFormError({ ...ok, minPresentMinutes: Number.NaN })?.field).toBe('minutes')
  })
  it('the location: online needs a platform and an https link; in person a venue, city and country', () => {
    const ok = { ...blankBeat(NOW, 's1'), name: 'Launch', imageMediaId: 'm1', imageUrl: 'u' }
    const online = { ...blankLocation(), type: 'online' as const, platform: 'Zoom', url: 'https://zoom.us/j/1' }
    expect(beatFormError({ ...ok, location: online })).toBeNull()
    expect(beatFormError({ ...ok, location: { ...online, url: 'javascript:alert(1)' } })).toEqual({ field: 'location', message: 'The event link must be a web address starting with https://.' })
    expect(beatFormError({ ...ok, location: { ...online, platform: ' ' } })?.message).toBe('Add the platform name.')
    const hall = { ...blankLocation(), type: 'in_person' as const, venue: 'Hall', city: 'Lisbon', country: 'Portugal' }
    expect(beatFormError({ ...ok, location: hall })).toBeNull()
    expect(beatFormError({ ...ok, location: { ...hall, country: '' } })?.message).toBe('Add the country.')
    expect(beatFormError({ ...ok, location: { ...hall, mapUrl: 'ftp://x' } })?.field).toBe('location')
    expect(locationBody({ ...hall, platform: 'stray', address: ' ' })).toEqual({ type: 'in_person', venue: 'Hall', city: 'Lisbon', country: 'Portugal' })
    expect(locationBody({ ...online, venue: 'stray' })).toEqual({ type: 'online', platform: 'Zoom', url: 'https://zoom.us/j/1' })
    expect(locationBody(blankLocation())).toEqual({ type: 'scene' })
  })
  it('the location as a line, and the claim-in-Virvi note', () => {
    expect(locationLine(beat().location)).toBe('In Virvi: A')
    expect(locationLine({ ...beat().location, type: 'online', platform: 'Zoom' })).toBe('Online, on Zoom')
    expect(locationLine({ ...beat().location, type: 'in_person', venue: 'Hall', address: '1 Main St', city: 'Lisbon', country: 'Portugal' })).toBe('Hall, 1 Main St, Lisbon, Portugal')
    expect(LOCATION_SCENE_ONLY).toBe('People claim this BEAT in your Virvi scene. Ways to claim in person or on other platforms are coming.')
  })
  it('plain-ux I4: says what is permanent, and the review sums it up', () => {
    expect(TRADEABLE_HINT).toBe("Holders can send it to other wallets. You can't change this once the BEAT starts.")
    expect(SUPPLY_HINT).toBe('The most BEATs that can be claimed. You pay for this many up front. You can raise it later, never lower it.')
    expect(PAID_SUPPLY_HINT).toBe("The supply can't be changed after paying. To allow more BEATs, use Raise cap.")
    expect(reviewSummary(beat({ supplyCap: 500, sceneIds: ['a', 'b', 'c'] }))).toMatch(/^Supply cap 500 · Tradeable: No · 3 scenes · Starts /)
    expect(reviewSummary(beat({ holdMints: true }))).toMatch(/ · You check claims before they are sent$/)
  })
  it('sends the create body with ISO times', () => {
    const f = { ...blankBeat(NOW, 's1'), name: ' Launch ', imageMediaId: 'm1', imageUrl: 'u', startsAt: '2026-11-15T10:00', endsAt: '2026-11-15T12:00' }
    const b = beatBody(f)
    expect(b).toMatchObject({ name: 'Launch', sceneIds: ['s1'], imageMediaId: 'm1', minPresentMinutes: 5, supplyCap: 100, tradeable: false, holdMints: false, location: { type: 'scene' } })
    expect(b.startsAt).toBe(new Date('2026-11-15T10:00').toISOString())
  })
  it('an edit of a paid BEAT leaves out the supply; Tradeable and hold still change until the start', () => {
    const f = { ...blankBeat(NOW, 's1'), name: 'Launch', imageMediaId: 'm1', imageUrl: 'u', tradeable: true, holdMints: true }
    expect(beatEditBody(f, 'paid')).not.toHaveProperty('supplyCap')
    expect(beatEditBody(f, 'paid')).toMatchObject({ tradeable: true, holdMints: true })
    expect(beatEditBody(f, 'draft')).toHaveProperty('supplyCap', 100)
  })
  it('LIV-180: Claim automatically is on by default, sent on create and edit, and read back from the BEAT', () => {
    const f = { ...blankBeat(NOW, 's1'), name: 'Launch', imageMediaId: 'm1', imageUrl: 'u' }
    expect(f.autoClaim).toBe(true)
    expect(beatBody(f)).toMatchObject({ autoClaim: true })
    expect(beatEditBody({ ...f, autoClaim: false }, 'paid')).toMatchObject({ autoClaim: false })
    expect(beatToInput(beat({ autoClaim: false })).autoClaim).toBe(false)
  })
  it('round-trips local datetime inputs', () => {
    expect(fromLocalInput(toLocalInput('2026-11-15T10:30:00.000Z'))).toBe('2026-11-15T10:30:00.000Z')
  })
  it('has the locked and test copy; the locked note shows once the BEAT has started', () => {
    expect(BEAT_FROZEN_NOTE).toMatch(/^This BEAT has started, so its name, description, Tradeable setting, location and times are locked/)
    expect(BEAT_TEST_BADGE).toBe('Test BEAT (practice network)')
    expect(beatLocked(beat({ status: 'live' }))).toBe(true)
    expect(beatLocked(beat({ status: 'paid' }))).toBe(false)
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
  it('places the new codes: description, location, the card minimum and host review', () => {
    expect(beatFieldError(err('bad_description')).field).toBe('description')
    expect(beatFieldError(err('bad_location')).field).toBe('location')
    expect(beatFieldError(err('below_minimum'))).toEqual({ field: 'pay', message: 'Card payments start at $0.50. Add more BEATs, or pay with credit.' })
    for (const code of ['not_held', 'not_removable', 'not_live', 'not_configured']) expect(beatFieldError(err(code)).message).not.toBe('Something went wrong. Try again.')
  })
  it('says something went wrong for an unknown code', () => {
    expect(beatFieldError(err('weird', 'Internal detail'))).toEqual({ field: 'form', message: 'Something went wrong. Try again.' })
    expect(beatFieldError(new TypeError('Failed to fetch'))).toEqual({ field: 'form', message: "Couldn't reach Virvi. Check your connection and try again." })
  })
})

describe('claimants', () => {
  const list: BeatClaimant[] = [
    { id: 'c1', wallet: '0x1234567890abcdef1234567890abcdef12345678', displayName: '<b>Ana</b>', status: 'minted', claimedAt: null, mintedAt: null, txUrl: 'https://polygonscan.com/tx/0xaa', reissued: false, reissueTxUrl: null },
    { id: 'c2', wallet: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', displayName: null, status: 'minted', claimedAt: null, mintedAt: null, txUrl: null, reissued: true, reissueTxUrl: null },
    { id: 'c3', wallet: '0x9999999999999999999999999999999999999999', displayName: 'Cy', status: 'present', claimedAt: null, mintedAt: null, txUrl: null, reissued: false, reissueTxUrl: null },
  ]
  it('plain-ux I3: copies only the wallets that claimed, one per line, and the heading counts both', () => {
    expect(claimantWallets(list)).toBe('0x1234567890abcdef1234567890abcdef12345678\n0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')
    expect(claimantsHeading(list)).toBe('Attendees (3): 2 claimed, 1 still attending')
  })
  it('M8: plain words for the counts and statuses', () => {
    expect(COUNT_LABELS).toEqual({ claimed: 'Claimed (waiting to send)', minting: 'Sending', minted: 'Delivered', failed: 'Failed', cap: 'Cap' })
    expect(CLAIM_STATUS_LABELS.minted).toBe('Delivered')
    expect(CLAIM_STATUS_LABELS.removed).toBe('Removed by you')
  })
  it('a held claim is one claimed after the last Send while hold is on', () => {
    const c = { status: 'claimed', claimedAt: '2026-11-14T12:00:00Z' }
    expect(claimantHeld(c, { mintsHeldUntil: 'x', mintsReleasedAt: null })).toBe(true)
    expect(claimantHeld(c, { mintsHeldUntil: 'x', mintsReleasedAt: '2026-11-14T13:00:00Z' })).toBe(false)
    expect(claimantHeld(c, { mintsHeldUntil: 'x', mintsReleasedAt: '2026-11-14T11:00:00Z' })).toBe(true)
    expect(claimantHeld(c, { mintsHeldUntil: null, mintsReleasedAt: null })).toBe(false)
  })
  it('shortens the wallet, keeps the name as typed and links the tx only when there is one', () => {
    expect(claimantRow(list[0])).toEqual({ short: '0x1234…5678', wallet: list[0].wallet, name: '<b>Ana</b>', status: 'Delivered', txUrl: 'https://polygonscan.com/tx/0xaa', held: false, reissued: false, reissueTxUrl: null })
    expect(claimantRow(list[1]).reissued).toBe(true)
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
    // On an earlier contract: nothing more is sent, so no paying for more (or changing the art); ending it is all
    expect(beatActions(beat({ status: 'live', startsAt: past, retired: true, artStatus: 'failed', heldClaims: 2, holdMints: true, mintsHeldUntil: past }), NOW)).toEqual(['end_early'])
  })
  it('live past its end: end early only', () => {
    expect(beatActions(beat({ status: 'live', startsAt: past, endsAt: new Date(NOW.getTime() - 1000).toISOString() }), NOW)).toEqual(['end_early'])
  })
  it('ended or cancelled: nothing', () => {
    expect(beatActions(beat({ status: 'ended', startsAt: past }), NOW)).toEqual([])
    expect(beatActions(beat({ status: 'cancelled' }), NOW)).toEqual([])
  })
  it('plain-ux M13: a draft past its start keeps edit (to pick a new time) and cancel (delete)', () => {
    expect(beatActions(beat({ status: 'draft', startsAt: past }), NOW)).toEqual(['edit', 'cancel'])
  })
  it('host review: Send while claims are held, once it has started', () => {
    const held = { holdMints: true, mintsHeldUntil: new Date(NOW.getTime() + 30 * HOUR).toISOString(), heldClaims: 2 }
    expect(beatActions(beat({ status: 'live', startsAt: past, ...held }), NOW)).toEqual(['send', 'raise_cap', 'end_early'])
    expect(beatActions(beat({ status: 'live', startsAt: past, ...held, heldClaims: 0 }), NOW)).toEqual(['raise_cap', 'end_early'])
    expect(confirmBeatAction('send', beat({ heldClaims: 2 }))).toBe("Send the 2 BEATs claimed so far? They go to the visitors' wallets and can't be taken back. Claims made after this wait for another Send.")
  })
  it('fix round I-3: failed art can be replaced after the start (Change image)', () => {
    expect(beatActions(beat({ status: 'live', startsAt: past, artStatus: 'failed' }), NOW)).toEqual(['change_image', 'raise_cap', 'end_early'])
  })
  it('frozen: no edit', () => {
    expect(beatActions(beat({ status: 'paid', frozen: true }), NOW)).toEqual(['cancel', 'raise_cap'])
  })
  it('asks before cancel and end early only', () => {
    expect(confirmBeatAction('cancel', beat({ status: 'draft' }))).toBe('Delete this draft?')
    expect(confirmBeatAction('end_early')).toMatch(/End this BEAT now\?/)
    expect(confirmBeatAction('edit')).toBeNull()
  })
})

describe('Stripe return', () => {
  const started = NOW.getTime()
  it('says the payment was cancelled', () => {
    expect(paymentNote('cancelled', beat(), null, started, NOW)).toEqual({ text: "Payment cancelled. You haven't been charged. Choose Pay to try again.", settled: true })
  })
  it('waits for the webhook while the BEAT is still a draft', () => {
    expect(paymentNote('p1', beat({ status: 'draft' }), null, started, NOW)).toEqual({ text: 'Payment received. Confirming it…', settled: false })
    expect(paymentNote('p1', beat({ status: 'draft' }), null, started, new Date(started + 3 * 60_000))?.text).toBe('Payment received. Confirming it…')
    const late = new Date(started + 6 * 60_000)
    expect(paymentNote('p1', beat({ status: 'draft' }), null, started, late)?.text).toBe("Stripe hasn't confirmed your payment yet. This can take a few minutes. If it is still waiting after 10 minutes, contact support@virvi.io and quote this BEAT's name. Don't pay again.")
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
    expect(confirmBeatAction('cancel', beat({ status: 'draft' }))).toBe('Delete this draft?')
  })

  it('M10: says where the refund goes after a cancel', () => {
    expect(cancelledNote(beat(), true)).toBe('Cancelled. Your refund is on its way: to your card (it can take a few days), or straight back to your Virvi credit if you paid with credit.')
    expect(cancelledNote(beat(), false)).toBe('Cancelled.')
    expect(cancelledNote(beat({ test: true }), true)).toBe('Cancelled.')
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
    expect(fieldsOfPatch({ location: blankLocation() })).toEqual(['location'])
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

describe('formatWhen and beatWindow', () => {
  // dateStyle/timeStyle can't be combined with timeZoneName: browsers throw "Invalid option", which crashed every BEAT list
  it('names the time zone without throwing', () => {
    const iso = '2026-11-16T18:30:00.000Z'
    const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date(iso)).find((p) => p.type === 'timeZoneName')!.value
    expect(formatWhen(iso, true)).toContain(zone)
    expect(formatWhen(iso, true)).toContain('2026')
    expect(formatWhen(iso)).not.toContain(zone)
  })
  it('shows the window with the zone once, at the end', () => {
    const w = beatWindow({ startsAt: '2026-11-16T18:00:00.000Z', endsAt: '2026-11-16T20:00:00.000Z' })
    expect(w).toContain(' – ')
    expect(w.split(' – ')[1]).toMatch(/[A-Z]{2,}|GMT|UTC/)
  })
})

describe('beatsExplainerFor (the public /beats page for signed-out visitors)', () => {
  it('is the bare BEATs page only: not a BEAT, the create page or anything else', () => {
    expect(beatsExplainerFor('/beats', '')).toBe(true)
    expect(beatsExplainerFor('/beats/', '?utm_source=polygonscan')).toBe(true)
    expect(beatsExplainerFor('/beats', '?id=853288e3-7390-451b-afa0-e3bdcf1c31cd')).toBe(false)
    expect(beatsExplainerFor('/beats/new', '')).toBe(false)
    expect(beatsExplainerFor('/scenes', '')).toBe(false)
  })
})

describe('collected BEATs (LIV-185)', () => {
  const W1 = '0x52908400098527886E0F7030069857D2E4169EE7'
  const W2 = '0x8617E340B3D01FA5F11F306F4090FD50E238070D'
  const mk = (over: Partial<CollectedBeat> = {}): CollectedBeat => ({
    tokenId: '1', contract: '0xc', chain: 'polygon', kind: 'basic', wallet: W1, quantity: 1, earned: true, name: 'A', imageUrl: null,
    place: null, startsAt: '2026-11-10T12:00:00Z', endsAt: '2026-11-10T14:00:00Z', tradeable: false, tokenUrl: 'u', mintTxUrl: null, claimedAt: null, ...over,
  })
  const none: CollectedFilter = { wallet: 'all', from: null, to: null, kind: 'all', earnedOnly: false }
  const items = [
    mk({ tokenId: '1', startsAt: '2026-11-10T00:00:00Z' }),
    mk({ tokenId: '2', wallet: W2, earned: false, startsAt: '2026-11-12T23:59:59Z' }),
    mk({ tokenId: '3', startsAt: '2026-11-15T10:00:00Z' }),
  ]
  const ids = (f: Partial<CollectedFilter>) => filterCollected(items, { ...none, ...f }).map((b) => b.tokenId)

  it('no filter keeps everything, and does not mutate', () => {
    expect(ids({})).toEqual(['1', '2', '3'])
  })
  it('filters by wallet', () => { expect(ids({ wallet: W2 })).toEqual(['2']) })
  it('filters by earned only', () => { expect(ids({ earnedOnly: true })).toEqual(['1', '3']) })
  it('filters by kind; custom returns none today', () => {
    expect(ids({ kind: 'basic' })).toEqual(['1', '2', '3'])
    expect(ids({ kind: 'custom' })).toEqual([])
  })
  it('date ends are inclusive, in UTC', () => {
    expect(ids({ from: '2026-11-10', to: '2026-11-12' })).toEqual(['1', '2'])
    expect(ids({ from: '2026-11-13' })).toEqual(['3'])
    expect(ids({ to: '2026-11-10' })).toEqual(['1'])
  })
  it('combines filters', () => {
    expect(ids({ wallet: W1, from: '2026-11-11', earnedOnly: true })).toEqual(['3'])
  })
  it('shortWallet and walletPageHref', () => {
    expect(shortWallet(W1)).toBe('0x5290…9EE7')
    expect(walletPageHref(W1.toLowerCase())).toBe(`/w/${W1}`)
    expect(walletPageHref(W2)).toBe(`/w/${W2}`)
  })
})

describe('walletFromPath', () => {
  const W1 = '0x52908400098527886E0F7030069857D2E4169EE7'
  it('returns the checksummed address, with or without a trailing slash and in any case', () => {
    expect(walletFromPath(`/w/${W1}`)).toBe(W1)
    expect(walletFromPath(`/w/${W1}/`)).toBe(W1)
    expect(walletFromPath(`/w/${W1.toLowerCase()}`)).toBe(W1)
  })
  it('is null for anything that is not an address', () => {
    expect(walletFromPath('/w/_')).toBeNull()
    expect(walletFromPath('/w/0x123')).toBeNull()
    expect(walletFromPath('/w/')).toBeNull()
    expect(walletFromPath('/beats')).toBeNull()
  })
})

describe('walletLookupHref (the BEAT page\'s wallet lookup)', () => {
  it('takes a pasted address, trimmed and any case, to its checksummed wallet page', () => {
    expect(walletLookupHref('  0xc2877b05cfe462e585fe3de8046f7528998af6f1 ')).toBe('/w/0xc2877b05CFe462E585fE3DE8046F7528998aF6F1')
    expect(walletLookupHref('0xC2877B05CFE462E585FE3DE8046F7528998AF6F1')).toBe('/w/0xc2877b05CFe462E585fE3DE8046F7528998aF6F1')
  })
  it('is null for anything that is not a wallet address', () => {
    for (const bad of ['', '0x', 'vitalik.eth', '0xc2877b05cfe462e585fe3de8046f7528998af6f', '0xzz877b05cfe462e585fe3de8046f7528998af6f1']) expect(walletLookupHref(bad)).toBeNull()
  })
})

describe('datesBackwards (LIV-185 follow-up)', () => {
  it('is true only when both dates are set and From is after To', async () => {
    const { datesBackwards } = await import('./beats')
    expect(datesBackwards('2026-11-18', '2026-11-01')).toBe(true)
    expect(datesBackwards('2026-11-01', '2026-11-18')).toBe(false)
    expect(datesBackwards('2026-11-18', '2026-11-18')).toBe(false)
    expect(datesBackwards('2026-11-18', null)).toBe(false)
    expect(datesBackwards(null, '2026-11-01')).toBe(false)
  })
})
