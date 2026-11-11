import { describe, it, expect } from 'vitest'
import type { StudioDetail, StudioSupportView } from './studio'
import { HELP_WAITING, SUPPORT_LABEL, helpState, lastConversational, messageIsViewers, messageLabel } from './studio-support'
import { notificationText } from './notifications'

const support: StudioSupportView = { ownerId: 'u1', ownerName: 'Olive Owner', ownerEmail: 'olive@example.com', trial: false }
const asOwner = { support: null } as unknown as Pick<StudioDetail, 'support'>
const asAdmin = { support } as Pick<StudioDetail, 'support'>
const help = (userId: string, displayName: string) => ({ role: 'help' as const, agent: null, support: false, sender: { userId, displayName } })

describe('the Help button: asking Virvi support to step in', () => {
  it('shows for the owner and collaborators, not for viewers or support', () => {
    expect(helpState({ support: undefined, role: 'owner', help: null })).toEqual({ show: true, open: false })
    expect(helpState({ support: undefined, role: 'collaborator', help: null }).show).toBe(true)
    expect(helpState({ support: undefined, role: 'viewer', help: null }).show).toBe(false)
    expect(helpState({ support, role: null, help: null } as never).show).toBe(false)
  })
  it('an open request replaces the button with the line saying support will reply', () => {
    expect(helpState({ support: undefined, role: 'owner', help: { id: 'h', createdAt: '' } })).toEqual({ show: true, open: true })
    expect(helpState({ support, role: null, help: { id: 'h', createdAt: '' } } as never).open).toBe(true)
    expect(HELP_WAITING).toContain('will reply here')
  })
  it('the request shows as the asker’s words, labelled as asking support', () => {
    expect(messageLabel(help('u1', 'Olive Owner'), asOwner, 'u1')).toBe(`You · asked ${SUPPORT_LABEL} for help`)
    expect(messageLabel(help('u2', 'Cole'), asOwner, 'u1')).toBe(`Cole · asked ${SUPPORT_LABEL} for help`)
    expect(messageLabel(help('u1', 'Olive Owner'), asAdmin)).toBe(`Olive Owner · asked ${SUPPORT_LABEL} for help`)
    expect(messageIsViewers(help('u1', 'Olive Owner'), asOwner, 'u1')).toBe(true)
    expect(messageIsViewers(help('u2', 'Cole'), asOwner, 'u1')).toBe(false)
    expect(messageIsViewers(help('u1', 'Olive Owner'), asAdmin)).toBe(false)
  })
  it('the proposal picker and first-prompt help skip it', () => {
    const msgs: { role: 'agent' | 'help'; id: string }[] = [{ role: 'agent', id: 'a' }, { role: 'help', id: 'h' }]
    expect(lastConversational(msgs)?.id).toBe('a')
  })
  it('support’s bell names who asked and on which design', () => {
    expect(notificationText({ kind: 'studio_help', gone: false, open: false, data: { designId: 'd1', designName: 'Cap', requesterName: 'Olive' } }))
      .toEqual({ text: 'Olive asked for help on Cap', href: '/studio/d1' })
  })
})
