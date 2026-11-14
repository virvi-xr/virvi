import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Claimants, copyWallets } from './Claimants'
import type { BeatClaimant } from '@/lib/beats'

const list: BeatClaimant[] = [
  { wallet: '0x1234567890abcdef1234567890abcdef12345678', displayName: '<b>Ana</b>', status: 'minted', claimedAt: null, mintedAt: null, txUrl: 'https://polygonscan.com/tx/0xaa' },
  { wallet: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', displayName: 'Bo', status: 'minted', claimedAt: null, mintedAt: null, txUrl: null },
]

describe('Claimants', () => {
  it('renders a name containing <b> as text', () => {
    const html = renderToStaticMarkup(createElement(Claimants, { claimants: list }))
    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;')
    expect(html).not.toContain('<b>Ana</b>')
  })
  it('shows a short wallet, and a tx link only for a minted claim with a tx', () => {
    const html = renderToStaticMarkup(createElement(Claimants, { claimants: list }))
    expect(html).toContain('0x1234…5678')
    expect(html.match(/polygonscan\.com\/tx\//g)).toHaveLength(1)
    expect(html).toContain('Copy wallets')
  })
  it('"Copy wallets" copies newline-joined full wallets', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    await copyWallets(list, { writeText })
    expect(writeText).toHaveBeenCalledWith('0x1234567890abcdef1234567890abcdef12345678\n0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')
  })
})
