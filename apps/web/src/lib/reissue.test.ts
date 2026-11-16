import { describe, expect, it } from 'vitest'
import {
  APPROVED_NOTE, BLOCKER_LABELS, WALLET_BLOCKED_LABEL, FLAG_LABELS, SAFE_STEPS, WITHDRAW_WARNING, adminReissueError, linkedByLabel, moveError, moveFormError, revocationNote,
} from './reissue'

const W1 = '0x1111111111111111111111111111111111111111'
const W2 = '0x2222222222222222222222222222222222222222'
const err = (code: string) => Object.assign(new Error(code), { status: 400, body: { error: code } })

describe('reissue: the person', () => {
  it('checks the form before sending', () => {
    expect(moveFormError({ oldWallet: W1, newWallet: W2, reason: 'Phished' })).toBeNull()
    expect(moveFormError({ oldWallet: 'nope', newWallet: W2, reason: 'x' })).toBe('Give the old wallet as a 0x address.')
    expect(moveFormError({ oldWallet: W1, newWallet: '', reason: 'x' })).toBe('Pick the new wallet.')
    expect(moveFormError({ oldWallet: W1, newWallet: W1.toUpperCase().replace('0X', '0x'), reason: 'x' })).toBe('The old and new wallets must be different.')
    expect(moveFormError({ oldWallet: W1, newWallet: W2, reason: ' ' })).toBe('Say what happened to the old wallet.')
  })
  it('says what to do for each refusal', () => {
    expect(moveError(err('signed_in_with_old_wallet'))).toBe('Sign in with your new wallet, or with your email, to ask for this.')
    expect(moveError(err('cancel_not_allowed'))).toBe('Sign in with your new wallet, or with your email, to cancel this.')
    expect(moveError(err('wallet_blocked'))).toBe('This wallet can no longer sign in to Virvi.')
    for (const c of ['bad_wallet', 'same_wallet', 'bad_reason', 'wallet_not_linked', 'no_beats_on_wallet', 'request_open', 'not_pending', 'account_required']) {
      expect(moveError(err(c))).not.toBe('Something went wrong. Try again.')
    }
  })
  it('tells the person what approval removed, without promising a sign-out everywhere', () => {
    expect(APPROVED_NOTE).toBe('We removed your API keys and paired devices, and your old wallet can no longer sign in. Set your keys and devices up again.')
    expect(APPROVED_NOTE).not.toMatch(/signed (you )?out everywhere/i)
  })
})

describe('reissue: the admin queue', () => {
  it('has a plain line for every flag and blocker', () => {
    expect(Object.keys(FLAG_LABELS).sort()).toEqual(['clash', 'earlier_reissue', 'follow_up_reissue', 'new_wallet_linked_by_old_wallet', 'new_wallet_recent', 'recent_cancel'])
    expect(Object.keys(BLOCKER_LABELS)).toHaveLength(9)
    expect(WALLET_BLOCKED_LABEL).toBe("Blocked: can't sign in")
  })
  it('gives the Safe steps in order, and the withdraw warning', () => {
    expect(SAFE_STEPS.join(' → ')).toBe('Open your Safe (app.safe.global) on the right network. → Go to Apps, then Transaction Builder. → Drag in this file. → Press Simulate, and check it succeeds. → Press Create batch. → Get a second signer to approve it. → Execute it.')
    expect(WITHDRAW_WARNING).toBe('Also discard (reject) the pending Safe transaction for this request, or it can still go through.')
  })
  it('shows the revocation note the approval wrote', () => {
    const note = 'Removed 2 API keys and 1 paired device; the old wallet\'s sessions are refused.'
    expect(revocationNote({ audit: [{ at: 'x', by: null, action: 'approved' }, { at: 'y', by: null, action: 'revoked_credentials', note }] })).toBe(note)
    expect(revocationNote({ audit: [] })).toBeNull()
  })
  it('says how a wallet was linked', () => {
    expect(linkedByLabel({ method: 'wallet', how: 'link', wallet: W1 })).toBe('linked, signed in with 0x1111…1111')
    expect(linkedByLabel(null)).toBe('Unknown')
  })
  it('maps the admin codes, keeping the code', () => {
    expect(adminReissueError(err('wallets_unreviewed'))).toEqual({ message: 'Choose keep or unlink for every wallet listed under "Wallets to decide on".', code: 'wallets_unreviewed' })
    expect(adminReissueError(err('already_landed')).message).toMatch(/can no longer be withdrawn/)
    expect(adminReissueError(err('request_open')).message).toBe('This wallet is the old wallet of an open request. Withdraw or reject the request first.')
    expect(adminReissueError(err('own_request')).message).toBe("You can't review your own request. Ask another admin.")
    expect(adminReissueError(new Error('x')).message).toBe('Something went wrong. Try again, or ask a developer to check the server logs.')
  })
})
