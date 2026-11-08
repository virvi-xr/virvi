import { describe, it, expect } from 'vitest'
import {
  canReport, checkoutBody, designBadge, finalizeChoices, initialSelection, latestOnly, selectionCategories, selectionProblem,
  checkoutQuoteRefusal, toggleSelection, wornDetail, wornState, type Quote, type QuoteLine, type StudioDesign, type StudioDetail, type StudioSet,
} from './studio'

/** LIV-81: ticking which pieces to finalize. */

const piece = (category: string, state: Quote['pieces'][number]['state'], kind: 'first' | 'revision' = 'first') =>
  ({ category, name: `Neon ${category}`, revisionNumber: state === 'none' ? 0 : 1, state, kind, checker: null })
const line = (category: string, over: Partial<QuoteLine> = {}): QuoteLine => ({
  category, revisionId: `r-${category}`, revisionNumber: 1, pieceName: `Neon ${category}`, priceKind: 'first', amountCents: 2900, waived: false, ...over,
})
const quote = (pieces: Quote['pieces'], lines: QuoteLine[]): Quote => ({
  pieces, lines, totalCents: lines.reduce((n, l) => n + l.amountCents, 0), creditCents: 0, dueCents: 0,
  blocked: pieces.filter((p) => p.state === 'blocked').map((p) => p.category), giftsUsed: 0, reportsHeld: [], notes: [],
})

const set = quote(
  [piece('feet', 'payable'), piece('hat', 'entitled'), piece('lower_body', 'blocked'), piece('mask', 'none'), piece('upper_body', 'payable', 'revision')],
  [line('feet', { priceKind: 'first_extra', amountCents: 1900 }), line('upper_body', { priceKind: 'revision', amountCents: 1500, revisionNumber: 2 })],
)

describe('finalizeChoices', () => {
  it('a checkbox per piece: payable ones pickable, the rest disabled with the reason', () => {
    expect(finalizeChoices(set)).toEqual([
      { category: 'feet', name: 'Neon feet', pickable: true, finalized: false, reason: null },
      { category: 'hat', name: 'Neon hat', pickable: false, finalized: true, reason: 'Finalized' },
      { category: 'lower_body', name: 'Neon lower_body', pickable: false, finalized: false, reason: 'Failed the checker. Ask the agent to fix it first.' },
      { category: 'mask', name: 'Neon mask', pickable: false, finalized: false, reason: 'Not built yet' },
      { category: 'upper_body', name: 'Neon upper_body', pickable: true, finalized: false, reason: null },
    ])
  })
})

describe('the selection', () => {
  it('starts with every payable piece ticked, as Finalize always paid for', () => {
    expect(initialSelection(set)).toEqual(['feet', 'upper_body'])
  })
  it('toggles only pickable pieces', () => {
    expect(toggleSelection(['feet', 'upper_body'], 'feet', set)).toEqual(['upper_body'])
    expect(toggleSelection(['upper_body'], 'feet', set)).toEqual(['feet', 'upper_body'])
    expect(toggleSelection(['feet'], 'hat', set)).toEqual(['feet'])
    expect(toggleSelection(['feet'], 'lower_body', set)).toEqual(['feet'])
  })
  it('is null (everything) when every payable piece is ticked, else the ticked ones', () => {
    expect(selectionCategories(['upper_body', 'feet'], set)).toBeNull()
    expect(selectionCategories(['upper_body'], set)).toEqual(['upper_body'])
    // a piece that isn't payable any more drops out
    expect(selectionCategories(['upper_body', 'hat'], set)).toEqual(['upper_body'])
    expect(selectionCategories([], set)).toEqual([])
  })
  it('zero ticked has nothing to check out', () => {
    expect(selectionProblem([])).toBe('Tick at least one piece to finalize.')
    expect(selectionProblem(['feet'])).toBeNull()
  })
})

