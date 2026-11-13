import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  AUTO_SNAPSHOT_MINUTES, RAFFLE_CONSENT_VERSION, cleanDisplayName, DRAW_ALGORITHM, DRAW_COOLDOWN_MS, MIN_PRESENT_DEFAULT_MINUTES, MIN_PRESENT_MAX_MINUTES, RAFFLE_WINNERS_MAX,
  WHEEL_MAX_NAMES, shortWallet, type PublicDraw, type PublicRaffle, type RaffleMode, type RaffleStatus,
} from '@virvixr/shared'
import { db } from '../db/connection.js'
import { raffleDraws, raffleEntries, raffles, raffleSnapshots, scenes } from '../db/schema.js'
import { checkInDelta, isPresent } from '../presence/attendance.js'
import { publishVenueEvent } from '../realtime/bus.js'
import { buildPool, drawWinners } from './draw.js'

/**
 * Raffles (LIV-55), the host side: create, edit, open, snapshot, draw, close and cancel. No Fastify here; the routes
 * check who may call. Visitors only ever see `publicRaffle` and `PublicDraw` (no wallets).
 */

export type RaffleRow = typeof raffles.$inferSelect
export type EntryRow = typeof raffleEntries.$inferSelect
export type SnapshotRow = typeof raffleSnapshots.$inferSelect
export type DrawRow = typeof raffleDraws.$inferSelect

export class RaffleError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

const MODES: RaffleMode[] = ['one_per_person', 'weighted']
const ACTIVE: RaffleStatus[] = ['open', 'drawn']
const NAME_MAX = 80
const PRIZE_MAX = 200
const RULES_MAX = 4000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RaffleInput {
  name: string
  prize: string
  rules: string | null
  winnersCount: number
  mode: RaffleMode
  minPresentSeconds: number
  autoSnapshotMinutes: number | null
}

const has = (body: Record<string, unknown>, k: string) => body[k] !== undefined

/** The raffle fields from a create body (everything but `rules`, the minimum and the interval required), or an edit merged onto `current`. */
export function parseRaffleInput(body: Record<string, unknown>, current?: RaffleRow): RaffleInput {
  const name = has(body, 'name') || !current ? body.name : current.name
  if (typeof name !== 'string' || !name.trim() || name.trim().length > NAME_MAX) throw new RaffleError(400, 'name_required', `Give the raffle a name of up to ${NAME_MAX} characters.`)
  const prize = has(body, 'prize') || !current ? body.prize : current.prize
  if (typeof prize !== 'string' || !prize.trim() || prize.trim().length > PRIZE_MAX) throw new RaffleError(400, 'prize_required', `Say what the prize is, in up to ${PRIZE_MAX} characters.`)
  const rawRules = has(body, 'rules') || !current ? body.rules : current.rules
  if (rawRules !== undefined && rawRules !== null && typeof rawRules !== 'string') throw new RaffleError(400, 'rules_too_long', 'The rules must be text.')
  const rules = typeof rawRules === 'string' && rawRules.trim() ? rawRules.trim() : null
  if (rules && rules.length > RULES_MAX) throw new RaffleError(400, 'rules_too_long', `The rules can be up to ${RULES_MAX} characters.`)
  const winnersCount = has(body, 'winnersCount') || !current ? body.winnersCount : current.winnersCount
  if (typeof winnersCount !== 'number' || !Number.isInteger(winnersCount) || winnersCount < 1 || winnersCount > RAFFLE_WINNERS_MAX) {
    throw new RaffleError(400, 'winners_out_of_range', `Pick 1 to ${RAFFLE_WINNERS_MAX} winners.`)
  }
  const mode = has(body, 'mode') || !current ? body.mode : current.mode
  if (!MODES.includes(mode as RaffleMode)) throw new RaffleError(400, 'bad_mode', 'Pick one entry per person or weighted by attendance.')
  let minPresentSeconds = current?.minPresentSeconds ?? MIN_PRESENT_DEFAULT_MINUTES * 60
  if (has(body, 'minPresentMinutes') && body.minPresentMinutes !== null) {
    const m = body.minPresentMinutes
    if (typeof m !== 'number' || !Number.isFinite(m) || m < 0 || m > MIN_PRESENT_MAX_MINUTES) {
      throw new RaffleError(400, 'min_present_out_of_range', `The minimum time present is 0 to ${MIN_PRESENT_MAX_MINUTES} minutes.`)
    }
    minPresentSeconds = Math.round(m * 60)
  } else if (has(body, 'minPresentMinutes')) {
    minPresentSeconds = MIN_PRESENT_DEFAULT_MINUTES * 60
  }
  const auto = has(body, 'autoSnapshotMinutes') || !current ? (body.autoSnapshotMinutes ?? null) : current.autoSnapshotMinutes
  if (auto !== null && !(AUTO_SNAPSHOT_MINUTES as readonly unknown[]).includes(auto)) {
    throw new RaffleError(400, 'bad_auto_snapshot', `Automatic snapshots are off or every ${AUTO_SNAPSHOT_MINUTES.join(', ')} minutes.`)
  }
  return { name: name.trim(), prize: prize.trim(), rules, winnersCount, mode: mode as RaffleMode, minPresentSeconds, autoSnapshotMinutes: auto as number | null }
}

