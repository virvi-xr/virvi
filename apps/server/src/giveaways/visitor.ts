import { and, asc, eq, isNotNull, isNull, notInArray, sql } from 'drizzle-orm'
import {
  GIVEAWAY_CONSENT_VERSION, GIVEAWAY_DELAYED_AFTER_MS, giveawayTxUrl, type AvailableGiveaway, type GiveawayClaimStatus, type VisitorGiveaway,
} from '@virvixr/shared'
import { db } from '../db/connection.js'
import { giveawayClaimMints, giveawayClaims, giveawayItems, giveaways, giveawayScenes, giveawayTxs } from '../db/schema.js'
import { checkInDelta } from '../presence/attendance.js'
import { beatLiveSince } from '../beats/live.js'
import { isVirviAdmin } from '../auth/admin.js'
import { isWalletBlocked } from '../auth/wallet-blocks.js'
import { platformCheck } from '../beats/platform-checks.js'
import { isNewWallet, takeNewWallet } from '../beats/new-wallet-limit.js'
import type { VisitorCaller } from '../beats/visitor.js'
import { GiveawayError } from './errors.js'

/**
 * Automatic giveaways (LIV-194), the visitor side: the scene's open giveaway, consenting, check-ins, claiming and
 * stopping. No Fastify here; the routes check the pass (a scene pass bound to the scene). A claim queues as `waiting`
 * with one mint row per collection contract, which the minting job sends. Nothing here logs a wallet or a name.
 */

export type { VisitorCaller } from '../beats/visitor.js'

type GiveawayRow = typeof giveaways.$inferSelect
type ClaimRow = typeof giveawayClaims.$inferSelect
type ItemRow = typeof giveawayItems.$inferSelect
type Exec = Pick<typeof db, 'select'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const notFound = () => new GiveawayError(404, 'not_found', 'Giveaway not found.')
const notTracking = () => new GiveawayError(404, 'not_tracking', "You haven't joined this giveaway.")
const closed = () => new GiveawayError(409, 'closed', 'This giveaway is closed.')
const soldOut = () => new GiveawayError(409, 'sold_out', 'This giveaway ran out.')
const profileRequired = () => new GiveawayError(403, 'profile_required', 'Set up your Decentraland profile (an avatar) first, then come back to claim.')
const walletBlocked = () => new GiveawayError(403, 'wallet_blocked', "This wallet can't claim giveaways any more.")

/** The per-network new-wallet limit BEATs use (beats/new-wallet-limit.ts), shared with them. */
async function checkNewWallet(ip: string | null | undefined, wallet: string, now: Date): Promise<void> {
  if (!ip) return
  if ((await isNewWallet(wallet, now)) && !takeNewWallet(ip, wallet, now.getTime())) {
    throw new GiveawayError(429, 'too_many_new_wallets', 'Too many new wallets have claimed from your network. Try again later.')
  }
}

/** The wallet checks BEATs make: the platform's profile check, the new-wallet limit and wallet blocks. */
async function walletChecks(c: Pick<VisitorCaller, 'platform' | 'ip'>, wallet: string, now: Date): Promise<void> {
  if (!(await platformCheck(c.platform ?? 'decentraland', wallet, now))) throw profileRequired()
  await checkNewWallet(c.ip, wallet, now)
  if (await isWalletBlocked(wallet)) throw walletBlocked()
}

// ── Open ─────────────────────────────────────────────────────────────────────

/** Not deleted, switched on, and now inside its window. */
function running(g: GiveawayRow, now: Date): boolean {
  if (g.deletedAt || g.deleteState || !g.enabled) return false
  if (g.startsAt && now.getTime() < g.startsAt.getTime()) return false
  if (g.endsAt && now.getTime() >= g.endsAt.getTime()) return false
  return true
}

/** Test (Amoy) giveaways show only when their owner is a Virvi admin. */
async function visible(g: GiveawayRow, exec: Exec = db): Promise<boolean> {
  return g.chain === 'polygon' || (g.chain === 'polygon-amoy' && (await isVirviAdmin(g.ownerId, exec)))
}

