import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AdminSummitSignup, AdminSummitTotals } from '@virvixr/shared'
import { AdminSummit } from './AdminSummit'

const s = (over: Partial<AdminSummitSignup>): AdminSummitSignup => ({
  id: 'x', email: 'ana@example.com', name: 'Ana', joinAs: 'online', partySize: null, city: null, expectedGuests: null, interests: [], source: null,
  inPersonStatus: null, consentAt: '2026-11-20T10:00:00.000Z', createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z', ...over,
})
const totals: AdminSummitTotals = {
  byJoinAs: { online: 4, in_person: 3, watch_party: 2 },
  byInterest: { studio: 5, sync: 0, events: 1, drops: 2, ar: 0, cities: 0, os: 0 },
  bySource: { discord: 6, '(direct)': 3 },
  inPersonPeople: 7,
}
const signups = [
  s({ id: 'p1', name: 'Pat', email: 'pat@example.com', joinAs: 'in_person', partySize: 2, inPersonStatus: 'requested', interests: ['studio', 'drops'], source: 'discord' }),
  s({ id: 'w1', name: '<b>Wes</b>', email: 'wes@example.com', joinAs: 'watch_party', city: 'Lisbon', expectedGuests: 30 }),
  s({ id: 'o1' }),
]
const render = (over: object = {}) => renderToStaticMarkup(createElement(AdminSummit, { signups, totals, onDecide: () => {}, busyId: null, ...over }))

describe('AdminSummit', () => {
  it('shows the totals: online, in-person requests and people, watch parties, by interest and by source', () => {
    const html = render()
    expect(html).toContain('Online')
    expect(html).toContain('In person')
    expect(html).toContain('3 requests · 7 people')
    expect(html).toContain('Watch parties')
    expect(html).toContain('Virvi Studio: 5')
    expect(html).toContain('Virvi Drops: 2')
    expect(html).toContain('discord: 6')
    expect(html).toContain('No ref: 3')
  })

  it('lists each sign-up with its details, as text', () => {
    const html = render()
    expect(html).toContain('pat@example.com')
    expect(html).toContain('Party of 2 · requested')
    expect(html).toContain('Lisbon · 30 guests')
    expect(html).toContain('Virvi Studio, Virvi Drops')
    expect(html).toContain('&lt;b&gt;Wes&lt;/b&gt;')
    expect(html).not.toContain('<b>Wes</b>')
  })

  it('only in-person rows get Confirm and Decline', () => {
    const html = render()
    expect(html.match(/>Confirm</g)).toHaveLength(1)
    expect(html.match(/>Decline</g)).toHaveLength(1)
  })

  it('a confirmed place offers Decline, a declined one Confirm', () => {
    const html = render({ signups: [s({ joinAs: 'in_person', partySize: 1, inPersonStatus: 'confirmed' })] })
    expect(html).not.toMatch(/>Confirm</)
    expect(html).toMatch(/>Decline</)
    const declined = render({ signups: [s({ joinAs: 'in_person', partySize: 1, inPersonStatus: 'declined' })] })
    expect(declined).toMatch(/>Confirm</)
    expect(declined).not.toMatch(/>Decline</)
  })

  it('says so when no one has signed up', () => {
    expect(render({ signups: [] })).toContain('No one has signed up yet.')
  })
})