/** What the host sees of a raffle. */
export function hostRaffle(row: RaffleRow, entryCount: number) {
  return {
    id: row.id,
    sceneId: row.sceneId,
    name: row.name,
    prize: row.prize,
    rules: row.rules,
    winnersCount: row.winnersCount,
    mode: row.mode,
    minPresentMinutes: row.minPresentSeconds / 60,
    autoSnapshotMinutes: row.autoSnapshotMinutes,
    status: row.status,
    entryCount,
    openedAt: row.openedAt,
    firstDrawnAt: row.firstDrawnAt,
    lastDrawnAt: row.lastDrawnAt,
    endedAt: row.endedAt,
    nextAutoSnapshotAt: row.nextAutoSnapshotAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** What visitors may see: no names, no wallets. */
export function publicRaffle(row: RaffleRow & { entryCount: number }): PublicRaffle {
  return {
    id: row.id, sceneId: row.sceneId, name: row.name, prize: row.prize, rules: row.rules,
    status: row.status, winnersCount: row.winnersCount, entryCount: row.entryCount,
  }
}

/** The record anyone can replay with `drawWinners(pool, winnerEntryIds.length, seed, id)`. */
export function drawRecord(d: DrawRow) {
  return { id: d.id, algorithm: d.algorithm, seed: d.seed, mode: d.mode, snapshotIds: d.snapshotIds, pool: d.pool, winnerEntryIds: d.winnerEntryIds, drawnAt: d.drawnAt }
}

export function snapshotOut(s: SnapshotRow) {
  return { id: s.id, takenAt: s.takenAt, trigger: s.trigger, entryIds: s.entryIds }
}

/** The name shown for an entrant: its stored name, else the short wallet. */
export const entrantName = (e: { displayName: string | null; wallet: string | null }) => e.displayName ?? (e.wallet ? shortWallet(e.wallet) : 'Entrant')

export async function entryCounts(raffleIds: string[]): Promise<Map<string, number>> {
  if (!raffleIds.length) return new Map()
  const rows = await db.select({ raffleId: raffleEntries.raffleId, n: sql<number>`count(*)::int` }).from(raffleEntries)
    .where(inArray(raffleEntries.raffleId, raffleIds)).groupBy(raffleEntries.raffleId)
  return new Map(rows.map((r) => [r.raffleId, r.n]))
}

export async function getRaffle(raffleId: string): Promise<RaffleRow | null> {
  if (!UUID.test(raffleId)) return null
  return (await db.query.raffles.findFirst({ where: eq(raffles.id, raffleId) })) ?? null
}

/** The scene's open or drawn raffle with its entry count, or null. */
export async function activeRaffle(sceneId: string): Promise<(RaffleRow & { entryCount: number }) | null> {
  const row = await db.query.raffles.findFirst({ where: and(eq(raffles.sceneId, sceneId), inArray(raffles.status, ACTIVE)) })
  if (!row) return null
  return { ...row, entryCount: (await entryCounts([row.id])).get(row.id) ?? 0 }
}

export async function listRaffles(sceneId: string) {
  const rows = await db.select().from(raffles).where(eq(raffles.sceneId, sceneId)).orderBy(desc(raffles.createdAt), desc(raffles.id))
  const counts = await entryCounts(rows.map((r) => r.id))
  return rows.map((r) => hostRaffle(r, counts.get(r.id) ?? 0))
}

export async function createRaffle(sceneId: string, userId: string, body: Record<string, unknown>, now = new Date()) {
  const input = parseRaffleInput(body)
  if (body.acceptHostTerms !== true) throw new RaffleError(400, 'host_terms_required', 'Accept the host terms to run a raffle.')
  const [row] = await db.insert(raffles).values({ sceneId, createdBy: userId, ...input, hostTermsAcceptedAt: now, createdAt: now, updatedAt: now }).returning()
  return hostRaffle(row, 0)
}

const badStatus = (row: RaffleRow, action: string) => new RaffleError(409, 'bad_status', `A ${row.status} raffle can't be ${action}.`)
const nextAuto = (minutes: number | null, now: Date) => (minutes ? new Date(now.getTime() + minutes * 60_000) : null)
const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505'

export async function updateRaffle(row: RaffleRow, body: Record<string, unknown>, now = new Date()) {
  if (row.status !== 'draft' && row.status !== 'open') throw badStatus(row, 'edited')
  const input = parseRaffleInput(body, row)
  if (input.mode !== row.mode) {
    const [snap] = await db.select({ id: raffleSnapshots.id }).from(raffleSnapshots).where(eq(raffleSnapshots.raffleId, row.id)).limit(1)
    if (snap) throw new RaffleError(409, 'mode_locked', "The draw mode can't change after a snapshot.")
  }
  const set: Partial<typeof raffles.$inferInsert> = { ...input, updatedAt: now }
  if (row.status === 'open' && input.autoSnapshotMinutes !== row.autoSnapshotMinutes) set.nextAutoSnapshotAt = nextAuto(input.autoSnapshotMinutes, now)
  const [updated] = await db.update(raffles).set(set).where(and(eq(raffles.id, row.id), inArray(raffles.status, ['draft', 'open']))).returning()
  if (!updated) throw badStatus(row, 'edited')
  if (updated.status === 'open') emitRaffleChanged(updated.sceneId)
  return hostRaffle(updated, (await entryCounts([row.id])).get(row.id) ?? 0)
}

export async function openRaffle(row: RaffleRow, now = new Date()) {
  if (row.status !== 'draft') throw badStatus(row, 'opened')
  let updated: RaffleRow | undefined
  try {
    ;[updated] = await db.update(raffles)
      .set({ status: 'open', openedAt: now, nextAutoSnapshotAt: nextAuto(row.autoSnapshotMinutes, now), updatedAt: now })
      .where(and(eq(raffles.id, row.id), eq(raffles.status, 'draft'))).returning()
  } catch (err) {
    if (isUniqueViolation(err)) throw new RaffleError(409, 'raffle_already_active', 'This scene already has a raffle running. Close it first.')
    throw err
  }
  if (!updated) throw badStatus(row, 'opened')
  emitRaffleChanged(updated.sceneId)
  return hostRaffle(updated, (await entryCounts([row.id])).get(row.id) ?? 0)
}

/** open or drawn → closed; draft or open → cancelled. Both set `ended_at` and stop automatic snapshots. */
export async function endRaffle(row: RaffleRow, to: 'closed' | 'cancelled', now = new Date()) {
  const from: RaffleStatus[] = to === 'closed' ? ['open', 'drawn'] : ['draft', 'open']
  if (!from.includes(row.status)) throw badStatus(row, to)
  const [updated] = await db.update(raffles).set({ status: to, endedAt: now, nextAutoSnapshotAt: null, updatedAt: now })
    .where(and(eq(raffles.id, row.id), inArray(raffles.status, from))).returning()
  if (!updated) throw badStatus(row, to)
  if (ACTIVE.includes(row.status)) emitRaffleChanged(updated.sceneId)
  return hostRaffle(updated, (await entryCounts([row.id])).get(row.id) ?? 0)
}

/**
 * Freeze who is present now (checked in recently and present at least the raffle's minimum). An empty snapshot is
 * stored too. `auto` is for the sweep: it is taken only when `next_auto_snapshot_at` is due (null otherwise) and moves
 * that on by the interval, under the raffle's row lock, so two instances sweeping at once make one snapshot.
 */
export async function takeSnapshot(raffleId: string, trigger: 'manual' | 'auto', now = new Date()): Promise<SnapshotRow | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(raffles).where(eq(raffles.id, raffleId)).for('update')
    if (!row) throw new RaffleError(404, 'raffle_not_found', 'Raffle not found.')
    if (!ACTIVE.includes(row.status)) {
      if (trigger === 'auto') return null
      throw badStatus(row, 'snapshotted')
    }
    if (trigger === 'auto') {
      if (!row.nextAutoSnapshotAt || row.nextAutoSnapshotAt > now) return null
      await tx.update(raffles).set({ nextAutoSnapshotAt: nextAuto(row.autoSnapshotMinutes, now) }).where(eq(raffles.id, row.id))
    }
    const entries = await tx.select({ id: raffleEntries.id, lastSeenAt: raffleEntries.lastSeenAt, secondsPresent: raffleEntries.secondsPresent })
      .from(raffleEntries).where(eq(raffleEntries.raffleId, row.id))
    const entryIds = entries.filter((e) => isPresent(e, now, row.minPresentSeconds)).map((e) => e.id).sort()
    const [snap] = await tx.insert(raffleSnapshots).values({ raffleId: row.id, trigger, entryIds, takenAt: now }).returning()
    return snap
  })
}

