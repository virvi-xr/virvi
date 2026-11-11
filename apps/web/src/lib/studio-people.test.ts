import { describe, it, expect } from 'vitest'
import {
  VIEWER_NOTE, acceptRefusal, boxState, canAct, inviteExpiry, inviteStatusCopy, inviteTarget, inviteTokenFromPath, invitee, isInvitePath, peopleRefusal,
  promptSenderId, resendDone, roleLabel, senderLabel, shortWallet, splitDesigns,
} from './studio-people'
import type { StudioDesign, StudioMessage } from './studio'

const ME = '11111111-1111-4111-8111-111111111111'
const SAM = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-11-10T12:00:00Z')

const msg = (over: Partial<StudioMessage> = {}): StudioMessage => ({
  id: 'm1', role: 'user', agent: null, text: 'a red cap', proposal: null, jobId: null, createdAt: NOW.toISOString(), ...over,
})

describe('canAct', () => {
  it('lets the owner and collaborators act, not viewers', () => {
    expect(canAct('owner')).toBe(true)
    expect(canAct('collaborator')).toBe(true)
    expect(canAct('viewer')).toBe(false)
  })
  it('lets Virvi support (no role) and a design from before roles act', () => {
    expect(canAct(null)).toBe(true)
    expect(canAct(undefined)).toBe(true)
  })
})

describe('boxState', () => {
  const job = (over: { senderName?: string | null; senderId?: string | null; type?: string } = {}) => ({ type: 'prompt', senderName: 'Sam', senderId: SAM, ...over })
  it('is open with no job, or with a render running', () => {
    expect(boxState('owner', null, ME)).toBe('open')
    expect(boxState('collaborator', job({ type: 'render' }), ME)).toBe('open')
  })
  it('is the viewer state for a viewer, job or not', () => {
    expect(boxState('viewer', null, ME)).toBe('viewer')
    expect(boxState('viewer', job(), ME)).toBe('viewer')
  })
  it('names whose prompt the agent is on: mine, or someone else’s', () => {
    expect(boxState('owner', job({ senderId: ME, senderName: 'Me' }), ME)).toEqual({ busyFor: 'Working on your prompt' })
    expect(boxState('owner', job(), ME)).toEqual({ busyFor: 'Working on Sam’s prompt' })
    expect(boxState('collaborator', job(), ME)).toEqual({ busyFor: 'Working on Sam’s prompt' })
  })
  it('has a line for a sender with no name, and for support’s prompt', () => {
    expect(boxState('owner', job({ senderName: null }), ME)).toEqual({ busyFor: 'Working on someone else’s prompt' })
    expect(boxState('owner', job({ senderName: null, senderId: null }), ME)).toEqual({ busyFor: 'Working on someone else’s prompt' })
  })
  it('has the viewer copy', () => {
    expect(VIEWER_NOTE).toBe('You can view this design. Ask the owner to make you a collaborator to send prompts.')
  })
})

describe('promptSenderId', () => {
  it('is the sender of the newest person’s message (the running prompt’s)', () => {
    const messages = [msg({ sender: { userId: ME, displayName: 'Me' } }), msg({ role: 'agent', agent: 'claude' }), msg({ sender: { userId: SAM, displayName: 'Sam' } })]
    expect(promptSenderId(messages)).toBe(SAM)
  })
  it('is null for support’s message, and for messages from before senders were sent', () => {
    expect(promptSenderId([msg({ sender: null, support: true })])).toBeNull()
    expect(promptSenderId([msg()])).toBeNull()
    expect(promptSenderId([])).toBeNull()
  })
})

describe('senderLabel', () => {
  it('says You for my own words and the name for someone else’s', () => {
    expect(senderLabel(msg({ sender: { userId: ME, displayName: 'Me' } }), ME)).toBe('You')
    expect(senderLabel(msg({ sender: { userId: SAM, displayName: 'Sam' } }), ME)).toBe('Sam')
    expect(senderLabel(msg({ sender: { userId: SAM, displayName: '  ' } }), ME)).toBe('Someone')
  })
  it('is null for the agent, system notes, support, and a message without a sender', () => {
    expect(senderLabel(msg({ role: 'agent', agent: 'claude', sender: null }), ME)).toBeNull()
    expect(senderLabel(msg({ role: 'system', sender: null }), ME)).toBeNull()
    expect(senderLabel(msg({ support: true, sender: null }), ME)).toBeNull()
    expect(senderLabel(msg(), ME)).toBeNull()
  })
})

