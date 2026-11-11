import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioEntitlements, studioMistakeReports, studioPieces, studioRevisions, type PaymentLine } from '../db/schema.js'
import { config } from '../config.js'
import type { Design } from './designs.js'
import type { Exec } from './quota.js'

/**
 * What finalizing a design's pieces costs. A piece's first finalize is the first paid revision of that piece; every
 * later one is a half-price revision. Within a design the first finalized wearable piece is full price and the rest
 * are extra pieces; within one checkout the first wearable revision is full price and the rest are extra pieces. A
 * piece whose checker found a FAIL can't be finalized. Amounts are settings (config.studioPrices).
 */

export const RECURATION_NOTE =
  'Decentraland’s curators review a change to a published item again before it goes live. Decentraland doesn’t charge for that review.'

export type QuotePiece = {
  category: string
  footprint?: string // a scene building's, from its revision
  name: string
  revisionNumber: number
  revisionId: string
  state: 'payable' | 'entitled' | 'blocked' | 'none'
  kind: 'first' | 'revision'
  checker: unknown
}

/** `creditCents`: the Virvi credit applied; `dueCents`: what is left to pay by card or MANA (`totalCents - creditCents`). */
export type Quote = {
  pieces: QuotePiece[]; lines: PaymentLine[]; totalCents: number; creditCents: number; dueCents: number; giftsUsed: number
  blocked: string[]; reportsHeld: string[]; notes: string[]
}

export class QuoteError extends Error {
  constructor(public code: 'checks_failed' | 'nothing_to_pay' | 'unknown_piece' | 'not_waivable', public categories: string[] = []) {
    super(code)
  }
}

/**
 * The price of each piece in one checkout, in order: `kind` is whether the piece has been paid for before, and
 * `designHasFirst` whether any piece of the design has. Used to quote, and again when a payment is granted, against
 * what has been paid for by then.
 */
/** What a line charges after its waiver or free-finalize credit. */
export const chargedCents = (l: Pick<PaymentLine, 'amountCents' | 'waived' | 'gift' | 'giftCents' | 'admin'>) =>
  l.admin || l.waived ? 0 : l.gift ? Math.max(0, l.amountCents - (l.giftCents ?? l.amountCents)) : l.amountCents

/** What is left of a line to pay by card or MANA once credit paid its share (and the owner absorbed theirs). */
export const dueCentsOf = (l: Pick<PaymentLine, 'amountCents' | 'waived' | 'gift' | 'giftCents' | 'admin' | 'creditCents' | 'absorbedCents'>) =>
  chargedCents(l) - (l.creditCents ?? 0) - (l.absorbedCents ?? 0)

/**
 * Spends up to `cents` of credit on lines in order: each charged line takes what is left, up to what it charges, as
 * its `creditCents`; a line that charges nothing (waived, free or an admin's) is left as it is.
 */
export function allocateCredit(lines: PaymentLine[], cents: number): { lines: PaymentLine[]; usedCents: number } {
  let left = Math.max(0, cents)
  const out = lines.map((l) => {
    const charged = chargedCents(l)
    if (!(charged > 0)) return l
    const creditCents = Math.min(left, charged)
    left -= creditCents
    return { ...l, creditCents }
  })
  return { lines: out, usedCents: Math.max(0, cents) - left }
}

/**
 * A reopened MANA payment's lines, re-allocated to what it holds again (ruling R9): `gifts` free finalizes stay on the
 * most expensive gift lines, as quoteFinalize gives them, and the others lose theirs; `credit` cents are spent in line
 * order, as the checkout spent them. Each line keeps the share its MANA paid; what is left of it uncovered becomes its
 * `absorbedCents`, which the owner absorbs.
 */
export function reallocateLines(lines: PaymentLine[], gifts: number, credit: number): { lines: PaymentLine[]; absorbedCents: number } {
  const mana = lines.map((l) => dueCentsOf(l))
  const keep = new Set(lines.map((l, i) => ({ l, i })).filter(({ l }) => l.gift)
    .sort((a, b) => b.l.amountCents - a.l.amountCents || a.i - b.i)
    .slice(0, Math.max(0, gifts)).map(({ i }) => i))
  let absorbedCents = 0
  const out = allocateCredit(lines, credit).lines.map((l, i) => {
    let line: PaymentLine = { ...l }
    delete line.absorbedCents
    if (line.gift && !keep.has(i)) {
      const { gift: _gift, giftCents: _giftCents, ...rest } = line
      line = rest
    }
    const absorbed = chargedCents(line) - (line.creditCents ?? 0) - mana[i]
    absorbedCents += Math.max(0, absorbed)
    return absorbed > 0 ? { ...line, absorbedCents: absorbed } : line
  })
  return { lines: out, absorbedCents }
}

