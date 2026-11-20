import { describe, expect, it } from 'vitest'
import { budgetLine, lockedCopy, planButtonLabel, tokenExpiresWithin } from './copy'

describe('budgetLine', () => {
  it('shows what is left when not warning', () => {
    expect(budgetLine({ percentLeft: 80, warn: false, resetsAt: '2026-12-03T00:00:00Z' })).toEqual({ text: "80% of this month's assistant budget left", upgrade: false })
  })
  it('shows what is used when warning', () => {
    expect(budgetLine({ percentLeft: 15, warn: true, resetsAt: '2026-12-03T00:00:00Z' })).toEqual({ text: "You've used 85% of this month's assistant budget", upgrade: false })
  })
  it('says when it comes back at zero, with an upgrade link', () => {
    expect(budgetLine({ percentLeft: 0, warn: true, resetsAt: '2026-12-03T12:00:00Z' })).toEqual({ text: "You've used this month's assistant budget. It comes back on 3 Dec.", upgrade: true })
  })
  it('shows nothing with no cap', () => {
    expect(budgetLine({ percentLeft: 100, warn: false, resetsAt: null })).toBeNull()
    expect(budgetLine(null)).toBeNull()
  })
})

describe('lockedCopy', () => {
  it('plan', () => expect(lockedCopy('plan')).toEqual({ text: 'The assistant is included with paid plans.', link: { label: 'See plans', href: '/settings' } }))
  it('trial', () => expect(lockedCopy('trial')).toEqual({ text: 'Create an account to use the assistant.', link: null }))
})

describe('planButtonLabel', () => {
  it('counts the changes', () => {
    expect(planButtonLabel(3)).toBe('Do these 3 changes')
    expect(planButtonLabel(1)).toBe('Do this change')
  })
})

describe('tokenExpiresWithin', () => {
  const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`
  it('is true near expiry, false far from it, true when unreadable', () => {
    const now = 1_000_000_000_000
    expect(tokenExpiresWithin(jwt(now / 1000 + 30), 60_000, now)).toBe(true)
    expect(tokenExpiresWithin(jwt(now / 1000 + 600), 60_000, now)).toBe(false)
    expect(tokenExpiresWithin('garbage', 60_000, now)).toBe(true)
  })
})