export type Winner = { entryId: string; displayName: string; wallet: string | null }

/** Pick up to WHEEL_MAX_NAMES names for the wheel: every winner, then others at random; shuffled. */
function wheelNames(winners: string[], pool: string[], names: Map<string, string>): { names: string[]; more: number } {
  const others = pool.filter((id) => !winners.includes(id))
  for (let i = others.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[others[i], others[j]] = [others[j], others[i]]
  }
  const shown = [...winners, ...others.slice(0, Math.max(0, WHEEL_MAX_NAMES - winners.length))]
  for (let i = shown.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[shown[i], shown[j]] = [shown[j], shown[i]]
  }
  return { names: shown.map((id) => names.get(id)!), more: pool.length - shown.length }
}

/**
 * Draw winners (Settled details 6 and 7), in one transaction holding the raffle's row lock: refused within
 * DRAW_COOLDOWN_MS of the last draw; the pool is the chosen snapshots (default all) less earlier winners and entries
 * that are gone. An empty pool stores nothing. `raffle_draw` is published after the commit.
 */
export async function drawRaffle(raffleId: string, actorUserId: string, snapshotIds?: string[], now = new Date()) {
  if (snapshotIds !== undefined && (!Array.isArray(snapshotIds) || !snapshotIds.every((id) => typeof id === 'string' && UUID.test(id)))) {
    throw new RaffleError(400, 'bad_snapshots', 'Pick snapshots of this raffle.')
  }
  const out = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(raffles).where(eq(raffles.id, raffleId)).for('update')
    if (!row) throw new RaffleError(404, 'raffle_not_found', 'Raffle not found.')
    if (!ACTIVE.includes(row.status)) throw badStatus(row, 'drawn')
    if (row.lastDrawnAt && now.getTime() - row.lastDrawnAt.getTime() < DRAW_COOLDOWN_MS) {
      throw new RaffleError(409, 'draw_in_progress', 'A draw just happened. Wait a few seconds.')
    }
    let snaps = await tx.select().from(raffleSnapshots).where(eq(raffleSnapshots.raffleId, row.id))
    if (snapshotIds !== undefined) {
      const wanted = new Set(snapshotIds)
      snaps = snaps.filter((s) => wanted.has(s.id))
      if (snaps.length !== wanted.size) throw new RaffleError(400, 'bad_snapshots', 'Pick snapshots of this raffle.')
    }
    const entries = await tx.select({ id: raffleEntries.id, displayName: raffleEntries.displayName, wallet: raffleEntries.wallet })
      .from(raffleEntries).where(eq(raffleEntries.raffleId, row.id))
    const byId = new Map(entries.map((e) => [e.id, e]))
    const earlier = await tx.select({ winners: raffleDraws.winnerEntryIds }).from(raffleDraws).where(eq(raffleDraws.raffleId, row.id))
    const exclude = new Set(earlier.flatMap((d) => d.winners))
    const pool = buildPool(row.mode as RaffleMode, snaps.map((s) => ({ entryIds: s.entryIds.filter((id) => byId.has(id)) })), exclude)
    if (!pool.length) throw new RaffleError(409, 'empty_pool', 'Nobody qualifies for this draw. Take a snapshot while entrants are present.')

    const drawId = randomUUID()
    const seed = randomBytes(32).toString('hex')
    const winnerIds = drawWinners(pool, row.winnersCount, seed, drawId)
    const [draw] = await tx.insert(raffleDraws).values({
      id: drawId, raffleId: row.id, snapshotIds: snaps.map((s) => s.id), mode: row.mode as RaffleMode, algorithm: DRAW_ALGORITHM,
      pool, seed, winnerEntryIds: winnerIds, drawnBy: actorUserId, drawnAt: now,
    }).returning()
    await tx.update(raffles).set({ status: 'drawn', firstDrawnAt: row.firstDrawnAt ?? now, lastDrawnAt: now, updatedAt: now }).where(eq(raffles.id, row.id))

    const names = new Map(pool.map((p) => [p.entryId, entrantName(byId.get(p.entryId)!)]))
    const winners: Winner[] = winnerIds.map((id) => ({ entryId: id, displayName: names.get(id)!, wallet: byId.get(id)!.wallet }))
    const wheel = wheelNames(winnerIds, pool.map((p) => p.entryId), names)
    const publicDraw: PublicDraw = { drawId, raffleId: row.id, ...wheel, winners: winners.map((w) => ({ entryId: w.entryId, displayName: w.displayName })) }
    return { sceneId: row.sceneId, draw, winners, publicDraw }
  })
  try {
    await publishVenueEvent({ type: 'raffle_draw', sceneId: out.sceneId, draw: out.publicDraw })
  } catch (err) {
    console.error('[raffles] raffle_draw publish failed:', (err as Error)?.message)
  }
  emitRaffleChanged(out.sceneId)
  return { draw: out.draw, winners: out.winners, publicDraw: out.publicDraw }
}

