import { describe, it, expect } from 'vitest'
import { composerState, SUPPORT_NOTE, type StudioDetail, type StudioSupportView, type StudioUsage } from './studio'
import {
  SUPPORT_LABEL, adminDesignOwner, adminDesignsQuery, designControls, messageIsViewers, messageLabel, pieceCountLabel, supportBanner,
  supportFinalizeLabel, supportOwnerName,
} from './studio-support'

const NOW = new Date('2026-11-08T12:00:00Z')
const support = (over: Partial<StudioSupportView> = {}): StudioSupportView => ({
  ownerId: 'u1', ownerName: 'Olive Owner', ownerEmail: 'olive@example.com', trial: false, ...over,
})
const detail = (over: Partial<StudioDetail> = {}): StudioDetail => ({
  design: { id: 'd1', name: 'Cap', kind: 'wearable', agent: 'claude', status: 'idle', archivedAt: null, lastJobAt: null, finalizedAt: null, createdAt: NOW.toISOString() },
  pieces: [], messages: [], activeJob: null, lastPrompt: null, uploads: [],
  set: { revisions: '', views: {}, checks: [], freeFixesLeft: {} }, ...over,
})
const usage = (over: Partial<StudioUsage> = {}): StudioUsage => ({
  plan: 'free', promptsLeft: 3, credits: 0, allowance: 3, resetsAt: NOW.toISOString(), openDesigns: 1, openDesignLimit: 1,
  topup: { cents: 500, prompts: 10 }, paused: false, giftedPrompts: 0, freeFinalizes: { available: 0, held: 0 }, ...over,
})

describe('supportOwnerName and supportBanner', () => {
  it('names the owner by name, then email, then the kind of account', () => {
    expect(supportOwnerName(support())).toBe('Olive Owner')
    expect(supportOwnerName(support({ ownerName: '  ' }))).toBe('olive@example.com')
    expect(supportOwnerName(support({ ownerName: null, ownerEmail: null, trial: true }))).toBe('a free-trial visitor')
    expect(supportOwnerName(support({ ownerName: null, ownerEmail: null }))).toBe('this person')
  })
  it('says whose design it is and that it is support’s view', () => {
    expect(supportBanner(support())).toBe('You’re viewing Olive Owner’s design as Virvi support. Your messages show in their conversation as Virvi support, and nothing you send or finalize is charged.')
    expect(supportBanner(support({ ownerName: null, ownerEmail: null, trial: true }))).toContain('You’re viewing a free-trial visitor’s design as Virvi support. It’s a free-trial design.')
  })
})

describe('messageLabel and messageIsViewers', () => {
  const owner = detail()
  const admin = detail({ support: support() })
  it('labels support’s messages Virvi support, for the owner and the admin', () => {
    const m = { role: 'user' as const, agent: null, support: true }
    expect(messageLabel(m, owner)).toBe(SUPPORT_LABEL)
    expect(messageLabel(m, admin)).toBe(SUPPORT_LABEL)
    expect(messageIsViewers(m, owner)).toBe(false)
    expect(messageIsViewers(m, admin)).toBe(true)
  })
  it('leaves the owner’s own words unlabelled for them, and names the owner for support', () => {
    const m = { role: 'user' as const, agent: null, support: false }
    expect(messageLabel(m, owner)).toBeNull()
    expect(messageLabel(m, admin)).toBe('Olive Owner')
    expect(messageIsViewers(m, owner)).toBe(true)
    expect(messageIsViewers({ role: 'user' }, owner)).toBe(true) // an older reply without the flag
    expect(messageIsViewers(m, admin)).toBe(false)
  })
  it('names the agent for its replies and nobody for system notes', () => {
    expect(messageLabel({ role: 'agent', agent: 'claude' }, admin)).toBe('Claude Code')
    expect(messageLabel({ role: 'system', agent: null }, admin)).toBeNull()
    expect(messageIsViewers({ role: 'agent' }, owner)).toBe(false)
  })
})

describe('designControls', () => {
  it('gives the owner every control', () => {
    expect(designControls(detail())).toEqual({ designMenu: true, switchAgent: true, uploads: true, reports: true, topup: true })
  })
  it('keeps renaming, archiving, the agent, files, reports and buying prompts the owner’s', () => {
    expect(designControls(detail({ support: support() }))).toEqual({ designMenu: false, switchAgent: false, uploads: false, reports: false, topup: false })
  })
})

describe('composerState for support', () => {
  it('shows no allowance meter, and the admin’s own usage never stops them', () => {
    const d = detail({ support: support() })
    expect(composerState(d, usage({ promptsLeft: 0 }), NOW)).toEqual({ mode: 'send', note: SUPPORT_NOTE })
    expect(composerState(d, usage({ paused: true }), NOW).mode).toBe('send')
    expect(composerState(d, null, NOW)).toEqual({ mode: 'send', note: SUPPORT_NOTE })
  })
  it('still waits for a running prompt, offers Continue, and leaves unarchiving to the owner', () => {
    expect(composerState(detail({ support: support(), activeJob: { id: 'j', type: 'prompt', status: 'taken' } }), null, NOW).mode).toBe('busy')
    expect(composerState(detail({ support: support(), lastPrompt: { jobId: 'j', outcome: 'turns', status: 'done' } }), null, NOW).mode).toBe('continue')
    expect(composerState(detail({ support: support(), design: { ...detail().design, archivedAt: NOW.toISOString() } }), null, NOW))
      .toEqual({ mode: 'archived', note: 'This design is archived. Only its owner can unarchive it.' })
  })
})

describe('supportFinalizeLabel', () => {
  it('finalizes for the owner, free', () => {
    expect(supportFinalizeLabel(support(), false)).toBe('Finalize for Olive Owner (free)')
    expect(supportFinalizeLabel(support(), true)).toBe('Finalizing…')
  })
})

describe('the admin list of designs', () => {
  it('builds the query from what is set', () => {
    expect(adminDesignsQuery({})).toBe('')
    expect(adminDesignsQuery({ q: '  olive ', kind: 'emote', cursor: 'abc' })).toBe('?q=olive&kind=emote&cursor=abc')
    expect(adminDesignsQuery({ q: 'a&b', kind: '' })).toBe('?q=a%26b')
  })
  it('names the owner, a trial as a free-trial visitor', () => {
    const o = { id: 'u1', name: 'Olive', email: 'olive@example.com', wallet: null, trial: false }
    expect(adminDesignOwner({ owner: o })).toEqual({ name: 'Olive', detail: 'olive@example.com' })
    expect(adminDesignOwner({ owner: { ...o, name: '', email: null, wallet: '0x1234567890abcdef1234567890abcdef12345678' } })).toEqual({ name: '0x1234…5678', detail: null })
    expect(adminDesignOwner({ owner: { ...o, trial: true, email: null } })).toEqual({ name: 'Free-trial visitor', detail: null })
  })
  it('counts pieces', () => {
    expect([0, 1, 4].map(pieceCountLabel)).toEqual(['No pieces yet', '1 piece', '4 pieces'])
  })
})