describe('mistake reports', () => {
  it('attach only to a ticked revision line', () => {
    const rev = set.lines[1]
    expect(canReport(rev, ['feet', 'upper_body'])).toBe(true)
    expect(canReport(rev, ['feet'])).toBe(false)
    expect(canReport(set.lines[0], ['feet', 'upper_body'])).toBe(false)
  })
})

describe('checkoutBody with a selection', () => {
  const report = 'the sleeve went through the arm'
  it('sends the categories with the reports, and no report for a piece left out', () => {
    expect(checkoutBody({ upper_body: report }, ['upper_body'])).toEqual({ categories: ['upper_body'], reports: { upper_body: report } })
    expect(checkoutBody({ upper_body: report }, ['feet'])).toEqual({ categories: ['feet'] })
  })
  it('everything ticked sends what it always did', () => {
    expect(checkoutBody({ upper_body: report }, null)).toEqual({ reports: { upper_body: report } })
    expect(checkoutBody({}, null)).toEqual({})
  })
})

describe('latestOnly', () => {
  it('only the newest request’s answer is used', () => {
    const gate = latestOnly()
    const a = gate.next()
    const b = gate.next()
    expect(gate.isLatest(a)).toBe(false)
    expect(gate.isLatest(b)).toBe(true)
  })
})

describe('designBadge for a partly finalized design', () => {
  const d = (over: Partial<StudioDesign>): StudioDesign => ({
    id: 'd1', name: 'Street set', kind: 'wearable', agent: 'claude', status: 'idle', archivedAt: null, lastJobAt: null,
    finalizedAt: '2026-11-07T12:00:00Z', createdAt: '2026-11-01T12:00:00Z', ...over,
  })
  it('says how many pieces are finalized while some are left', () => {
    expect(designBadge(d({ finalizedPieces: 2, pieceCount: 4 }))).toEqual({ label: 'Finalized 2 of 4', tone: 'success' })
    expect(designBadge(d({ finalizedPieces: 4, pieceCount: 4 }))).toEqual({ label: 'Finalized', tone: 'success' })
    // an older answer without the counts reads as before
    expect(designBadge(d({}))).toEqual({ label: 'Finalized', tone: 'success' })
    expect(designBadge(d({ finalizedPieces: 1, pieceCount: 3, archivedAt: '2026-11-07T13:00:00Z' })).label).toBe('Archived')
  })
})

describe('wornDetail', () => {
  const whole: StudioSet = { revisions: 'a,b,c', views: {}, checks: [], freeFixesLeft: {} }
  const some: StudioSet = { revisions: 'a,b', views: {}, checks: [{ emote: 'run', bodyShape: 'male', state: 'fine' }], freeFixesLeft: {} }
  const detail = { set: whole } as StudioDetail
  it('the emote step shows the selection’s set while only some pieces are ticked', () => {
    expect(wornDetail(detail, { categories: ['hat'], set: some }).set).toBe(some)
    expect(wornDetail(detail, null)).toBe(detail)
  })
})

describe('wornState (fix round 1)', () => {
  const set: StudioSet = { revisions: 'a', views: {}, checks: [], freeFixesLeft: {} }
  it('is the whole set with no selection, loading until the selection’s set is fetched, none with nothing ticked', () => {
    expect(wornState(null, null)).toBeNull()
    expect(wornState(null, { key: 'hat', set })).toBeNull()
    expect(wornState([], null)).toBe('none')
    expect(wornState(['hat'], null)).toBe('loading')
    expect(wornState(['hat'], { key: 'feet', set })).toBe('loading')
    expect(wornState(['hat'], { key: 'hat', set })).toEqual({ categories: ['hat'], set })
  })
})

describe('checkoutQuoteRefusal (fix round 1)', () => {
  it('a selection with nothing left to pay is the nothing-left page, not an error', () => {
    expect(checkoutQuoteRefusal({ status: 409, body: { code: 'nothing_to_pay' } })).toBe('nothing_left')
    expect(checkoutQuoteRefusal({ status: 404, body: { error: 'design_not_found' } })).not.toBe('nothing_left')
  })
})
