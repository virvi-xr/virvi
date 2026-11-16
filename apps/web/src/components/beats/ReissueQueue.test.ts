import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReissueRequestCard, SafeSteps, type ReissueActions } from './ReissueQueue'
import type { AdminReissueRequest } from '@/lib/reissue'

const OLD = '0x1111111111111111111111111111111111111111'
const NEW = '0x2222222222222222222222222222222222222222'
const noop = () => {}
const a: ReissueActions = {
  busy: false, approve: noop, reject: noop, preview: async () => null, propose: async () => null, download: noop, saveFile: noop, withdraw: noop, unlink: noop, liftBlock: noop,
}
const req = (over: Partial<AdminReissueRequest> = {}): AdminReissueRequest => ({
  id: 'r1', oldWallet: OLD, newWallet: NEW, loss: 'stolen', reason: 'Phished', status: 'pending', reviewNote: null, createdAt: '2026-11-15T10:00:00Z', reviewedAt: null,
  proposedAt: null, doneAt: null, cancelledAt: null, withdrawnAt: null, account: { id: 'u', displayName: 'Ana', email: 'ana@example.com' }, reviewer: null,
  filedVia: { method: 'email', email: 'ana@example.com' }, cancelledVia: null, dataDeletedAt: null, audit: [], flags: ['new_wallet_recent'],
  otherSignIns: { email: true, password: false, oauth: false },
  wallets: [{ wallet: OLD, linked: true, blocked: false, linkedAt: null, linkedBy: null, lastSignInAt: null }, { wallet: NEW, linked: true, blocked: false, linkedAt: null, linkedBy: null, lastSignInAt: null }],
  walletEvents: [], history: [],
  reviewWallets: [{ wallet: '0x3333333333333333333333333333333333333333', linkedAt: '2026-11-14T10:00:00Z', linkedBy: { method: 'wallet', wallet: OLD }, why: 'linked_by_old_wallet' }],
  files: [], beats: [{ claimId: 'c', beatId: 'b', name: 'Launch', chain: 'polygon', tokenId: '7', tradeable: false, state: null, chainState: null, blockers: ['BeatOpen'], eligible: false, landed: false, fileId: null, callIndex: null, txUrl: null }],
  ...over,
})
const html = (r: AdminReissueRequest) => renderToStaticMarkup(createElement(ReissueRequestCard, { r, a }))

describe('ReissueRequestCard', () => {
  it('a pending request shows its red flags, per-BEAT checks, the wallets to decide on and the approval warning', () => {
    const h = html(req())
    expect(h).toContain('Red flag: New wallet linked under 7 days before the request')
    expect(h).toContain('Wait until it ends')
    expect(h).toContain('Wallets to decide on')
    expect(h).toContain('Unlink and block')
    expect(h).toContain('Approving blocks the old wallet from this account and from BEATs')
    expect(h).toContain('Lost or stolen</dt><dd>Stolen')
  })
  it('an approved request offers the Safe files and Withdraw, with the Safe warning', () => {
    const h = html(req({ status: 'approved', reviewWallets: [], audit: [{ at: 'x', by: null, action: 'revoked_credentials', note: "Removed 1 API key and 0 paired devices; the old wallet's sessions are refused." }] }))
    expect(h).toContain('Prepare Safe files')
    expect(h).toContain('Withdraw request')
    expect(h).toContain('Also discard (reject) the pending Safe transaction for this request, or it can still go through.')
    expect(h).toContain('Removed 1 API key and 0 paired devices; the old wallet&#x27;s sessions are refused.')
  })
  it('a clash and a voided file that landed raise alerts; a blocked wallet offers Lift block', () => {
    const h = html(req({ status: 'proposed', flags: ['clash'], audit: [{ at: 'x', by: null, action: 'voided_file_landed' }], wallets: [{ wallet: OLD, linked: false, blocked: true, linkedAt: null, linkedBy: null, lastSignInAt: null }] }))
    expect(h).toContain('A BEAT was moved on chain but its claim could not move')
    expect(h).toContain('A withdrawn Safe file went through anyway')
    expect(h).toContain('Lift block')
  })
  it("the admin's own request can't be reviewed by them: no Approve or Reject, and it says how to cancel it", () => {
    const h = renderToStaticMarkup(createElement(ReissueRequestCard, { r: req(), a: { ...a, me: 'u' } }))
    expect(h).toContain('This is your own request')
    expect(h).toContain('Settings')
    expect(h).not.toContain('>Approve<')
    expect(h).not.toContain('>Reject<')
    const approved = renderToStaticMarkup(createElement(ReissueRequestCard, { r: req({ status: 'approved', reviewWallets: [] }), a: { ...a, me: 'u' } }))
    expect(approved).not.toContain('Reject (uses the note)')
  })
  it('the Safe steps', () => {
    expect(renderToStaticMarkup(createElement(SafeSteps))).toContain('Get a second signer to approve it.')
  })
})
