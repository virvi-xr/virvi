import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AdminBeatsView } from './AdminBeats'
import type { AdminBeatsOverview } from '@/lib/admin-beats'

const MINTER = '0x1234567890abcdef1234567890abcdef12345678'
const data = (over: Partial<AdminBeatsOverview> = {}): AdminBeatsOverview => ({
  chains: [{ chain: 'polygon-amoy', contract: null, minter: MINTER, balanceWei: '1500000000000000000', balanceError: false, paused: false, reason: null }],
  counts: { claimed: 4, minting: 2, failed: 1 },
  failed: [{ beatId: 'b1', name: 'Launch party', wallet: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', failReason: 'reverted' }],
  batches: [{ id: 't1', chain: 'polygon-amoy', kind: 'mint', tokenId: '7', nonce: 3, status: 'confirmed', attempts: 1, txUrl: 'https://amoy.polygonscan.com/tx/0xaa', createdAt: '2026-11-14T12:00:00Z' }],
  ...over,
})
const render = (d: AdminBeatsOverview) => renderToStaticMarkup(createElement(AdminBeatsView, { data: d, busy: false, onRetry: () => {}, onClearPause: () => {} }))

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
    const html = render(data({ chains: [{ ...data().chains[0], paused: true, reason: 'low_gas', balanceWei: '1' }] }))
    expect(html).toContain('Minting paused: top up the minter')
    expect(html).not.toContain('Clear pause')
  })
  it('shows an id clash with a Clear pause button', () => {
    const html = render(data({ chains: [{ ...data().chains[0], paused: true, reason: 'id_conflict' }] }))
    expect(html).toContain('Minting paused: a BEAT id already exists on chain. Check before clearing.')
    expect(html).toContain('Clear pause')
  })
  it('says the balance is unavailable, never 0, when it could not be read', () => {
    const html = render(data({ chains: [{ ...data().chains[0], balanceWei: null, balanceError: true }] }))
    expect(html).toContain('Balance unavailable')
    expect(html).not.toContain('0 POL')
  })
})