describe('inviteStatusCopy', () => {
  it('has a plain line for an expired or used link, and none for an open one', () => {
    expect(inviteStatusCopy('open')).toBeNull()
    expect(inviteStatusCopy('expired')).toBe('This invite has expired. Ask the owner to send a new one.')
    expect(inviteStatusCopy('used')).toBe('This invite has already been used.')
  })
})

describe('peopleRefusal', () => {
  const err = (code: string, status = 409) => ({ status, body: { error: code, code } })
  it('says what each invite refusal means', () => {
    expect(peopleRefusal(err('already_member'))).toBe('They’re already on this design.')
    expect(peopleRefusal(err('already_invited'))).toBe('They already have an invite to this design.')
    expect(peopleRefusal(err('members_full'))).toBe('This design is full. Remove someone or cancel an invite to make room.')
    expect(peopleRefusal(err('invite_limit', 429))).toBe('You’ve sent today’s invites. Try again tomorrow.')
    expect(peopleRefusal(err('self', 400))).toBe('That’s your own email address.')
    expect(peopleRefusal(err('archived'))).toBe('This design is archived. Unarchive it to invite people.')
    expect(peopleRefusal(err('resend_too_soon', 429))).toBe('This invite was sent less than an hour ago. Try again later.')
    expect(peopleRefusal(err('resend_limit', 429))).toBe('This invite has been sent as many times as it can be. Cancel it and invite them again.')
    expect(peopleRefusal(err('used'))).toBe('This invite has already been used.')
    expect(peopleRefusal(err('expired'))).toBe('This invite has expired. Ask the owner to send a new one.')
  })
  it('asks for an email or a wallet address on the server’s 400, and falls back for anything else', () => {
    expect(peopleRefusal({ status: 400, body: { error: 'email must be an email address' } })).toBe('Enter an email or a wallet address.')
    expect(peopleRefusal({ status: 400, body: { error: 'email or wallet is required, not both' } })).toBe('Enter an email or a wallet address.')
    expect(peopleRefusal({ status: 400, body: { error: 'wallet must be a 0x wallet address' } })).toBe('Enter a full wallet address: 0x and 40 letters or numbers.')
    expect(peopleRefusal({ status: 500, body: { error: 'boom' } })).toBe('Something went wrong. Try again.')
  })
  it('speaks of the wallet when the invite was to one', () => {
    expect(peopleRefusal(err('already_member'), 'wallet')).toBe('That wallet is already on this design.')
    expect(peopleRefusal(err('already_invited'), 'wallet')).toBe('That wallet already has an invite to this design.')
    expect(peopleRefusal(err('self', 400), 'wallet')).toBe('That’s your own wallet.')
    expect(peopleRefusal(err('self', 400), 'email')).toBe('That’s your own email address.')
    expect(peopleRefusal(err('members_full'), 'wallet')).toBe('This design is full. Remove someone or cancel an invite to make room.')
  })
})

const W = '0x1234567890abcdef1234567890abcdef1234abcd'

describe('inviteTarget', () => {
  it('sends a 0x address as a wallet and anything else as an email, trimmed', () => {
    expect(inviteTarget(`  ${W} `)).toEqual({ wallet: W })
    expect(inviteTarget('0X1234567890ABCDEF1234567890ABCDEF1234ABCD')).toEqual({ wallet: '0X1234567890ABCDEF1234567890ABCDEF1234ABCD' })
    expect(inviteTarget('0x123')).toEqual({ wallet: '0x123' })
    expect(inviteTarget(' cora@test.dev ')).toEqual({ email: 'cora@test.dev' })
    expect(inviteTarget('0xcora@test.dev')).toEqual({ email: '0xcora@test.dev' })
    expect(inviteTarget('   ')).toBeNull()
  })
})