type Tier = 'Small' | 'Medium' | 'Large'
const tierOf = (footprint?: string): Tier => footprint === '4x4' ? 'Large' : footprint === '1x2' || footprint === '2x2' ? 'Medium' : 'Small'

/**
 * A scene design: a building by its footprint (as revised, for a revision); furniture 900 for the design's first paid
 * piece, 500 after it (a building earlier in the checkout counts), 500 a revision.
 */
function scenePriceLines(
  pieces: { kind: 'first' | 'revision'; category?: string; footprint?: string }[],
  designHasFirst: boolean,
): { priceKind: PaymentLine['priceKind']; amountCents: number }[] {
  const prices = config.studioPrices
  let hasFirst = designHasFirst
  return pieces.map((p) => {
    if (p.category === 'building') {
      hasFirst = hasFirst || p.kind === 'first'
      return p.kind === 'first'
        ? { priceKind: 'first' as const, amountCents: prices[`building${tierOf(p.footprint)}`] }
        : { priceKind: 'revision' as const, amountCents: prices[`revisionBuilding${tierOf(p.footprint)}`] }
    }
    if (p.kind === 'revision') return { priceKind: 'revision' as const, amountCents: prices.revisionFurniture }
    const line = hasFirst ? { priceKind: 'first_extra' as const, amountCents: prices.furnitureExtra }
      : { priceKind: 'first' as const, amountCents: prices.furniture }
    hasFirst = true
    return line
  })
}

export function priceLines(
  designKind: string,
  pieces: { kind: 'first' | 'revision'; category?: string; footprint?: string }[],
  designHasFirst: boolean,
): { priceKind: PaymentLine['priceKind']; amountCents: number }[] {
  if (designKind === 'scene') return scenePriceLines(pieces, designHasFirst)
  const prices = config.studioPrices
  const emote = designKind === 'emote'
  let hasFirst = designHasFirst
  let hasRevision = false
  return pieces.map((p) => {
    if (p.kind === 'first') {
      const line = {
        priceKind: emote || !hasFirst ? 'first' as const : 'first_extra' as const,
        amountCents: emote ? prices.emote : hasFirst ? prices.extraPiece : prices.wearable,
      }
      hasFirst = true
      return line
    }
    const line = {
      priceKind: emote || !hasRevision ? 'revision' as const : 'revision_extra' as const,
      amountCents: emote ? prices.revisionEmote : hasRevision ? prices.revisionExtraPiece : prices.revisionWearable,
    }
    hasRevision = true
    return line
  })
}

/**
 * Mistake reports on a piece that were refunded without review (waived at checkout, refunded at once, or approved by
 * the owner). Past STUDIO_INSTANT_REPORTS of them, a report waits for the owner; a declined one doesn't count.
 */
export async function instantReportsUsed(designId: string, category: string, exec: Exec = db): Promise<number> {
  const rows = await exec.select({ id: studioMistakeReports.id }).from(studioMistakeReports)
    .innerJoin(studioEntitlements, eq(studioEntitlements.id, studioMistakeReports.entitlementId))
    .where(and(eq(studioEntitlements.designId, designId), eq(studioEntitlements.category, category),
      inArray(studioMistakeReports.status, ['waived', 'refunded'])))
  return rows.length
}

/**
 * `gifts` free-finalize credits each make one first-finalize line free, the most expensive first (ties in piece order);
 * revision lines are never free this way.
 */
/** Whether a user is a Virvi admin, who finalizes without paying. Read from the database, not the session token. */
export { isVirviAdmin } from '../auth/admin.js'

/**
 * `admin`: a Virvi admin's quote, every line free and no gift credit spent. `credit`: the Virvi credit cents the
 * customer could spend, applied after gift finalizes (a checkout takes and allocates it itself, under a lock).
 */