async function itemsOf(exec: Exec, giveawayId: string): Promise<ItemRow[]> {
  const rows = await exec.select().from(giveawayItems).where(eq(giveawayItems.giveawayId, giveawayId))
  // Item ids are decimal strings: by length, then as strings, is numeric order without parsing (a bad id can't throw)
  const id = (r: ItemRow) => r.itemId ?? ''
  return rows.sort((a, b) => (a.contractAddress ?? '').toLowerCase().localeCompare((b.contractAddress ?? '').toLowerCase()) ||
    id(a).length - id(b).length || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0))
}

/**
 * Claims queued for this item in any giveaway (it may be in several, and they share its supply): queued claims with a
 * mint row for its contract not yet sent, in giveaways that have the item.
 */
async function queuedForItem(exec: Exec, item: ItemRow): Promise<number> {
  const [row] = await exec.select({ n: sql<number>`count(*)::int` }).from(giveawayClaimMints)
    .innerJoin(giveawayClaims, eq(giveawayClaims.id, giveawayClaimMints.claimId))
    .where(and(
      sql`lower(${giveawayClaimMints.contractAddress}) = ${item.contractAddress!.toLowerCase()}`,
      sql`${giveawayClaimMints.status} in ('waiting', 'minting')`,
      sql`${giveawayClaims.status} in ('waiting', 'minting')`,
      sql`exists (select 1 from giveaway_items i where i.giveaway_id = ${giveawayClaims.giveawayId}
        and lower(i.contract_address) = ${item.contractAddress!.toLowerCase()} and i.item_id = ${item.itemId})`,
    ))
  return row?.n ?? 0
}

/**
 * Why a running giveaway takes no new claim, or null when it does: `closed` at the cap (claims past `present` that
 * haven't failed count toward it), `sold_out` without supply.
 */
async function shut(exec: Exec, g: GiveawayRow, items: ItemRow[]): Promise<'closed' | 'sold_out' | null> {
  if (g.claimCap !== null) {
    const [row] = await exec.select({ n: sql<number>`count(*)::int` }).from(giveawayClaims)
      .where(and(eq(giveawayClaims.giveawayId, g.id), notInArray(giveawayClaims.status, ['present', 'failed'])))
    if ((row?.n ?? 0) >= g.claimCap) return 'closed'
  }
  // Sold out: an item the last mint check found sold out, or whose supply the claims queued for it (in any giveaway)
  // already take. A recoverable pause (not_minter, not_approved, low gas) keeps the card: claims queue and mint once fixed
  if (!items.length || items.some((i) => !i.contractAddress || !i.itemId || i.mintState === 'sold_out' || i.remaining === null)) {
    return 'sold_out'
  }
  for (const i of items) if (i.remaining! <= (await queuedForItem(exec, i))) return 'sold_out'
  return null
}

/** The scene's giveaways that are running and visible, the oldest start first. */
async function sceneGiveaways(sceneId: string, now: Date): Promise<GiveawayRow[]> {
  const rows = await db.select({ g: giveaways }).from(giveaways)
    .innerJoin(giveawayScenes, and(eq(giveawayScenes.giveawayId, giveaways.id), eq(giveawayScenes.sceneId, sceneId)))
    .where(and(isNull(giveaways.deletedAt), eq(giveaways.enabled, true)))
    .orderBy(sql`${giveaways.startsAt} asc nulls first`, asc(giveaways.createdAt), asc(giveaways.id))
  const out: GiveawayRow[] = []
  for (const { g } of rows) if (running(g, now) && (await visible(g))) out.push(g)
  return out
}

