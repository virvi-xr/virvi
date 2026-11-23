import { describe, expect, it } from 'vitest'
import type { HostGiveaway } from '@virvixr/shared'
import {
  claimsCoveredLabel, dropsError, formatPol, fundingLines, giveawayAddressUrl, giveawayStatus, mintStep, notReadyLines, pickerItems, polIsZero,
  rulesPatch, sendableWei, GIVEAWAYS_OFF, HELD_LINE, SEND_BACK_FIRST, type CreatorItem,
} from './drops'

const WALLET = '0x1234567890abcdef1234567890abcdef12345678'
const NOW = Date.parse('2026-11-23T12:00:00Z')

const funding = (over: Partial<HostGiveaway['funding']> = {}): HostGiveaway['funding'] => ({
  balanceWei: '0', withdrawableWei: '0', transferGasWei: '0', claimsCovered: 0, covered: false, tankMissing: false, lowGas: false, held: false, ...over,
})

describe('formatPol', () => {
  it('shows a wei string as POL with 4 decimals, rounded down', () => {
    expect(formatPol('0')).toBe('0.0000')
    expect(formatPol('1000000000000000000')).toBe('1.0000')
    expect(formatPol('1234567890000000000')).toBe('1.2345')
    expect(formatPol('99999999999999')).toBe('0.0000')
    expect(formatPol('100000000000000')).toBe('0.0001')
    expect(formatPol('123456000000000000000000')).toBe('123456.0000')
  })
  it('reads anything that is not a wei amount as 0', () => {
    expect(formatPol('')).toBe('0.0000')
    expect(formatPol('abc')).toBe('0.0000')
    expect(formatPol('-5')).toBe('0.0000')
  })
  it('polIsZero is true only for nothing', () => {
    expect(polIsZero('0')).toBe(true)
    expect(polIsZero('junk')).toBe(true)
    expect(polIsZero('1')).toBe(false)
  })
})

describe('claimsCoveredLabel', () => {
  it('says about how many claims, in the singular for one', () => {
    expect(claimsCoveredLabel(0)).toBe('about 0 claims')
    expect(claimsCoveredLabel(1)).toBe('about 1 claim')
    expect(claimsCoveredLabel(1250)).toBe('about 1,250 claims')
  })
})

describe('fundingLines', () => {
  it('covered: the plan pays, plus the host’s own POL when there is some', () => {
    expect(fundingLines(funding({ covered: true }))).toEqual({ lines: ['Gas is covered by your plan.'], warning: null })
    expect(fundingLines(funding({ covered: true, withdrawableWei: '2500000000000000000' })))
      .toEqual({ lines: ['Gas is covered by your plan.', 'You also have 2.5000 POL here.'], warning: null })
  })
  it('paid but no gas tank: send POL yourself', () => {
    expect(fundingLines(funding({ tankMissing: true, claimsCovered: 40 })).lines)
      .toEqual(["Gas cover isn't set up on this server yet. Send POL to the address above."])
  })
  it('free: send POL, with how many claims it covers and a warning when low', () => {
    expect(fundingLines(funding({ claimsCovered: 40 })))
      .toEqual({ lines: ['Send POL to the address above. It covers about 40 claims.'], warning: null })
    expect(fundingLines(funding({ claimsCovered: 3, lowGas: true })))
      .toEqual({ lines: ['Send POL to the address above. It covers about 3 claims.'], warning: 'Running low: about 3 claims left.' })
  })
})

describe('send back (M-2)', () => {
  it('sendableWei is the withdrawable less one transfer of gas, never below 0', () => {
    expect(sendableWei(funding({ withdrawableWei: '1000', transferGasWei: '300' }))).toBe('700')
    expect(sendableWei(funding({ withdrawableWei: '300', transferGasWei: '300' }))).toBe('0')
    expect(sendableWei(funding({ withdrawableWei: '100', transferGasWei: '300' }))).toBe('0')
  })
  it('a replaced-transaction hold says Virvi support is checking, and shows no POL as the host’s', () => {
    expect(fundingLines(funding({ covered: true, held: true, withdrawableWei: '0' })).lines).toEqual(['Gas is covered by your plan.', HELD_LINE])
    expect(fundingLines(funding({ held: true, claimsCovered: 40 })).lines).toContain(HELD_LINE)
  })
})

describe('rulesPatch (M-2)', () => {
  const g = { startsAt: '2026-11-20T10:00:30.000Z', endsAt: '2026-11-21T10:00:00.000Z', claimCap: 100, minPresentSeconds: 90 }
  const form = (over: Partial<{ startsAt: string; endsAt: string; cap: string; minutes: string }> = {}) => ({
    startsAt: 'L-start', endsAt: 'L-end', cap: '100', minutes: '2', ...over,
  })
  const local = (iso: string) => (iso === g.startsAt ? 'L-start' : iso === g.endsAt ? 'L-end' : `L:${iso}`)
  const iso = (v: string) => (v === 'L-new' ? '2026-12-01T10:00:00.000Z' : '')

  it('sends only what changed, so a past end or lost seconds never block a cap-only edit', () => {
    expect(rulesPatch(g, form({ cap: '50' }), local, iso)).toEqual({ claimCap: 50 })
    expect(rulesPatch(g, form({ cap: '' }), local, iso)).toEqual({ claimCap: null })
    expect(rulesPatch(g, form(), local, iso)).toEqual({})
  })
  it('a changed or cleared time, and minutes, are sent', () => {
    expect(rulesPatch(g, form({ endsAt: 'L-new', minutes: '5' }), local, iso)).toEqual({ endsAt: '2026-12-01T10:00:00.000Z', minPresentSeconds: 300 })
    expect(rulesPatch(g, form({ startsAt: '' }), local, iso)).toEqual({ startsAt: null })
    // 90 seconds shows as 2 minutes; leaving it alone keeps the 90
    expect(rulesPatch(g, form({ minutes: '2' }), local, iso)).toEqual({})
  })
})

