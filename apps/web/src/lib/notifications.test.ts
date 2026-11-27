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

describe('scene update and moderation notices (LIV-30)', () => {
  const base = { gone: false, open: false }
  it('a scene behind the latest release says how to update', () => {
    expect(notificationText({ ...base, kind: 'scene_update', data: { sceneId: 's1', sceneName: 'Club', latest: '2.23.0', virviDeploys: true } }))
      .toEqual({ text: 'Club can update to Virvi 2.23.0. Redeploy it to update.', href: '/scenes/s1' })
    expect(notificationText({ ...base, kind: 'scene_update', data: { sceneId: 's1', sceneName: 'Club', latest: '2.23.0', virviDeploys: false } }).text)
      .toBe('Club can update to Virvi 2.23.0. Update @virvixr/dcl in its project and deploy it.')
  })
  it('takedowns and appeal outcomes', () => {
    expect(notificationText({ ...base, kind: 'model_taken_down', data: { assetName: 'Chair', reason: 'Copyright claim' } }))
      .toEqual({ text: 'Virvi took down your model Chair: Copyright claim. You can appeal.', href: '/assets/' })
    expect(notificationText({ ...base, kind: 'model_appeal', data: { assetName: 'Chair', decision: 'restored' } }).text).toBe('Your appeal was accepted: Chair can be shared again')
    expect(notificationText({ ...base, kind: 'model_appeal', data: { assetName: 'Chair', decision: 'rejected', response: 'It breaks the rules.' } }).text)
      .toBe('Your appeal for Chair was turned down: It breaks the rules.')
  })
})

describe('BEAT and giveaway notices (LIV-30)', () => {
  const base = { gone: false, open: false }
  it("says the BEAT is in the wallet and links to the wallet's page", () => {
    const w = '0x' + 'ab'.repeat(20)
    const r = notificationText({ ...base, kind: 'beat_minted', data: { beatName: 'Friday gig', wallet: w } })
    expect(r.text).toBe(`Your BEAT Friday gig is in your wallet ${w.slice(0, 6)}…${w.slice(-4)}`)
    expect(r.href).toMatch(/^\/w\/0x/i)
    expect(notificationText({ ...base, kind: 'beat_minted', data: { beatName: 'Gig', wallet: 'nope' } })).toEqual({ text: 'Your BEAT Gig is in your wallet', href: null })
  })
  it('says a giveaway item was sent, and links to the collection', () => {
    expect(notificationText({ ...base, kind: 'giveaway_sent', data: { giveawayName: 'Hat drop' } }))
      .toEqual({ text: 'Hat drop: your item was sent to your wallet. It shows in Decentraland once it settles.', href: '/collection' })
  })
})
