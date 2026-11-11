import { describe, it, expect } from 'vitest'
import { badgeText, inviteActionable, notificationText, senderNames } from './notifications'

const base = { gone: false, open: false }

describe('notificationText', () => {
  it('names who invited you, linking the Studio page', () => {
    expect(notificationText({ ...base, open: true, kind: 'studio_invite', data: { inviteId: 'i', designId: 'd1', designName: 'Red cap', inviterName: 'Sam', role: 'viewer' } }))
      .toEqual({ text: 'Sam invited you to Red cap', href: '/studio' })
  })
  it('keeps an answered invite you are on as the invite line, linking the design', () => {
    expect(notificationText({ ...base, kind: 'studio_invite', data: { inviteId: 'i', designId: 'd1', designName: 'Red cap', inviterName: 'Sam', role: 'viewer' } }))
      .toEqual({ text: 'Sam invited you to Red cap', href: '/studio/d1' })
  })
  it('says one sender sent a prompt', () => {
    expect(notificationText({ ...base, kind: 'studio_prompts', data: { designId: 'd1', designName: 'Red cap', senders: ['Sam'], count: 1 } }))
      .toEqual({ text: 'Sam sent a prompt on Red cap', href: '/studio/d1' })
  })
  it('counts several prompts', () => {
    expect(notificationText({ ...base, kind: 'studio_prompts', data: { designId: 'd1', designName: 'Red cap', senders: ['Sam', 'Alex'], count: 3 } }).text)
      .toBe('Sam and Alex sent 3 prompts on Red cap')
  })
  it('counts several prompts from one sender', () => {
    expect(notificationText({ ...base, kind: 'studio_prompts', data: { designId: 'd1', designName: 'Red cap', senders: ['Sam'], count: 2 } }).text)
      .toBe('Sam sent 2 prompts on Red cap')
  })
  it('says a package is ready, with the category label', () => {
    expect(notificationText({ ...base, kind: 'studio_package_ready', data: { designId: 'd1', designName: 'Red cap', category: 'upper_body' } }))
      .toEqual({ text: 'The upper body package for Red cap is ready to download', href: '/studio/d1' })
  })
  it('says you are the owner now', () => {
    expect(notificationText({ ...base, kind: 'studio_owner', data: { designId: 'd1', designName: 'Red cap' } }))
      .toEqual({ text: "You're now the owner of Red cap", href: '/studio/d1' })
  })
  it('says a gone item is no longer shared, with no link', () => {
    for (const kind of ['studio_invite', 'studio_prompts', 'studio_package_ready', 'studio_owner']) {
      expect(notificationText({ gone: true, open: false, kind, data: { designId: 'd1', designName: 'Red cap', inviterName: 'Sam' } }))
        .toEqual({ text: 'Red cap is no longer shared with you', href: null })
    }
  })
})

describe('inviteActionable', () => {
  it('shows Accept and Decline only for an open invite', () => {
    const inv = { kind: 'studio_invite', gone: false }
    expect(inviteActionable({ ...inv, open: true })).toBe(true)
    expect(inviteActionable({ ...inv, open: false })).toBe(false)
    expect(inviteActionable({ kind: 'studio_invite', gone: true, open: false })).toBe(false)
    expect(inviteActionable({ kind: 'studio_prompts', gone: false, open: false })).toBe(false)
  })
})

describe('senderNames', () => {
  it('lists one, two, and more', () => {
    expect(senderNames(['Sam'])).toBe('Sam')
    expect(senderNames(['Sam', 'Alex'])).toBe('Sam and Alex')
    expect(senderNames(['Sam', 'Alex', 'Kim', 'Lee'])).toBe('Sam, Alex and 2 others')
    expect(senderNames(['Sam', 'Alex', 'Kim'])).toBe('Sam, Alex and 1 other')
  })
})

describe('badgeText', () => {
  it('hides at 0, shows up to 9, then 9+', () => {
    expect(badgeText(0)).toBeNull()
    expect(badgeText(1)).toBe('1')
    expect(badgeText(9)).toBe('9')
    expect(badgeText(10)).toBe('9+')
  })
})
