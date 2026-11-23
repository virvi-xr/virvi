import { describe, expect, it } from 'vitest'
import type { HostGiveaway } from '@virvixr/shared'
import {
  claimsCoveredLabel, dropsError, formatPol, fundingLines, giveawayAddressUrl, giveawayStatus, mintStep, notReadyLines, polIsZero,
  GIVEAWAYS_OFF, SEND_BACK_FIRST,
} from './drops'

const WALLET = '0x1234567890abcdef1234567890abcdef12345678'
const NOW = Date.parse('2026-11-23T12:00:00Z')

const funding = (over: Partial<HostGiveaway['funding']> = {}): HostGiveaway['funding'] => ({
  balanceWei: '0', withdrawableWei: '0', claimsCovered: 0, covered: false, tankMissing: false, lowGas: false, ...over,
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