/** The host's view of one raffle: entries with names and wallets, snapshots, and draws with their winners. */
export async function raffleDetail(row: RaffleRow) {
  const [entries, snaps, draws] = await Promise.all([
    db.select().from(raffleEntries).where(eq(raffleEntries.raffleId, row.id)).orderBy(raffleEntries.createdAt, raffleEntries.id),
    db.select().from(raffleSnapshots).where(eq(raffleSnapshots.raffleId, row.id)).orderBy(raffleSnapshots.takenAt, raffleSnapshots.id),
    db.select().from(raffleDraws).where(eq(raffleDraws.raffleId, row.id)).orderBy(raffleDraws.drawnAt, raffleDraws.id),
  ])
  const byId = new Map(entries.map((e) => [e.id, e]))
  return {
    raffle: hostRaffle(row, entries.length),
    entries: entries.map((e) => ({ id: e.id, displayName: e.displayName, wallet: e.wallet, secondsPresent: e.secondsPresent, lastSeenAt: e.lastSeenAt, createdAt: e.createdAt })),
    snapshots: snaps.map(snapshotOut),
    draws: draws.map((d) => ({
      id: d.id, drawnAt: d.drawnAt, mode: d.mode, algorithm: d.algorithm, snapshotIds: d.snapshotIds, poolSize: d.pool.length,
      winners: d.winnerEntryIds.map((id) => {
        const e = byId.get(id)
        return e ? { entryId: id, displayName: e.displayName, wallet: e.wallet } : { entryId: id, displayName: null, wallet: null, deleted: true as const }
      }),
    })),
  }
}

