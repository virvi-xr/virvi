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


describe('scene pricing', () => {
  const prev = config.studioEnabled
  beforeAll(() => { ;(config as any).studioEnabled = true })
  afterAll(() => { ;(config as any).studioEnabled = prev })
  beforeEach(resetDb)

  const scene = async () => createDesign(await createUser(), { kind: 'scene' })
  const ok = { pass: true, failures: 0, warnings: 0 }
  const house = (d: { id: string }, footprint: string) => addRevision(d, 'building', ok, { kind: 'building', footprint })
  const piece = (d: { id: string }, category: string) => addRevision(d, category, ok, { kind: 'furniture', type: 'chair' })
  const amounts = (q: Awaited<ReturnType<typeof quoteFinalize>>) => q.lines.map((l) => l.amountCents)

  it('furniture alone: 900 for the first piece, 500 for each extra, 500 a revision', async () => {
    const d = await scene()
    const chair = await piece(d, 'furniture_chair')
    const table = await piece(d, 'furniture_table')
    expect(amounts(await quoteFinalize(d, null, []))).toEqual([900, 500])
    await entitle(d, chair)
    await entitle(d, table)
    await piece(d, 'furniture_lamp')
    expect(amounts(await quoteFinalize(d, null, []))).toEqual([500])
    await piece(d, 'furniture_chair')
    expect(amounts(await quoteFinalize(d, ['furniture_chair'], []))).toEqual([500])
  })

  it('a building is priced by its footprint, and its furniture as extra pieces', async () => {
    const d = await scene()
    await house(d, '1x1')
    await piece(d, 'furniture_chair')
    await piece(d, 'furniture_table')
    const q = await quoteFinalize(d, null, [])
    expect(q.lines.map((l) => [l.category, l.amountCents])).toEqual([['building', 2900], ['furniture_chair', 500], ['furniture_table', 500]])
    expect(q.totalCents).toBe(3900)
    for (const [fp, cents] of [['0.5x0.5', 2900], ['1x2', 4900], ['2x2', 4900], ['4x4', 7900]] as const) {
      const e = await scene()
      await house(e, fp)
      expect(amounts(await quoteFinalize(e, null, []))).toEqual([cents])
    }
  })

  it('furniture paid for before a building stays as it was; the building is priced on its own', async () => {
    const d = await scene()
    const chair = await piece(d, 'furniture_chair')
    expect(amounts(await quoteFinalize(d, null, []))).toEqual([900])
    await entitle(d, chair)
    await house(d, '1x1')
    expect(amounts(await quoteFinalize(d, null, []))).toEqual([2900])
  })

  it('a building revised into a bigger footprint pays that footprint’s revision', async () => {
    const d = await scene()
    await entitle(d, await house(d, '1x1'))
    const bigger = await house(d, '2x2')
    const q = await quoteFinalize(d, null, [])
    expect(q.lines.map((l) => [l.priceKind, l.amountCents])).toEqual([['revision', 2500]])
    await entitle(d, bigger)
    await house(d, '4x4')
    expect(amounts(await quoteFinalize(d, null, []))).toEqual([4000])
  })

  it('a gift covers up to $29: a 4x4 costs 5000 with it, a chair nothing', async () => {
    const d = await scene()
    await house(d, '4x4')
    const q = await quoteFinalize(d, null, [], 1)
    expect(q.lines[0]).toMatchObject({ amountCents: 7900, gift: true, giftCents: 2900 })
    expect(q.totalCents).toBe(5000)
    const e = await scene()
    await piece(e, 'furniture_chair')
    const c = await quoteFinalize(e, null, [], 1)
    expect(c.lines[0]).toMatchObject({ amountCents: 900, gift: true, giftCents: 900 })
    expect(c.totalCents).toBe(0)
  })

  it('a wearable gift still covers the whole line', async () => {
    const d = await createDesign(await createUser())
    await addRevision(d, 'hat')
    const q = await quoteFinalize(d, null, [], 1)
    expect(q.lines[0]).toMatchObject({ amountCents: 2900, gift: true })
    expect(q.totalCents).toBe(0)
  })
})

describe('Virvi admins', () => {
  const prev = config.studioEnabled
  beforeAll(() => { ;(config as any).studioEnabled = true })
  afterAll(() => { ;(config as any).studioEnabled = prev })
  beforeEach(resetDb)

  it('an admin quote is free on every line and spends no gift', async () => {
    const d = await createDesign(await createUser({ role: 'admin' }), { kind: 'scene' })
    await addRevision(d, 'building', { pass: true, failures: 0, warnings: 0 }, { kind: 'building', footprint: '4x4' })
    await addRevision(d, 'furniture_chair', { pass: true, failures: 0, warnings: 0 }, { kind: 'furniture' })
    const q = await quoteFinalize(d, null, [], 2, undefined, { admin: true })
    expect(q.lines.map((l) => [l.category, l.amountCents, l.admin])).toEqual([['building', 7900, true], ['furniture_chair', 500, true]])
    expect(q.totalCents).toBe(0)
    expect(q.giftsUsed).toBe(0)
  })
})
