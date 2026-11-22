import { describe, it, expect } from 'vitest'
import {
  canRate, canTryAgain, draftKind, finalizeOffer, finalizeThis, lastFullWeek, leaderLine, lessonFits, lessonState, ratingBody, ratingSummary, ratingsQuery, rateLabel,
  revisionUnder, shiftWeek, skillLesson, startingAgent, weekLabel, weekStartOf, type StudioRevision,
} from './studio-ratings'
import type { Quote, StudioMessage } from './studio'

const msg = (id: string, role: StudioMessage['role'], jobId: string | null): StudioMessage =>
  ({ id, role, agent: role === 'agent' ? 'claude' : null, text: id, proposal: null, jobId, createdAt: '2026-11-08T00:00:00Z' })
const rev = (over: Partial<StudioRevision> = {}): StudioRevision =>
  ({ jobId: 'j1', categories: ['hat'], rating: null, tags: [], note: null, tryAgain: null, ...over })

describe('where a rating sits', () => {
  it('under the last non-user message of its revision’s job, once', () => {
    const messages = [msg('u1', 'user', null), msg('a1', 'agent', 'j1'), msg('s1', 'system', 'j1'), msg('a2', 'agent', 'j2')]
    const detail = { messages, revisions: [rev()] }
    expect(revisionUnder(messages[1], detail)).toBeNull()
    expect(revisionUnder(messages[2], detail)?.jobId).toBe('j1')
    expect(revisionUnder(messages[3], detail)).toBeNull() // j2 changed nothing
    expect(revisionUnder(messages[0], detail)).toBeNull()
    expect(revisionUnder(messages[2], { messages })).toBeNull() // an older server sends no revisions
  })

  it('the owner rates; support only sees what the owner said', () => {
    expect(canRate({})).toBe(true)
    expect(canRate({ support: { ownerId: 'o', ownerName: 'Olive', ownerEmail: null, trial: false } })).toBe(false)
    // LIV-159: a collaborator rates their own way; a viewer doesn't
    expect(canRate({ role: 'collaborator' })).toBe(true)
    expect(canRate({ role: 'viewer' })).toBe(false)
    expect(ratingSummary(rev())).toBeNull()
    expect(ratingSummary(rev({ rating: 'up' }))).toBe('The owner rated this 👍')
    expect(ratingSummary(rev({ rating: 'down', tags: ['broken', 'size'], note: 'Too big' })))
      .toBe('The owner rated this 👎: Looks broken or clipping, Wrong size or position. “Too big”')
  })
})

describe('rating bodies and Finalize this', () => {
  it('a 👍 sends no tags; a 👎 its tags in a fixed order and a trimmed note', () => {
    expect(ratingBody('up', ['broken'], 'x')).toEqual({ rating: 'up' })
    expect(ratingBody('down', ['slow', 'broken', 'junk'], '  big  ')).toEqual({ rating: 'down', tags: ['broken', 'slow'], note: 'big' })
    expect(ratingBody('down')).toEqual({ rating: 'down', tags: [], note: null })
  })

  it('ticks the revision’s pieces that can be finalized now, or offers nothing', () => {
    const quote = { pieces: [{ category: 'hat', state: 'payable' }, { category: 'mask', state: 'entitled' }, { category: 'feet', state: 'payable' }] } as unknown as Quote
    expect(finalizeThis(['mask', 'hat'], quote)).toEqual(['hat'])
    expect(finalizeThis(['mask'], quote)).toBeNull()
    expect(finalizeThis(['hat'], null)).toBeNull()
  })

  it('offers Finalize this only while the revision is still current, and waits while the agent works', () => {
    const quote = { pieces: [{ category: 'hat', state: 'payable' }, { category: 'mask', state: 'entitled' }] } as unknown as Quote
    expect(finalizeOffer({ categories: ['hat'], current: true }, quote, false)).toEqual({ kind: 'finalize', categories: ['hat'] })
    expect(finalizeOffer({ categories: ['hat'], current: false }, quote, false))
      .toEqual({ kind: 'changed', note: 'This was changed later — finalize uses the latest version.' })
    expect(finalizeOffer({ categories: ['hat'], current: true }, quote, true)).toMatchObject({ kind: 'busy', categories: ['hat'] })
    expect(finalizeOffer({ categories: ['mask'], current: true }, quote, false)).toEqual({ kind: 'none' })
  })

  it('the free try-again goes whenever nothing is running, even out of prompts', () => {
    expect(canTryAgain('out', false)).toBe(true)
    expect(canTryAgain('send', true)).toBe(false)
    expect(canTryAgain('paused', false)).toBe(false)
    expect(canTryAgain('archived', false)).toBe(false)
  })

  it('a new design starts on the admin’s default for its kind, else the page’s own', () => {
    expect(startingAgent('emote', { emote: 'claude', wearable: null }, 'codex')).toBe('claude')
    expect(startingAgent('wearable', { emote: 'claude', wearable: null }, 'codex')).toBe('codex')
    expect(startingAgent('scene', null, 'claude')).toBe('claude')
    expect(startingAgent('scene', { scene: 'gpt' }, 'claude')).toBe('claude')
  })
})

