import { describe, it, expect } from 'vitest'
import { resendWaitSec, showVerifyBanner, verifyErrorText, waitLabel } from './email-verification'

describe('email verification helpers (LIV-161)', () => {
  const s = (o: Partial<{ email: string | null; verified: boolean; nextResendAt: string | null }>) => ({ email: 'a@b.c', verified: false, nextResendAt: null, ...o })

  it('the banner shows only for an unconfirmed email not dismissed', () => {
    expect(showVerifyBanner(s({}), false)).toBe(true)
    expect(showVerifyBanner(s({}), true)).toBe(false)
    expect(showVerifyBanner(s({ verified: true }), false)).toBe(false)
    expect(showVerifyBanner(s({ email: null }), false)).toBe(false)
    expect(showVerifyBanner(null, false)).toBe(false)
  })

  it('resend wait counts down from nextResendAt and labels it', () => {
    const now = Date.parse('2026-11-18T00:00:00Z')
    expect(resendWaitSec(s({}), now)).toBe(0)
    expect(resendWaitSec(s({ nextResendAt: '2026-11-18T00:00:42Z' }), now)).toBe(42)
    expect(resendWaitSec(s({ nextResendAt: '2026-11-17T23:00:00Z' }), now)).toBe(0)
    expect(waitLabel(42)).toBe('in 42 s')
    expect(waitLabel(150)).toBe('in 3 min')
    expect(waitLabel(5 * 3600 - 10)).toBe('in 5 h')
  })

  it('each link error has its own text', () => {
    expect(verifyErrorText('expired_link')).toMatch(/expired/)
    expect(verifyErrorText('used_link')).toMatch(/already been used/)
    expect(verifyErrorText('email_changed')).toMatch(/no longer uses/)
    expect(verifyErrorText(undefined)).toMatch(/isn't valid/)
  })
})