/** The giveaway, when it is linked to this scene, not deleted and visible; 404 otherwise. */
async function giveawayOnScene(sceneId: string, id: string): Promise<GiveawayRow> {
  if (!UUID.test(sceneId) || !UUID.test(id)) throw notFound()
  const [hit] = await db.select({ g: giveaways }).from(giveaways)
    .innerJoin(giveawayScenes, and(eq(giveawayScenes.giveawayId, giveaways.id), eq(giveawayScenes.sceneId, sceneId)))
    .where(and(eq(giveaways.id, id), isNull(giveaways.deletedAt)))
  if (!hit || !(await visible(hit.g))) throw notFound()
  return hit.g
}

// ── Views ────────────────────────────────────────────────────────────────────

async function myClaim(exec: Exec, giveawayId: string, userId: string): Promise<ClaimRow | null> {
  const [row] = await exec.select().from(giveawayClaims).where(and(eq(giveawayClaims.giveawayId, giveawayId), eq(giveawayClaims.userId, userId)))
  return row ?? null
}

/** The claim's first mint transaction with a hash, as an explorer link. */
async function txUrlOf(g: GiveawayRow, claimId: string): Promise<string | null> {
  const [tx] = await db.select({ hash: giveawayTxs.txHash }).from(giveawayClaimMints)
    .innerJoin(giveawayTxs, eq(giveawayTxs.id, giveawayClaimMints.txId))
    .where(and(eq(giveawayClaimMints.claimId, claimId), isNotNull(giveawayTxs.txHash)))
    .orderBy(asc(giveawayClaimMints.contractAddress)).limit(1)
  return tx?.hash ? giveawayTxUrl(g.chain, tx.hash) : null
}

/** A queued claim the card shows as "Still sending": the giveaway is paused, or it was claimed a while ago. */
function delayed(g: GiveawayRow, claim: ClaimRow, now: Date): boolean {
  if (claim.status !== 'waiting' && claim.status !== 'minting') return false
  if (g.pausedReason) return true
  return !!claim.claimedAt && now.getTime() - claim.claimedAt.getTime() > GIVEAWAY_DELAYED_AFTER_MS
}

async function toVisitor(g: GiveawayRow, items: ItemRow[], claim: ClaimRow | null): Promise<VisitorGiveaway> {
  return {
    id: g.id,
    name: g.name,
    items: items.map((i) => ({ name: i.name ?? '', thumbnail: i.imageUrl, rarity: i.rarity })),
    endsAt: g.endsAt?.toISOString() ?? null,
    minPresentSeconds: g.minPresentSeconds,
    test: g.chain === 'polygon-amoy',
    claim: claim ? {
      status: claim.status ?? 'present', secondsPresent: claim.secondsPresent ?? 0,
      txUrl: claim.status === 'sent' ? await txUrlOf(g, claim.id) : null, failReason: claim.failReason,
      delayed: delayed(g, claim, new Date()),
    } : null,
  }
}

async function visitorView(giveawayId: string, userId: string): Promise<{ giveaway: VisitorGiveaway }> {
  const g = await db.query.giveaways.findFirst({ where: eq(giveaways.id, giveawayId) })
  if (!g) throw notFound()
  return { giveaway: await toVisitor(g, await itemsOf(db, g.id), await myClaim(db, g.id, userId)) }
}

/** The scene's first open giveaway (running, visible, below its cap and with supply left), or null. */
async function openGiveaway(sceneId: string, now: Date): Promise<{ g: GiveawayRow; items: ItemRow[] } | null> {
  for (const g of await sceneGiveaways(sceneId, now)) {
    const items = await itemsOf(db, g.id)
    if (!(await shut(db, g, items))) return { g, items }
  }
  return null
}

/**
 * The scene's giveaway for the card: the open one with the oldest start. With none open, one still running where the
 * caller has claimed (past `present`), so "Sent ✓" stays visible until it ends. Null otherwise.
 */