export async function getDraw(raffleId: string, drawId: string): Promise<DrawRow | null> {
  if (!UUID.test(drawId)) return null
  return (await db.query.raffleDraws.findFirst({ where: and(eq(raffleDraws.id, drawId), eq(raffleDraws.raffleId, raffleId)) })) ?? null
}

// ── Visitors ─────────────────────────────────────────────────────────────────

/** Whether each of the user's entries (by raffle) has won a draw. */
async function wonEntryIds(raffleIds: string[]): Promise<Set<string>> {
  if (!raffleIds.length) return new Set()
  const rows = await db.select({ winners: raffleDraws.winnerEntryIds }).from(raffleDraws).where(inArray(raffleDraws.raffleId, raffleIds))
  return new Set(rows.flatMap((r) => r.winners))
}

export interface Caller {
  userId: string
  /** The caller's scene pass is bound to this scene, with a verified wallet. */
  wallet: string | null
  verified: boolean
  passSceneId: string | null
}

/** The scene's running raffle as visitors see it, the caller's entry, and whether they can enter from here. */
export async function currentRaffle(sceneId: string, caller: Caller) {
  const row = await activeRaffle(sceneId)
  const entry = row
    ? await db.query.raffleEntries.findFirst({ where: and(eq(raffleEntries.raffleId, row.id), eq(raffleEntries.userId, caller.userId)), columns: { id: true } })
    : undefined
  const myEntry = entry ? { entered: true as const, won: (await wonEntryIds([row!.id])).has(entry.id) } : null
  const visitor = caller.passSceneId === sceneId
  const hasWallet = !!caller.wallet && caller.verified
  const canEnter = !!row && row.status === 'open' && !myEntry && visitor && hasWallet
  const reason: 'guest' | 'closed' | undefined = !row || row.status !== 'open' ? 'closed' : !hasWallet ? 'guest' : undefined
  return { raffle: row ? publicRaffle(row) : null, myEntry, canEnter, ...(reason ? { reason } : {}) }
}