describe('shortWallet and invitee', () => {
  it('shortens an address to its start and end', () => {
    expect(shortWallet(W)).toBe('0x1234…abcd')
  })
  it('names an invite by its email, or its wallet shortened with the full address as the title', () => {
    expect(invitee({ email: 'cora@test.dev', wallet: null })).toEqual({ label: 'cora@test.dev', title: undefined })
    expect(invitee({ email: null, wallet: W })).toEqual({ label: '0x1234…abcd', title: W })
    expect(invitee({ email: 'cora@test.dev' })).toEqual({ label: 'cora@test.dev', title: undefined })
  })
  it('says what a resend did: mailed again, or renewed for a wallet', () => {
    expect(resendDone({ email: 'cora@test.dev', wallet: null })).toBe('Sent the invite to cora@test.dev again.')
    expect(resendDone({ email: null, wallet: W })).toBe('Renewed the invite for 0x1234…abcd.')
  })
})

describe('acceptRefusal', () => {
  const err = (code: string, status = 409) => ({ status, body: { error: code, code } })
  it('speaks to the person accepting, not the owner', () => {
    expect(acceptRefusal(err('already_member'))).toEqual({ text: 'You’re already on this design.', openDesign: true })
    expect(acceptRefusal(err('members_full'))).toEqual({ text: 'This design is full. Ask the owner to make room.', openDesign: false })
  })
  it('keeps the invite’s own refusals', () => {
    expect(acceptRefusal(err('expired'))).toEqual({ text: 'This invite has expired. Ask the owner to send a new one.', openDesign: false })
    expect(acceptRefusal(err('used'))).toEqual({ text: 'This invite has already been used.', openDesign: false })
    expect(acceptRefusal({ status: 500, body: {} })).toEqual({ text: 'Something went wrong. Try again.', openDesign: false })
  })
})

describe('roleLabel and inviteExpiry', () => {
  it('names each role', () => {
    expect(['owner', 'collaborator', 'viewer'].map(roleLabel)).toEqual(['Owner', 'Collaborator', 'Viewer'])
  })
  it('says when an invite runs out', () => {
    expect(inviteExpiry(new Date(NOW.getTime() - 1000).toISOString(), NOW)).toBe('Expired')
    expect(inviteExpiry(new Date(NOW.getTime() + 3 * 3600_000).toISOString(), NOW)).toBe('Expires today')
    expect(inviteExpiry(new Date(NOW.getTime() + 30 * 3600_000).toISOString(), NOW)).toBe('Expires in 1 day')
    expect(inviteExpiry(new Date(NOW.getTime() + 14 * 24 * 3600_000).toISOString(), NOW)).toBe('Expires in 14 days')
  })
})

describe('splitDesigns', () => {
  const d = (id: string, over: Partial<StudioDesign> = {}): StudioDesign => ({
    id, name: id, kind: 'wearable', agent: 'claude', status: 'idle', archivedAt: null, lastJobAt: null, finalizedAt: null, createdAt: NOW.toISOString(), ...over,
  })
  it('keeps my own designs apart from the ones shared with me', () => {
    const r = splitDesigns([d('a', { role: 'owner' }), d('b', { role: 'viewer', ownerName: 'Sam' }), d('c'), d('e', { role: 'collaborator', ownerName: null })])
    expect(r.mine.map((x) => x.id)).toEqual(['a', 'c'])
    expect(r.shared.map((x) => x.id)).toEqual(['b', 'e'])
  })
})

describe('the invite link page', () => {
  it('knows its own path, which signs a new visitor up rather than in', () => {
    expect(isInvitePath('/studio/invite/abcdefghijklmnopqrstuvwx/')).toBe(true)
    expect(isInvitePath('/studio/invite/abcdefghijklmnopqrstuvwx')).toBe(true)
    expect(isInvitePath('/studio/')).toBe(false)
    expect(isInvitePath('/studio/11111111-1111-4111-8111-111111111111/')).toBe(false)
  })
  it('reads the token from the address bar (the export has one page, at _)', () => {
    expect(inviteTokenFromPath('/studio/invite/abcdefghijklmnopqrstuvwx/', '_')).toBe('abcdefghijklmnopqrstuvwx')
    expect(inviteTokenFromPath('/studio/invite/x/', 'abcdefghijklmnopqrstuvwx')).toBe('abcdefghijklmnopqrstuvwx')
    expect(inviteTokenFromPath('/studio/invite/_/')).toBeNull()
    expect(inviteTokenFromPath('/studio/invite/short/')).toBeNull()
    expect(inviteTokenFromPath('/studio/invite/bad%20token%20value%20here/')).toBeNull()
  })
})