export async function quoteFinalize(
  design: Design, categories: string[] | null, waived: string[], gifts = 0, exec: Exec = db, opts: { admin?: boolean; credit?: number } = {},
): Promise<Quote> {
  if (opts.admin) gifts = 0
  const pieceRows = await exec.select().from(studioPieces).where(eq(studioPieces.designId, design.id)).orderBy(asc(studioPieces.category))
  const revIds = pieceRows.map((p) => p.latestRevisionId).filter((x): x is string => !!x)
  const revs = revIds.length ? await exec.select().from(studioRevisions).where(inArray(studioRevisions.id, revIds)) : []
  const ents = await exec.select().from(studioEntitlements).where(eq(studioEntitlements.designId, design.id))
  const pieces: QuotePiece[] = pieceRows.map((p) => {
    const rev = revs.find((r) => r.id === p.latestRevisionId)
    const kind = ents.some((e) => e.category === p.category) ? 'revision' as const : 'first' as const
    const state = !rev ? 'none' as const
      : ents.some((e) => e.revisionId === rev.id) ? 'entitled' as const
        : (rev.checker as { pass?: boolean } | null)?.pass === false ? 'blocked' as const
          : 'payable' as const
    const footprint = (rev?.meta as { footprint?: unknown } | undefined)?.footprint
    return {
      category: p.category, name: p.name, revisionNumber: rev?.number ?? 0, revisionId: rev?.id ?? '', state, kind,
      checker: rev?.checker ?? null, ...(typeof footprint === 'string' ? { footprint } : {}),
    }
  })
  const blocked = pieces.filter((p) => p.state === 'blocked').map((p) => p.category)

  let chosen: QuotePiece[]
  if (categories) {
    const unknown = categories.filter((c) => !pieces.some((p) => p.category === c && p.state !== 'none'))
    if (unknown.length) throw new QuoteError('unknown_piece', unknown)
    const failing = categories.filter((c) => blocked.includes(c))
    if (failing.length) throw new QuoteError('checks_failed', failing)
    chosen = pieces.filter((p) => categories.includes(p.category) && p.state === 'payable')
    if (!chosen.length) throw new QuoteError('nothing_to_pay', categories)
  } else {
    chosen = pieces.filter((p) => p.state === 'payable')
  }
  const notWaivable = waived.filter((c) => !chosen.some((p) => p.category === c && p.kind === 'revision'))
  if (notWaivable.length) throw new QuoteError('not_waivable', notWaivable)

  const prices = priceLines(design.kind, chosen, ents.length > 0)
  // Revision lines whose mistake report would wait for the owner rather than be waived
  const overLimit = new Set<string>()
  for (const p of chosen.filter((p) => p.kind === 'revision')) {
    if ((await instantReportsUsed(design.id, p.category, exec)) >= config.studioFlag.instantReports) overLimit.add(p.category)
  }
  const giftIdx = new Set(chosen.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'first')
    .sort((a, b) => prices[b.i].amountCents - prices[a.i].amountCents || a.i - b.i)
    .slice(0, Math.max(0, gifts)).map(({ i }) => i))
  const cap = config.studioPrices.giftCapCents
  const priced: PaymentLine[] = chosen.map((p, i) => ({
    category: p.category, revisionId: p.revisionId, revisionNumber: p.revisionNumber, pieceName: p.name,
    ...prices[i], waived: waived.includes(p.category) && !overLimit.has(p.category),
    ...(waived.includes(p.category) && overLimit.has(p.category) ? { held: true } : {}),
    ...(opts.admin ? { admin: true } : {}),
    ...(giftIdx.has(i) ? { gift: true, ...(design.kind === 'scene' ? { giftCents: Math.min(prices[i].amountCents, cap) } : {}) } : {}),
    ...(p.footprint ? { footprint: p.footprint } : {}),
  }))
  const totalCents = priced.reduce((sum, l) => sum + chargedCents(l), 0)
  const credit = opts.admin || !(opts.credit && opts.credit > 0) ? { lines: priced, usedCents: 0 } : allocateCredit(priced, opts.credit)
  const lines = credit.lines
  return {
    pieces,
    lines,
    totalCents,
    creditCents: credit.usedCents,
    dueCents: totalCents - credit.usedCents,
    giftsUsed: giftIdx.size,
    blocked,
    reportsHeld: [...overLimit],
    notes: lines.some((l) => l.priceKind.startsWith('revision')) ? [RECURATION_NOTE] : [],
  }
}