/**
 * Enter a raffle: the caller's pass must be bound to its scene with a verified wallet (checked by the route), the
 * consent version current and the raffle open. Entering counts as the first check-in.
 */
export async function enterRaffle(row: RaffleRow, caller: { userId: string; wallet: string; signInName: string | null }, consentVersion: unknown, now = new Date()) {
  if (consentVersion !== RAFFLE_CONSENT_VERSION) throw new RaffleError(400, 'consent_required', 'Agree to the raffle terms to enter.')
  if (row.status !== 'open') throw new RaffleError(409, 'entry_closed', 'This raffle is not taking entries.')
  // The pass's sign-in name (the Decentraland name); without one, cleanDisplayName gives the short wallet
  const name = caller.signInName
  const wallet = caller.wallet.toLowerCase()
  let entry: EntryRow | undefined
  try {
    entry = await db.transaction(async (tx) => {
      // Under the raffle's lock, so an entry never lands after the first draw closed entry
      const [locked] = await tx.select({ status: raffles.status }).from(raffles).where(eq(raffles.id, row.id)).for('update')
      if (locked?.status !== 'open') throw new RaffleError(409, 'entry_closed', 'This raffle is not taking entries.')
      const [e] = await tx.insert(raffleEntries).values({
        raffleId: row.id, userId: caller.userId, wallet, displayName: cleanDisplayName(name, wallet),
        consentVersion: RAFFLE_CONSENT_VERSION, consentedAt: now, lastSeenAt: now, createdAt: now,
      }).returning()
      return e
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw new RaffleError(409, 'already_entered', "You're already in this raffle.")
    throw err
  }
  emitRaffleChanged(row.sceneId)
  return entry!
}

/** Withdraw the user's entry while the raffle is open or drawn. Earlier draw records keep its id. */
export async function withdrawEntry(row: RaffleRow, userId: string) {
  if (!ACTIVE.includes(row.status)) throw new RaffleError(409, 'entry_closed', "This raffle has ended; entries can't be withdrawn.")
  const gone = await db.delete(raffleEntries).where(and(eq(raffleEntries.raffleId, row.id), eq(raffleEntries.userId, userId))).returning({ id: raffleEntries.id })
  if (!gone.length) throw new RaffleError(404, 'not_entered', "You're not in this raffle.")
  emitRaffleChanged(row.sceneId)
}

/**
 * A check-in: null when the raffle isn't open or drawn or the user has no entry; 'too_soon' when it is closer than
 * CHECKIN_MIN_GAP_MS to the last; otherwise the time since the last (capped) is added.
 */
export async function checkInRaffle(raffleId: string, userId: string, now = new Date()): Promise<'ok' | 'too_soon' | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ status: raffles.status }).from(raffles).where(eq(raffles.id, raffleId))
    if (!row || !ACTIVE.includes(row.status)) return null
    const [entry] = await tx.select({ id: raffleEntries.id, lastSeenAt: raffleEntries.lastSeenAt }).from(raffleEntries)
      .where(and(eq(raffleEntries.raffleId, raffleId), eq(raffleEntries.userId, userId))).for('update')
    if (!entry) return null
    const { accepted, addSeconds } = checkInDelta(entry.lastSeenAt, now)
    if (!accepted) return 'too_soon'
    await tx.update(raffleEntries).set({ lastSeenAt: now, secondsPresent: sql`${raffleEntries.secondsPresent} + ${addSeconds}` }).where(eq(raffleEntries.id, entry.id))
    return 'ok'
  })
}

