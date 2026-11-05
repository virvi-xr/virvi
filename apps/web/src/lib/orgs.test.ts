import { describe, it, expect } from 'vitest'
import { memberLabel, type OrgMember } from './orgs'

const m = (over: Partial<OrgMember> = {}): OrgMember => ({
  userId: 'ef5b57b7-ed4c-4e94-b4e3-d2e6a1b6d5db', role: 'member', joinedAt: '2026-11-05T00:00:00Z', displayName: '', email: null, walletAddress: null, ...over,
})

describe('memberLabel (LIV-93)', () => {
  it('is the display name, else the email, else a shortened wallet, else Unnamed member', () => {
    expect(memberLabel(m({ displayName: 'Ada', email: 'ada@x.io' }))).toBe('Ada')
    expect(memberLabel(m({ displayName: '  ', email: 'ada@x.io' }))).toBe('ada@x.io')
    expect(memberLabel(m({ walletAddress: '0x1234567890abcdef1234567890abcdef12345678' }))).toBe('0x1234…5678')
    expect(memberLabel(m())).toBe('Unnamed member')
  })
  it('never shows the user id, and marks your own row', () => {
    expect(memberLabel(m())).not.toContain('ef5b57b7')
    expect(memberLabel(m({ displayName: 'Ada' }), 'ef5b57b7-ed4c-4e94-b4e3-d2e6a1b6d5db')).toBe('Ada (you)')
    expect(memberLabel(m({ displayName: 'Ada' }), 'someone-else')).toBe('Ada')
  })
})
