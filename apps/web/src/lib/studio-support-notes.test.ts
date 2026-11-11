import { describe, it, expect } from 'vitest'
import type { StudioDetail, StudioSupportView } from './studio'
import { reloadsOn } from './studio'
import { SUPPORT_LABEL, lastConversational, messageIsViewers, messageLabel, noteCaption, supportTargets } from './studio-support'
import { notificationText } from './notifications'

const support = (over: Partial<StudioSupportView> = {}): StudioSupportView => ({
  ownerId: 'u1', ownerName: 'Olive Owner', ownerEmail: 'olive@example.com', trial: false, ...over,
})
const owner = { support: null } as unknown as Pick<StudioDetail, 'support'>
const admin = { support: support() } as Pick<StudioDetail, 'support'>
const note = { role: 'note' as const, agent: null, support: true, sender: null }

describe('support notes', () => {
  it('a note is Virvi support’s: on the right and addressed for support, on the left for the people on the design', () => {
    expect(messageLabel(note, owner)).toBe(SUPPORT_LABEL)
    expect(messageLabel(note, admin)).toBe(`${SUPPORT_LABEL} · to Olive Owner`)
    expect(messageIsViewers(note, owner)).toBe(false)
    expect(messageIsViewers(note, admin)).toBe(true)
  })
  it('tells support the agent reads it later; says nothing to the people on the design', () => {
    expect(noteCaption(admin)).toBe('Not sent to the agent: it reads this with the next prompt.')
    expect(noteCaption(owner)).toBeNull()
  })
  it('the composer’s two targets name the owner', () => {
    expect(supportTargets(support())).toEqual({ agent: 'To the agent', people: 'To Olive Owner only' })
    expect(supportTargets(support({ ownerName: null, ownerEmail: null, trial: true })).people).toBe('To a free-trial visitor only')
  })
  it('the last message that matters for the proposal picker skips notes', () => {
    const msgs: { role: 'agent' | 'note'; id: string }[] = [{ role: 'agent', id: 'a' }, { role: 'note', id: 'n' }]
    expect(lastConversational(msgs)?.id).toBe('a')
    expect(lastConversational(msgs.slice(1))).toBeUndefined()
  })
  it('a new note re-reads the design', () => {
    expect(reloadsOn({ type: 'message' })).toBe(true)
  })
  it('the bell says support wrote, and how often', () => {
    const base = { kind: 'studio_support_note', gone: false, open: false }
    expect(notificationText({ ...base, data: { designId: 'd1', designName: 'Cap', count: 1 } }))
      .toEqual({ text: 'Virvi support sent you a message on Cap', href: '/studio/d1' })
    expect(notificationText({ ...base, data: { designId: 'd1', designName: 'Cap', count: 3 } }).text)
      .toBe('Virvi support sent you 3 messages on Cap')
  })
})