/** The user's raffle entries, newest first. */
export async function myRaffleEntries(userId: string) {
  const rows = await db.select({ entryId: raffleEntries.id, raffleId: raffles.id, sceneName: scenes.name, raffleName: raffles.name, status: raffles.status, enteredAt: raffleEntries.createdAt })
    .from(raffleEntries).innerJoin(raffles, eq(raffleEntries.raffleId, raffles.id)).innerJoin(scenes, eq(raffles.sceneId, scenes.id))
    .where(eq(raffleEntries.userId, userId)).orderBy(desc(raffleEntries.createdAt), desc(raffleEntries.id))
  const won = await wonEntryIds([...new Set(rows.map((r) => r.raffleId))])
  return rows.map(({ entryId, ...r }) => ({ raffleId: r.raffleId, sceneName: r.sceneName, raffleName: r.raffleName, status: r.status, won: won.has(entryId), enteredAt: r.enteredAt }))
}

// ── raffle_changed, at most once every 2 s per scene ─────────────────────────

export const RAFFLE_CHANGED_INTERVAL_MS = 2_000
const lastChanged = new Map<string, number>()
const pendingChanged = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Tell the scene's rooms its current raffle changed. The first call goes out at once; calls within
 * RAFFLE_CHANGED_INTERVAL_MS of the last send are folded into one, sent when the interval is up with the state then.
 * Never throws.
 */
export function emitRaffleChanged(sceneId: string): void {
  if (pendingChanged.has(sceneId)) return
  const wait = Math.max(0, (lastChanged.get(sceneId) ?? 0) + RAFFLE_CHANGED_INTERVAL_MS - Date.now())
  const timer = setTimeout(() => {
    pendingChanged.delete(sceneId)
    lastChanged.set(sceneId, Date.now())
    void publishRaffleChanged(sceneId)
  }, wait)
  timer.unref?.()
  pendingChanged.set(sceneId, timer)
}

async function publishRaffleChanged(sceneId: string) {
  try {
    const row = await activeRaffle(sceneId)
    await publishVenueEvent({ type: 'raffle_changed', sceneId, raffle: row ? publicRaffle(row) : null })
  } catch (err) {
    console.error('[raffles] raffle_changed publish failed:', (err as Error)?.message)
  }
}