describe('pickerItems (M-2)', () => {
  const mine: CreatorItem = { contractAddress: '0xAbC0000000000000000000000000000000000001', itemId: '1', name: 'Hat', thumbnail: null, rarity: 'rare', available: 5 }
  const current = (over: Partial<HostGiveaway['items'][number]>): HostGiveaway['items'][number] => ({
    id: 'i', contractAddress: '0xabc0000000000000000000000000000000000002', itemId: '9', name: 'Old cape', thumbnail: null, rarity: null,
    mintState: 'ready', remaining: 3, checkedAt: null, ...over,
  })
  it('keeps current items the creator list no longer has, first, so saving keeps them', () => {
    const rows = pickerItems([mine], [current({}), current({ contractAddress: mine.contractAddress.toLowerCase(), itemId: '1', name: 'Hat' })])
    expect(rows.map((r) => [r.name, r.missing])).toEqual([['Old cape', true], ['Hat', false]])
    expect(rows[0]).toMatchObject({ contractAddress: '0xabc0000000000000000000000000000000000002', itemId: '9', available: 3 })
  })
  it('skips current items without a contract (old rows)', () => {
    expect(pickerItems([], [current({ contractAddress: null })])).toEqual([])
  })
})

describe('mintStep', () => {
  it('labels each mint state', () => {
    expect(mintStep('ready', WALLET)).toEqual({ tone: 'success', text: 'Can mint ✓', builder: false })
    expect(mintStep('not_minter', WALLET)).toEqual({ tone: 'warning', text: 'Add 0x1234…5678 as a minter in the Builder', builder: true })
    expect(mintStep('not_approved', WALLET)).toEqual({ tone: 'warning', text: 'Waiting for curation', builder: false })
    expect(mintStep('sold_out', WALLET)).toEqual({ tone: 'danger', text: 'Sold out', builder: false })
    expect(mintStep(null, WALLET)).toEqual({ tone: 'neutral', text: 'Not checked yet', builder: false })
  })
  it('without a wallet, says to add the giveaway wallet', () => {
    expect(mintStep('not_minter', null).text).toBe('Add the giveaway wallet as a minter in the Builder')
  })
})

describe('giveawayStatus', () => {
  const base = { enabled: false, pausedReason: null, endsAt: null, deleteState: null } as const
  it('is Off, On, Paused with its reason, or Ended', () => {
    expect(giveawayStatus(base, NOW)).toEqual({ label: 'Off', tone: 'neutral' })
    expect(giveawayStatus({ ...base, enabled: true }, NOW)).toEqual({ label: 'On', tone: 'success' })
    expect(giveawayStatus({ ...base, enabled: true, pausedReason: 'low_gas' }, NOW))
      .toEqual({ label: 'Paused: not enough POL for gas', tone: 'warning' })
    expect(giveawayStatus({ ...base, enabled: true, endsAt: new Date(NOW - 1000).toISOString() }, NOW)).toEqual({ label: 'Ended', tone: 'neutral' })
    expect(giveawayStatus({ ...base, enabled: true, endsAt: new Date(NOW + 1000).toISOString() }, NOW).label).toBe('On')
  })
  it('a giveaway being deleted says so', () => {
    expect(giveawayStatus({ ...base, deleteState: 'returning' }, NOW)).toEqual({ label: 'Deleting', tone: 'neutral' })
  })
})

describe('errors', () => {
  const err = (status: number, body: Record<string, unknown>) => Object.assign(new Error(String(body.error)), { status, body })
  it('send_back_first has its own words', () => {
    expect(dropsError(err(409, { error: 'send_back_first', message: 'Send your POL back before deleting this giveaway.' }))).toBe(SEND_BACK_FIRST)
    expect(SEND_BACK_FIRST).toBe('Send back the POL first.')
  })
  it('giveaways_off reads as the off notice', () => {
    expect(dropsError(err(503, { error: 'giveaways_off' }))).toBe(GIVEAWAYS_OFF)
    expect(GIVEAWAYS_OFF).toBe("Automatic giveaways aren't switched on yet.")
  })
  it('other refusals use the server’s message, and anything else a generic line', () => {
    expect(dropsError(err(409, { error: 'busy', message: 'Try again in a minute.' }))).toBe('Try again in a minute.')
    expect(dropsError(new Error('boom'))).toBe('Something went wrong. Try again.')
  })
  it('not_ready lists each failing item by name with its step', () => {
    const items = [{ contractAddress: '0xC', itemId: '2', name: 'Hat' }] as HostGiveaway['items']
    const e = err(409, { error: 'not_ready', message: 'Every item must pass the minter check.', items: [{ contractAddress: '0xc', itemId: '2', state: 'sold_out' }, { contractAddress: '0xd', itemId: '9', state: 'not_approved' }] })
    expect(notReadyLines(e, items, WALLET)).toEqual(['Hat: Sold out', 'Item 9: Waiting for curation'])
    expect(notReadyLines(err(409, { error: 'busy' }), items, WALLET)).toEqual([])
  })
})

describe('giveawayAddressUrl', () => {
  it('links the wallet on the chain’s Polygonscan', () => {
    expect(giveawayAddressUrl('polygon', WALLET)).toBe(`https://polygonscan.com/address/${WALLET}`)
    expect(giveawayAddressUrl('polygon-amoy', WALLET)).toBe(`https://amoy.polygonscan.com/address/${WALLET}`)
  })
})
