import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SUMMIT_INTERESTS } from '@virvixr/shared'
import { SUMMIT_TRACKS } from '@/lib/summit'
import { SummitSections } from './SummitSections'
import { SummitDone, SummitForm } from './SummitForm'

/** The HTML between a track's heading and the next track's heading (or the end). */
function trackBlock(html: string, track: string, next?: string): string {
  const start = html.indexOf(track)
  expect(start, track).toBeGreaterThan(-1)
  const end = next ? html.indexOf(next, start + 1) : html.length
  return html.slice(start, end > -1 ? end : html.length)
}

describe('the Summit data', () => {
  it('has two tracks, seven offerings in interest order, and no Virvi OS', () => {
    expect(SUMMIT_TRACKS.map((t) => t.name)).toEqual(['Creator track', 'Community track'])
    expect(SUMMIT_TRACKS.flatMap((t) => t.offerings.map((o) => o.id))).toEqual([...SUMMIT_INTERESTS])
    expect(JSON.stringify(SUMMIT_TRACKS)).not.toMatch(/Virvi OS/)
  })
})

describe('the Summit page', () => {
  const html = renderToStaticMarkup(createElement(SummitSections))

  it('shows the event facts, with the city but never a street address', () => {
    expect(html).toContain('Virvi Launch Summit')
    expect(html).toContain('Create once. Live everywhere.')
    expect(html).toContain('Two days, two tracks: Creator on Wednesday, Community on Thursday.')
    expect(html).toContain('Wednesday 3 – Thursday 4 February 2027')
    expect(html).toContain('Livication Studios, Melbourne, Florida')
    expect(html).toContain('href="#sign-up"')
    expect(html).not.toMatch(/\d+\s+\w+\s+(Street|St\.|Avenue|Ave|Road|Rd|Blvd|Drive|Dr)\b/)
  })

  it('groups the seven offerings under their tracks, with sessions', () => {
    const offerings = html.slice(html.indexOf('id="summit-offerings"'), html.indexOf('id="summit-ways"'))
    expect(offerings).toContain('Seven things, shown live')
    const creator = trackBlock(offerings, 'Creator track', 'Community track')
    const community = trackBlock(offerings, 'Community track')
    expect(creator).toContain('Make things with AI, run one scene in every world, and step into it in AR.')
    expect(community).toContain('Bring people together, give them something to keep, and find your city.')
    for (const name of ['Virvi Studio', 'Virvi Sync', 'Virvi AR']) {
      expect(creator, name).toContain(name)
      expect(community, name).not.toContain(name)
    }
    for (const name of ['Virvi Events', 'Virvi Drops', 'Virvi BEAT', 'Virvi Cities']) {
      expect(community, name).toContain(name)
      expect(creator, name).not.toContain(name)
    }
    expect(creator).toMatch(/Virvi AR<\/h4>.*Wed 3 Feb · 15:45/)
    expect(community).toMatch(/Virvi BEAT<\/h4>.*Thu 4 Feb · 11:30/)
    expect(community).toContain('Attendance tokens for any event. Everyone claims one live.')
    expect(community).toContain('Giveaways and rewards for showing up.')
  })

  it('has the three ways to join and the agenda by track', () => {
    expect(html).toContain('Three ways to join')
    expect(html).toContain('the full address goes only to confirmed guests')
    expect(html).toContain('a check-in Drop')
    expect(html).toContain('Agenda may change')
    expect(html).toContain('EST')
    const agenda = html.slice(html.indexOf('id="summit-agenda"'))
    const wed = trackBlock(agenda, 'Wednesday 3 February · Creator track', 'Thursday 4 February · Community track')
    const thu = trackBlock(agenda, 'Thursday 4 February · Community track')
    expect(wed).toContain('Keynote: Create once. Live everywhere.')
    expect(wed).toMatch(/15:45<\/span><span[^>]*>Virvi AR</)
    expect(wed).toContain('Day 1 wrap')
    expect(thu).toMatch(/10:15<\/span><span[^>]*>Virvi Events &amp; Drops</)
    expect(thu).toMatch(/11:30<\/span><span[^>]*>Virvi BEAT</)
    expect(thu).toMatch(/13:30<\/span><span[^>]*>Virvi Cities</)
    expect(thu).toMatch(/14:30<\/span><span[^>]*>Closing: the roadmap, Q&amp;A and the final Drop</)
  })

  it('never mentions Virvi OS, and uses typographic apostrophes in visible text', () => {
    expect(html).not.toContain('Virvi OS')
    expect(html).not.toContain('&#x27;')
  })
})

describe('the Summit sign-up form', () => {
  const html = renderToStaticMarkup(createElement(SummitForm))

  it('asks for email, name, how you’ll join and interests by track, with a required consent box linking to privacy', () => {
    expect(html).toContain('id="sign-up"')
    expect(html).toMatch(/type="email"[^>]*required/)
    expect(html).toContain('value="online"')
    expect(html).toContain('value="in_person"')
    expect(html).toContain('value="watch_party"')
    for (const id of ['studio', 'sync', 'ar', 'events', 'drops', 'beat', 'cities']) expect(html).toContain(`value="${id}"`)
    expect(html).not.toContain('value="os"')
    expect(html).not.toContain('Virvi OS')
    const creator = trackBlock(html, 'Creator track', 'Community track')
    expect(creator).toContain('value="ar"')
    expect(creator).not.toContain('value="beat"')
    expect(trackBlock(html, 'Community track')).toContain('value="beat"')
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
