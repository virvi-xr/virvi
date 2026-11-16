import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AdminBeatsView } from './AdminBeats'
import type { AdminBeatsOverview } from '@/lib/admin-beats'

const MINTER = '0x1234567890abcdef1234567890abcdef12345678'
const data = (over: Partial<AdminBeatsOverview> = {}): AdminBeatsOverview => ({
  chains: [{ chain: 'polygon-amoy', contract: null, minter: MINTER, balanceWei: '1500000000000000000', balanceError: false, paused: false, reason: null, missing: [], minGasWei: '1000000000000000000', batchCostWei: null, topUpWei: null }],
  counts: { claimed: 4, minting: 2, failed: 1, givenUp: 0 },
  failed: [{ beatId: 'b1', name: 'Launch party', wallet: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', failReason: 'reverted', retryable: true }],
  batches: [{ id: 't1', chain: 'polygon-amoy', kind: 'mint', tokenId: '7', nonce: 3, status: 'confirmed', attempts: 1, txUrl: 'https://amoy.polygonscan.com/tx/0xaa', createdAt: '2026-11-14T12:00:00Z' }],
  held: [],
  ...over,
})
const render = (d: AdminBeatsOverview) => renderToStaticMarkup(createElement(AdminBeatsView, { data: d, busy: false, onRetry: () => {}, onClearPause: () => {}, onGiveUp: () => {} }))

describe('AdminBeatsView (LIV-11)', () => {
  it('shows the minter with a copy button, the balance in POL, the counts, failed claims and batch links', () => {
    const html = render(data())
    expect(html).toContain('0x1234…5678')
    expect(html).toContain(`Copy wallet ${MINTER}`)
    expect(html).toContain('1.5 POL')
    expect(html).toContain('Retry failed')
    expect(html).toContain('Launch party')
    expect(html).toContain('https://amoy.polygonscan.com/tx/0xaa')
    expect(html).toContain(`https://amoy.polygonscan.com/address/${MINTER}`)
  })
  it('shows the low-gas pause', () => {
    const html = render(data({ chains: [{ ...data().chains[0], paused: true, reason: 'low_gas', balanceWei: '250000000000000000', batchCostWei: '400000000000000000', topUpWei: '1150000000000000000' }] }))
    expect(html).toContain('Minting is paused because the minter wallet is low on POL')
    expect(html).toContain('Balance 0.2500 POL. Minimum 1.0000 POL. Top up 1.1500 POL: the minimum plus one full 100-claim batch at current fees.')
    expect(html).not.toContain('Clear pause')
  })
  it('shows an id clash with a Clear pause button', () => {
    const html = render(data({ chains: [{ ...data().chains[0], paused: true, reason: 'id_conflict' }] }))
    expect(html).toContain('Minting is stopped on purpose.')
    expect(html).toContain('Clear pause')
  })
  it('shows a chain that is not set up, with what it is missing, instead of hiding it', () => {
    const html = render(data({ chains: [{ chain: 'polygon', contract: null, minter: null, balanceWei: null, balanceError: false, paused: true, reason: 'no_client', missing: ['BEAT_CONTRACT_POLYGON', 'BEAT_MINTER_KEY'], minGasWei: '1000000000000000000', batchCostWei: null, topUpWei: null }] }))
    expect(html).toContain('Polygon')
    expect(html).toContain('Not set up')
    expect(html).toContain('Missing: BEAT_CONTRACT_POLYGON and BEAT_MINTER_KEY.')
    expect(html).not.toContain('Polygonscan</a></dd>')
    expect(html).not.toContain('Balance unavailable')
  })
  it('says the balance is unavailable, never 0, when it could not be read', () => {
    const html = render(data({ chains: [{ ...data().chains[0], balanceWei: null, balanceError: true }] }))
    expect(html).toContain('Balance unavailable')
    expect(html).not.toContain('0 POL')
  })
  it('offers "Stop retrying and close" (an in-page confirm, not a browser one) only for BEATs a give-up can close', () => {
    expect(render(data())).not.toContain('Stop retrying and close')
    const html = render(data({ held: [{ beatId: 'b1', name: 'Launch party', retryable: 3 }] }))
    expect(html).toContain('Stop retrying and close')
    expect(html).toContain('3 failed claims hold it open')
    expect(html).not.toContain('confirm(')
  })
  it('M5: a given-up claim reads as given up, with no "Retry this BEAT", and Retry failed is off when nothing is retryable', () => {
    const html = render(data({
      counts: { claimed: 0, minting: 0, failed: 0, givenUp: 1 },
      failed: [{ beatId: 'b1', name: 'Launch party', wallet: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', failReason: 'given_up', retryable: false }],
    }))
    expect(html).toContain('You stopped retrying')
    expect(html).not.toContain('Retry all failed for this BEAT')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Retry failed<\/button>/)
    expect(render(data())).toContain('Retry all failed for this BEAT')
  })
})
