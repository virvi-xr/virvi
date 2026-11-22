import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SummitSections } from './SummitSections'
import { SummitForm } from './SummitForm'
import { SummitDone } from './SummitForm'

describe('the Summit page', () => {
  const html = renderToStaticMarkup(createElement(SummitSections))

  it('shows the event facts, with the city but never a street address', () => {
    expect(html).toContain('Virvi Launch Summit')
    expect(html).toContain('Create once. Live everywhere.')
    expect(html).toContain('Wednesday 3 – Thursday 4 February 2027')
    expect(html).toContain('Livication Studios, Melbourne, Florida')
    expect(html).toContain('href="#sign-up"')
    expect(html).not.toMatch(/\d+\s+\w+\s+(Street|St\.|Avenue|Ave|Road|Rd|Blvd|Drive|Dr)\b/)
  })

  it('lists the seven offerings with their sessions, the three ways to join and the agenda', () => {
    for (const name of ['Virvi Studio', 'Virvi Sync', 'Virvi Events', 'Virvi Drops', 'Virvi AR', 'Virvi Cities', 'Virvi OS']) expect(html).toContain(name)
    expect(html).toContain('Thu 4 Feb · 10:15')
    expect(html).toContain('Three ways to join')
    expect(html).toContain('the full address goes only to confirmed guests')
    expect(html).toContain('a check-in Drop')
    expect(html).toContain('Agenda may change')
    expect(html).toContain('Keynote: Create once. Live everywhere.')
    expect(html).toContain('Day 1 wrap')
    expect(html).toContain('EST')
  })

  it('uses typographic apostrophes in visible text', () => {
    expect(html).not.toContain('&#x27;')
  })
})

describe('the Summit sign-up form', () => {
  const html = renderToStaticMarkup(createElement(SummitForm))

  it('asks for email, name, how you’ll join and interests, with a required consent box linking to privacy', () => {
    expect(html).toContain('id="sign-up"')
    expect(html).toMatch(/type="email"[^>]*required/)
    expect(html).toContain('value="online"')
    expect(html).toContain('value="in_person"')
    expect(html).toContain('value="watch_party"')
    for (const id of ['studio', 'sync', 'events', 'drops', 'ar', 'cities', 'os']) expect(html).toContain(`value="${id}"`)
    expect(html).toContain('Email me about the Virvi Summit. You can unsubscribe at any time.')
    expect(html).toContain('href="/privacy/"')
    expect(html).toContain('name="nickname"')
    expect(html).not.toContain('&#x27;')
  })

  it('the done state says what happens next for the choice', () => {
    const done = (joinAs: 'online' | 'in_person' | 'watch_party') => renderToStaticMarkup(createElement(SummitDone, { joinAs }))
    expect(done('online')).toContain('You’re on the list.')
    expect(done('online')).toContain('We’ll email you the links before the day.')
    expect(done('in_person')).toContain('We’ll email you to confirm your place.')
    expect(done('watch_party')).toContain('We’ll email you the host kit.')
  })
})
