import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { config } from '../src/config.js'
import { quoteFinalize, QuoteError, RECURATION_NOTE } from '../src/studio/pricing.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, addRevision, entitle } from './helpers/studio.js'

describe('studio finalize pricing', () => {
  const prev = config.studioEnabled
  beforeAll(() => { ;(config as any).studioEnabled = true })
  afterAll(() => { ;(config as any).studioEnabled = prev })
  beforeEach(resetDb)

  async function caught(p: Promise<unknown>): Promise<QuoteError> {
    try { await p } catch (e) { if (e instanceof QuoteError) return e; throw e }
    throw new Error('expected a QuoteError')
  }

  it('a new three-piece set is 2900 + 1900 + 1900', async () => {
    const d = await createDesign(await createUser())
    for (const c of ['feet', 'hat', 'upper_body']) await addRevision(d, c)
    const q = await quoteFinalize(d, null, [])
    expect(q.totalCents).toBe(6700)
    expect(q.lines.map((l) => [l.category, l.priceKind, l.amountCents])).toEqual([
      ['feet', 'first', 2900], ['hat', 'first_extra', 1900], ['upper_body', 'first_extra', 1900],
    ])
    expect(q.notes).toEqual([])
    expect(q.pieces.every((p) => p.state === 'payable' && p.kind === 'first')).toBe(true)
  })

  it('an emote is 3900, its revision 2000', async () => {
    const d = await createDesign(await createUser(), { kind: 'emote' })
    const r1 = await addRevision(d, 'emote')
    expect((await quoteFinalize(d, null, [])).totalCents).toBe(3900)
    await entitle(d, r1)
    await addRevision(d, 'emote')
    const q = await quoteFinalize(d, null, [])
    expect(q.lines.map((l) => [l.priceKind, l.amountCents])).toEqual([['revision', 2000]])
    expect(q.notes).toEqual([RECURATION_NOTE])
  })

  it('a piece added to a finalized set is an extra piece', async () => {
    const d = await createDesign(await createUser())
    await entitle(d, await addRevision(d, 'hat'))
    await addRevision(d, 'feet')
    const q = await quoteFinalize(d, null, [])
    expect(q.lines.map((l) => [l.category, l.priceKind, l.amountCents])).toEqual([['feet', 'first_extra', 1900]])
    expect(q.pieces.find((p) => p.category === 'hat')!.state).toBe('entitled')
  })

  it('revisions are 1500 then 1000', async () => {
    const d = await createDesign(await createUser())
    await entitle(d, await addRevision(d, 'hat'))
    await entitle(d, await addRevision(d, 'feet'))
    await addRevision(d, 'hat')
    await addRevision(d, 'feet')
    const q = await quoteFinalize(d, null, [])
    expect(q.lines.map((l) => [l.category, l.priceKind, l.amountCents, l.revisionNumber])).toEqual([
      ['feet', 'revision', 1500, 2], ['hat', 'revision_extra', 1000, 2],
    ])
    expect(q.totalCents).toBe(2500)
    expect(q.notes).toEqual([RECURATION_NOTE])
    expect(RECURATION_NOTE).toBe('Decentraland’s curators review a change to a published item again before it goes live. Decentraland doesn’t charge for that review.')
  })

  it('an entitled latest revision is not payable', async () => {
    const d = await createDesign(await createUser())
    await entitle(d, await addRevision(d, 'hat'))
    const q = await quoteFinalize(d, null, [])
    expect(q.pieces[0].state).toBe('entitled')
    expect(q.lines).toEqual([])
    expect((await caught(quoteFinalize(d, ['hat'], []))).code).toBe('nothing_to_pay')
  })

  it('a failed checker blocks', async () => {
    const d = await createDesign(await createUser())
    await addRevision(d, 'hat', { pass: false, failures: 2, warnings: 0 })
    await addRevision(d, 'feet')
    const q = await quoteFinalize(d, null, [])
    expect(q.blocked).toEqual(['hat'])
    expect(q.lines.map((l) => l.category)).toEqual(['feet'])
    const e = await caught(quoteFinalize(d, ['hat'], []))
    expect(e.code).toBe('checks_failed')
    expect(e.categories).toEqual(['hat'])
    expect((await caught(quoteFinalize(d, ['eyewear'], []))).code).toBe('unknown_piece')
  })

  it('waiving a revision line removes it from the total', async () => {
    const d = await createDesign(await createUser())
    await entitle(d, await addRevision(d, 'hat'))
    await addRevision(d, 'hat')
    const q = await quoteFinalize(d, null, ['hat'])
    expect(q.lines[0]).toMatchObject({ category: 'hat', amountCents: 1500, waived: true })
    expect(q.totalCents).toBe(0)
  })

  it('waiving a first finalize is refused', async () => {
    const d = await createDesign(await createUser())
    await addRevision(d, 'hat')
    expect((await caught(quoteFinalize(d, null, ['hat']))).code).toBe('not_waivable')
  })

  it('a free finalize goes to the most expensive first-finalize line', async () => {
    const emote = await createDesign(await createUser(), { kind: 'emote' })
    await addRevision(emote, 'emote')
    const e = await quoteFinalize(emote, null, [], 1)
    expect(e.lines.map((l) => [l.amountCents, !!l.gift])).toEqual([[3900, true]])
    expect(e).toMatchObject({ totalCents: 0, giftsUsed: 1 })

    const set = await createDesign(await createUser())
    for (const c of ['feet', 'hat', 'upper_body']) await addRevision(set, c)
    const one = await quoteFinalize(set, null, [], 1)
    expect(one.lines.map((l) => [l.category, l.amountCents, !!l.gift])).toEqual([
      ['feet', 2900, true], ['hat', 1900, false], ['upper_body', 1900, false],
    ])
    expect(one).toMatchObject({ totalCents: 3800, giftsUsed: 1 })
    const two = await quoteFinalize(set, null, [], 2)
    expect(two.lines.map((l) => [l.category, !!l.gift])).toEqual([['feet', true], ['hat', true], ['upper_body', false]])
    expect(two).toMatchObject({ totalCents: 1900, giftsUsed: 2 })
    expect(await quoteFinalize(set, null, [])).toMatchObject({ totalCents: 6700, giftsUsed: 0 })
  })

  it('revision lines are never gift lines', async () => {
    const d = await createDesign(await createUser())
    await entitle(d, await addRevision(d, 'hat'))
    await addRevision(d, 'hat')
    await addRevision(d, 'feet')
    const q = await quoteFinalize(d, null, [], 3)
    expect(q.lines.map((l) => [l.category, l.priceKind, !!l.gift])).toEqual([['feet', 'first_extra', true], ['hat', 'revision', false]])
    expect(q).toMatchObject({ totalCents: 1500, giftsUsed: 1 })
  })

  it("GET /finalize on someone else's design is 404; with the studio off it is 404", async () => {
    const app = await testApp()
    const owner = await createUser()
    const other = await createUser()
    const d = await createDesign(owner)
    await addRevision(d, 'hat')
    const get = (u: TestUser) => app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/finalize`, headers: { authorization: `Bearer ${tokenFor(u)}` } })
    const mine = await get(owner)
    expect(mine.statusCode).toBe(200)
    expect(mine.json()).toMatchObject({ totalCents: 2900, blocked: [] })
    expect((await get(other)).statusCode).toBe(404)
    ;(config as any).studioEnabled = false
    try {
      expect((await get(owner)).statusCode).toBe(404)
    } finally {
      ;(config as any).studioEnabled = true
    }
    await app.close()
  })
})
