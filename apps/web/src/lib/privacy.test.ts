import { describe, it, expect } from 'vitest'
import { PRIVACY_NOTICE_VERSION, type PrivacyStatus } from '@virvixr/shared'
import { otherDecision, privacyChoiceLabel, privacyPromptOpen } from './privacy'

const status = (s: Partial<PrivacyStatus>): PrivacyStatus => ({ version: PRIVACY_NOTICE_VERSION, decision: null, decidedAt: null, ...s })

describe('privacyPromptOpen', () => {
  it('opens only once the status has loaded with no decision', () => {
    expect(privacyPromptOpen(null)).toBe(false)
    expect(privacyPromptOpen(status({}))).toBe(true)
    expect(privacyPromptOpen(status({ decision: 'accept', decidedAt: '2026-11-24T10:00:00.000Z' }))).toBe(false)
    expect(privacyPromptOpen(status({ decision: 'decline', decidedAt: '2026-11-24T10:00:00.000Z' }))).toBe(false)
  })
})

describe('privacyChoiceLabel', () => {
  it('says what the account chose, and when', () => {
    expect(privacyChoiceLabel(null)).toBe('Loading…')
    expect(privacyChoiceLabel(status({}))).toMatch(/haven't chosen/)
    expect(privacyChoiceLabel(status({ decision: 'accept', decidedAt: '2026-11-24T10:00:00.000Z' }))).toMatch(/^On: you allowed browser error reporting on /)
    expect(privacyChoiceLabel(status({ decision: 'decline', decidedAt: '2026-11-24T10:00:00.000Z' }))).toMatch(/^Off: you declined/)
  })

  it('offers the other choice', () => {
    expect(otherDecision('accept')).toBe('decline')
    expect(otherDecision('decline')).toBe('accept')
    expect(otherDecision(null)).toBe('accept')
  })
})

describe('admin labels', () => {
  it("show each account's Terms agreement and privacy choice", async () => {
    const { adminPrivacyLabel, adminTermsLabel } = await import('./privacy')
    expect(adminTermsLabel(undefined)).toBe('Terms: -')
    expect(adminTermsLabel({ accepted: false, acceptedVersion: null })).toBe('Terms: not agreed')
    expect(adminTermsLabel({ accepted: false, acceptedVersion: '2020-01-01' })).toBe('Terms: agreed to 2020-01-01 only')
    expect(adminTermsLabel({ accepted: true, acceptedVersion: 'x', acceptedAt: '2026-11-24T10:00:00.000Z' })).toMatch(/^Terms: agreed \S/)
    expect(adminPrivacyLabel(undefined)).toBe('Privacy: not chosen')
    expect(adminPrivacyLabel(status({}))).toBe('Privacy: not chosen')
    expect(adminPrivacyLabel(status({ decision: 'decline', decidedAt: '2026-11-24T10:00:00.000Z' }))).toMatch(/^Privacy: declined \S/)
    expect(adminPrivacyLabel(status({ decision: 'accept', decidedAt: null }))).toBe('Privacy: accepted')
  })
})

describe('privacyDecisionError', () => {
  it('says to reload for a changed notice, and otherwise to retry or sign out', async () => {
    const { privacyDecisionError } = await import('./privacy')
    expect(privacyDecisionError({ body: { error: 'stale_version' } })).toMatch(/Reload the page/)
    expect(privacyDecisionError(new Error('offline'))).toMatch(/sign out/)
    expect(privacyDecisionError(null)).toMatch(/Try again/)
  })
})
