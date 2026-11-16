import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Claimants, copyWallets } from './Claimants'
import type { BeatClaimant } from '@/lib/beats'

const c = (over: Partial<BeatClaimant>): BeatClaimant => ({
  id: 'c', wallet: '0x0000000000000000000000000000000000000000', displayName: null, status: 'minted', claimedAt: null, mintedAt: null, txUrl: null,
  reissued: false, reissueTxUrl: null, ...over,
})
const list: BeatClaimant[] = [
  c({ id: 'c1', wallet: '0x1234567890abcdef1234567890abcdef12345678', displayName: '<b>Ana</b>', txUrl: 'https://polygonscan.com/tx/0xaa' }),
  c({ id: 'c2', wallet: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', displayName: 'Bo' }),
  c({ id: 'c3', wallet: '0x9999999999999999999999999999999999999999', displayName: 'Cy', status: 'present' }),
]

describe('Claimants', () => {
  it('renders a name containing <b> as text', () => {
    const html = renderToStaticMarkup(createElement(Claimants, { claimants: list }))
    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;')
    expect(html).not.toContain('<b>Ana</b>')
  })
  it('plain-ux I3: the heading counts attendees and claims apart; the copy button names what it copies', () => {
    const html = renderToStaticMarkup(createElement(Claimants, { claimants: list }))
    expect(html).toContain('Attendees (3): 2 claimed, 1 still attending')
    expect(html).toContain('Copy wallets that claimed')
    expect(html).toContain('aria-live="polite"')
  })
  it('shows a short wallet, a tx link only for a claim with a tx, and "No transaction" for screen readers otherwise', () => {
    const html = renderToStaticMarkup(createElement(Claimants, { claimants: list }))
    expect(html).toContain('0x1234…5678')
    expect(html.match(/polygonscan\.com\/tx\//g)).toHaveLength(1)
    expect(html).toContain('No transaction')
  })
  it('"Copy wallets that claimed" leaves out visitors still attending', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    await copyWallets(list, { writeText })
    expect(writeText).toHaveBeenCalledWith('0x1234567890abcdef1234567890abcdef12345678\n0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')
  })
  it('a reissued claim is flagged', () => {
    const html = renderToStaticMarkup(createElement(Claimants, { claimants: [c({ reissued: true, reissueTxUrl: 'https://polygonscan.com/tx/0xbb' })] }))
    expect(html).toContain('Reissued')
    expect(html).toContain('polygonscan.com/tx/0xbb')
  })
  it('plain-ux I8: a failed load says so with Try again, never "no one yet"', () => {
    const html = renderToStaticMarkup(createElement(Claimants, { claimants: [], error: true, onRetry: () => {} }))
    expect(html).toContain("We couldn&#x27;t load the attendee list. Try again.")
    expect(html).toContain('Try again</button>')
    expect(html).not.toContain('No one has started tracking yet.')
  })
  it('host review: a held claim says it waits for the Send and offers Remove', () => {
    const held = c({ id: 'h', status: 'claimed', claimedAt: '2026-11-14T12:00:00Z' })
    const beat = { mintsHeldUntil: '2026-11-16T00:00:00Z', mintsReleasedAt: null }
    const html = renderToStaticMarkup(createElement(Claimants, { claimants: [held], beat, onRemove: () => {} }))
    expect(html).toContain('Waiting for your Send')
    expect(html).toContain('Remove')
    expect(html).toContain('<span class="sr-only">Actions</span>')
    // Sent already (claimed before the last Send): no Remove
    const sent = renderToStaticMarkup(createElement(Claimants, { claimants: [held], beat: { ...beat, mintsReleasedAt: '2026-11-14T13:00:00Z' }, onRemove: () => {} }))
    expect(sent).not.toContain('Waiting for your Send')
    expect(sent).not.toContain('Remove')
  })
})