describe('the admin page', () => {
  it('builds the queue query from the filters that are set', () => {
    expect(ratingsQuery({})).toBe('')
    expect(ratingsQuery({ kind: 'emote', handled: 'false', tag: '', model: ' gpt-x ', cursor: 'abc' })).toBe('?kind=emote&model=gpt-x&handled=false&cursor=abc')
  })

  it('drafts a lesson from 👎s of one kind only', () => {
    expect(draftKind([])).toEqual({ problem: 'Tick the 👎s to draft a lesson from.' })
    expect(draftKind([{ kind: 'emote' }, { kind: 'emote' }])).toEqual({ kind: 'emote' })
    expect(draftKind([{ kind: 'emote' }, { kind: 'wearable' }])).toHaveProperty('problem')
  })

  it('says when there aren’t enough ratings to judge, and who leads', () => {
    const few = { agent: 'codex', model: 'gpt-x', up: 3, down: 1, total: 4, rate: 0.75, enough: false }
    expect(rateLabel(few, 20)).toBe('4 of 20 ratings: not enough ratings yet')
    expect(rateLabel({ ...few, total: 25, enough: true }, 20)).toBe('75% 👍 of 25')
    expect(leaderLine({ kind: 'emote', rows: [], leader: null })).toBe('Emote: no ratings yet')
    expect(leaderLine({ kind: 'emote', rows: [few], leader: null })).toBe('Emote: not enough ratings yet to name a leader')
    expect(leaderLine({ kind: 'wearable', rows: [few], leader: { agent: 'codex', model: 'gpt-x', rate: 0.8 } })).toBe('Wearable: Codex · gpt-x leads at 80% 👍')
  })

  it('picks weeks by their Monday, UTC', () => {
    expect(weekStartOf(new Date('2026-11-08T23:00:00Z'))).toBe('2026-11-02')
    expect(lastFullWeek(new Date('2026-11-09T01:00:00Z'))).toBe('2026-11-02')
    expect(shiftWeek('2026-11-02', -1)).toBe('2026-10-26')
    expect(shiftWeek('2026-12-28', 1)).toBe('2027-01-04')
    expect(weekLabel('2026-11-02')).toBe('Nov 2 – Nov 8, 2026')
  })

  it('keeps lessons within their kind’s room, and copies one as a skill lesson', () => {
    const list = { used: { emote: 3900 }, limit: 4000 }
    expect(lessonFits(list, { kind: 'emote', live: false, text: '' }, 'x'.repeat(100))).toBe(true)
    expect(lessonFits(list, { kind: 'emote', live: false, text: '' }, 'x'.repeat(101))).toBe(false)
    expect(lessonFits(list, { kind: 'emote', live: true, text: 'y'.repeat(200) }, 'x'.repeat(300))).toBe(true)
    expect(lessonState({ status: 'draft', enabled: true })).toBe('Draft: not sent to the agent')
    expect(lessonState({ status: 'approved', enabled: false })).toBe('Off')
    expect(skillLesson('scene', ' Keep doorways 2 m tall. ')).toBe('- **Building or furniture:** Keep doorways 2 m tall.')
  })
})