export async function currentGiveaway(sceneId: string, userId: string, now = new Date()): Promise<VisitorGiveaway | null> {
  if (!UUID.test(sceneId)) return null
  const open = await openGiveaway(sceneId, now)
  if (open) return toVisitor(open.g, open.items, await myClaim(db, open.g.id, userId))
  for (const g of await sceneGiveaways(sceneId, now)) {
    const claim = await myClaim(db, g.id, userId)
    if (claim && claim.status !== 'present') return toVisitor(g, await itemsOf(db, g.id), claim)
  }
  return null
}

/** For the room's `giveaway_available` (guests can't use REST): the scene's open giveaway, name and test flag only. */
export async function availableGiveaway(sceneId: string, now = new Date()): Promise<AvailableGiveaway | null> {
  if (!UUID.test(sceneId)) return null
  const open = await openGiveaway(sceneId, now)
  return open ? { name: open.g.name, test: open.g.chain === 'polygon-amoy' } : null
}

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * Consent: needs a verified wallet that passes the BEAT wallet checks and the current consent version. Records a
 * `present` claim on an open giveaway; tracking again returns the caller's claim as it is. Each wallet joins a giveaway
 * once, on whichever account (409 already_claimed).
 */
export async function trackGiveaway(
  sceneId: string, id: string, c: VisitorCaller, consentVersion: unknown, now = new Date(),
): Promise<{ giveaway: VisitorGiveaway }> {
  const g = await giveawayOnScene(sceneId, id)
  if (!c.wallet) throw new GiveawayError(403, 'wallet_required', 'Connect a wallet to claim.')
  if (consentVersion !== GIVEAWAY_CONSENT_VERSION) {
    throw new GiveawayError(400, 'consent_outdated', 'This scene needs an update before visitors can claim this giveaway. Ask the host to update it.')
  }
  if (await myClaim(db, g.id, c.userId)) return visitorView(g.id, c.userId)
  if (!running(g, now)) throw closed()
  const why = await shut(db, g, await itemsOf(db, g.id))
  if (why === 'sold_out') throw soldOut()
  if (why) throw closed()
  await walletChecks(c, c.wallet, now)
  const wallet = c.wallet.toLowerCase()
  await db.insert(giveawayClaims).values({
    giveawayId: g.id, userId: c.userId, wallet, consentVersion: GIVEAWAY_CONSENT_VERSION, consentedAt: now, lastSeenAt: now, createdAt: now,
  }).onConflictDoNothing()
  const mine = await myClaim(db, g.id, c.userId)
  if (!mine || mine.wallet !== wallet) throw new GiveawayError(409, 'already_claimed', 'This wallet already claimed this giveaway.')
  return visitorView(g.id, c.userId)
}

/** The seconds of [now - addSeconds, now] that fall inside the giveaway's window. */
function inWindowSeconds(g: GiveawayRow, now: Date, addSeconds: number): number {
  const from = Math.max(now.getTime() - addSeconds * 1000, g.startsAt?.getTime() ?? -Infinity)
  const to = Math.min(now.getTime(), g.endsAt?.getTime() ?? Infinity)
  return to > from ? Math.floor((to - from) / 1000) : 0
}

/**
 * A check-in: the time since the last one (checkInDelta, capped) counts while the claim is `present`, but only the part
 * inside the window and since the user's live room connection from this scene opened (beats/live.ts, the same store
 * BEATs use). With no live connection the check-in is accepted and credits nothing.
 */
export async function checkInGiveaway(sceneId: string, id: string, userId: string, now = new Date()): Promise<{ giveaway: VisitorGiveaway }> {
  const g = await giveawayOnScene(sceneId, id)
  const liveSince = await beatLiveSince(sceneId, userId)
  await db.transaction(async (tx) => {
    const [claim] = await tx.select().from(giveawayClaims).where(and(eq(giveawayClaims.giveawayId, g.id), eq(giveawayClaims.userId, userId))).for('update')
    if (!claim) throw notTracking()
    if (claim.status !== 'present') return
    const { accepted, addSeconds } = checkInDelta(claim.lastSeenAt, now)
    if (!accepted) return
    const live = liveSince === null ? 0 : Math.max(0, Math.min(addSeconds, Math.floor((now.getTime() - liveSince) / 1000)))
    const add = inWindowSeconds(g, now, live)
    await tx.update(giveawayClaims).set({ lastSeenAt: now, secondsPresent: sql`coalesce(${giveawayClaims.secondsPresent}, 0) + ${add}` })
      .where(eq(giveawayClaims.id, claim.id))
  })
  return visitorView(g.id, userId)
}

/**
 * Claim: a `present` claim with the minimum time, on a giveaway still open. Under the giveaway row's lock, so concurrent
 * claims count the cap and the supply one at a time. Queues the claim as `waiting` with one mint row per distinct
 * collection contract. A claim already further along is returned as it is.
 */
export async function claimGiveaway(
  sceneId: string, id: string, c: Pick<VisitorCaller, 'userId' | 'platform' | 'ip'>, now = new Date(),
): Promise<{ giveaway: VisitorGiveaway }> {
  const seen = await giveawayOnScene(sceneId, id)
  const pre = await myClaim(db, seen.id, c.userId)
  if (!pre) throw notTracking()
  if (pre.status === 'present') await walletChecks(c, pre.wallet, now)
  await db.transaction(async (tx) => {
    const [g] = await tx.select().from(giveaways).where(eq(giveaways.id, seen.id)).for('update')
    if (!g) throw notFound()
    const [claim] = await tx.select().from(giveawayClaims).where(and(eq(giveawayClaims.giveawayId, g.id), eq(giveawayClaims.userId, c.userId))).for('update')
    if (!claim) throw notTracking()
    if (claim.status !== 'present') return
    const seconds = claim.secondsPresent ?? 0
    if (seconds < g.minPresentSeconds) {
      throw new GiveawayError(409, 'too_soon', "You haven't been here long enough yet.", { secondsLeft: g.minPresentSeconds - seconds })
    }
    if (!running(g, now)) throw closed()
    const items = await itemsOf(tx, g.id)
    // Giveaways sharing an item share its supply: claims on the same item take turns (in a fixed order, so no deadlock)
    const keys = [...new Set(items.map((i) => `giveaway-item:${(i.contractAddress ?? '').toLowerCase()}:${i.itemId ?? ''}`))].sort()
    for (const k of keys) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${k}))`)
    const why = await shut(tx, g, items)
    if (why === 'sold_out') throw soldOut()
    if (why) throw closed()
    await tx.update(giveawayClaims).set({ status: 'waiting', claimedAt: sql`clock_timestamp()` }).where(eq(giveawayClaims.id, claim.id))
    const contracts = new Map<string, string>()
    for (const i of items) if (i.contractAddress && !contracts.has(i.contractAddress.toLowerCase())) contracts.set(i.contractAddress.toLowerCase(), i.contractAddress)
    await tx.insert(giveawayClaimMints).values([...contracts.values()].map((contractAddress) => ({ claimId: claim.id, contractAddress })))
  })
  return visitorView(seen.id, c.userId)
}

/** Stop: deletes the caller's `present` claim. Once claimed it stays (409 claimed). */
export async function stopGiveaway(sceneId: string, id: string, userId: string): Promise<void> {
  if (!UUID.test(sceneId) || !UUID.test(id)) throw notFound()
  const [linked] = await db.select({ id: giveawayScenes.giveawayId }).from(giveawayScenes)
    .where(and(eq(giveawayScenes.giveawayId, id), eq(giveawayScenes.sceneId, sceneId)))
  if (!linked) throw notFound()
  const claim = await myClaim(db, id, userId)
  if (!claim) throw notTracking()
  const gone = await db.delete(giveawayClaims).where(and(eq(giveawayClaims.id, claim.id), eq(giveawayClaims.status, 'present')))
    .returning({ id: giveawayClaims.id })
  if (!gone.length) throw new GiveawayError(409, 'claimed', "You've claimed this giveaway, so it can't be stopped.")
}
