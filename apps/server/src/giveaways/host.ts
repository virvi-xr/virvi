import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { getAddress } from 'ethers'
import {
  GIVEAWAY_CHAINS, GIVEAWAY_CLAIM_STATUSES, giveawayBuilderUrl, giveawayTxUrl, shortWallet,
  type GiveawayChain, type GiveawayClaimStatus, type GiveawayMintState, type HostGiveaway,
} from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { giveawayClaimMints, giveawayClaims, giveawayItems, giveaways, giveawayScenes, giveawayTxs } from '../db/schema.js'
import type { Actor } from '../auth/actor.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { mayRunBeatsIn, sceneExists } from '../beats/service.js'
import { GIVEAWAY_TRANSFER_GAS, GiveawayRpcError, giveawayChainClient, type GiveawayChainClient } from './chain.js'
import { GiveawayError } from './errors.js'
import { newGiveawayWallet } from './keys.js'
import { creatorItems } from './marketplace.js'
import { accounting, fundingView, ownerIsPaid, walletBalance, withdrawableWei, type GiveawayRow } from './funding.js'

/**
 * Automatic giveaways (LIV-194), the host side: create, edit, pick items and scenes, read, the claims list, send back
 * and delete. No Fastify here; the routes pass in who is calling. Only the owner or a Virvi admin sees a giveaway
 * (404 for anyone else). Nothing returned here carries the wallet's key, and nothing logs a wallet or a name.
 */

export { GiveawayError } from './errors.js'

/** Who is calling: their account, their scene access actor (for the scene check), and whether they are a Virvi admin. */
export interface GiveawayCaller { userId: string; admin: boolean; actor: Actor }

export type GiveawayMintCheck = { itemId: string; contractAddress: string; state: GiveawayMintState; remaining: number }

export const GIVEAWAY_NAME_MAX = 80
export const GIVEAWAY_ITEMS_MAX = 10
export const GIVEAWAY_SCENES_MAX = 20
export const GIVEAWAY_MIN_PRESENT_MAX_SECONDS = 7200
const CLAIMS_PAGE = 50

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTRACT = /^0x[0-9a-fA-F]{40}$/
const ITEM_ID = /^\d{1,30}$/
const OPEN_TX = ['sending', 'sent'] as const

const notFound = () => new GiveawayError(404, 'not_found', 'Giveaway not found.')
const rpcDown = () => new GiveawayError(502, 'rpc_down', "Polygon isn't answering right now. Try again in a minute.")
const busy = () => new GiveawayError(409, 'busy', 'Try again in a minute.')

// ── Access ───────────────────────────────────────────────────────────────────

async function load(c: GiveawayCaller, id: string): Promise<GiveawayRow> {
  if (typeof id !== 'string' || !UUID.test(id)) throw notFound()
  const g = await db.query.giveaways.findFirst({ where: and(eq(giveaways.id, id), isNull(giveaways.deletedAt)) })
  if (!g || (g.ownerId !== c.userId && !c.admin)) throw notFound()
  return g
}

/** A giveaway being deleted (its float going back to the tank) takes no more changes. */
function refuseWhileDeleting(g: GiveawayRow) {
  if (g.deleteState === 'returning') throw new GiveawayError(409, 'deleting', 'This giveaway is being deleted.')
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseName(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || [...v.trim()].length > GIVEAWAY_NAME_MAX) {
    throw new GiveawayError(400, 'bad_name', `Give the giveaway a name of 1 to ${GIVEAWAY_NAME_MAX} characters.`)
  }
  return v.trim()
}

function parseTime(v: unknown, label: string): Date | null {
  if (v === null) return null
  const d = typeof v === 'string' ? new Date(v) : null
  if (!d || Number.isNaN(d.getTime())) throw new GiveawayError(400, 'bad_window', `Pick a valid ${label} time.`)
  return d
}

// ── Mint check ───────────────────────────────────────────────────────────────

type ItemRef = { contractAddress: string; itemId: string }

async function checkItems(g: GiveawayRow, items: ItemRef[], client: GiveawayChainClient = giveawayChainClient(g.chain)): Promise<GiveawayMintCheck[]> {
  return Promise.all(items.map(async ({ contractAddress, itemId }) => {
    if (!g.walletAddress) return { contractAddress, itemId, state: 'not_minter' as const, remaining: 0 }
    const s = await client.itemState(contractAddress, itemId, g.walletAddress)
    const state: GiveawayMintState = !s.approved || !s.completed ? 'not_approved' : !s.canMint ? 'not_minter' : s.remaining === 0n ? 'sold_out' : 'ready'
    const remaining = s.remaining > 2_147_483_647n ? 2_147_483_647 : Number(s.remaining)
    return { contractAddress, itemId, state, remaining }
  }))
}

const byItem = (a: { contractAddress: string | null; itemId: string | null }, b: { contractAddress: string | null; itemId: string | null }) =>
  (a.contractAddress ?? '').toLowerCase().localeCompare((b.contractAddress ?? '').toLowerCase()) ||
  Number(BigInt(a.itemId ?? '0') - BigInt(b.itemId ?? '0'))

/**
 * Reads every item's minter state on chain and stores it on the item (mintState, remaining, checkedAt). Items without a
 * contract (rows from before LIV-194) are left out. Throws the chain's GiveawayRpcError. `client` defaults to the chain's.
 */
export async function mintCheck(g: GiveawayRow, client?: GiveawayChainClient): Promise<GiveawayMintCheck[]> {
  const rows = (await db.select().from(giveawayItems).where(eq(giveawayItems.giveawayId, g.id))).sort(byItem)
  const refs = rows.filter((r) => r.contractAddress && r.itemId)
  const results = await checkItems(g, refs.map((r) => ({ contractAddress: r.contractAddress!, itemId: r.itemId! })), client)
  const now = new Date()
  for (const [i, r] of refs.entries()) {
    await db.update(giveawayItems).set({ mintState: results[i].state, remaining: results[i].remaining, checkedAt: now }).where(eq(giveawayItems.id, r.id))
  }
  return results
}

// ── Views ────────────────────────────────────────────────────────────────────

/** The fields the list shows. */
function lightView(g: GiveawayRow) {
  return {
    id: g.id, name: g.name, chain: g.chain, enabled: g.enabled, walletAddress: g.walletAddress, builderUrl: giveawayBuilderUrl(g.chain),
    startsAt: g.startsAt?.toISOString() ?? null, endsAt: g.endsAt?.toISOString() ?? null, claimCap: g.claimCap,
    minPresentSeconds: g.minPresentSeconds, pausedReason: g.pausedReason, deleteState: g.deleteState ?? null,
    createdAt: g.createdAt.toISOString(),
  }
}

async function view(g: GiveawayRow): Promise<HostGiveaway> {
  // A fresh minter check when the chain answers; the last stored one when it doesn't
  try {
    await mintCheck(g)
  } catch (e) {
    if (!(e instanceof GiveawayRpcError)) throw e
  }
  let funding: HostGiveaway['funding']
  try {
    funding = await fundingView(g)
  } catch (e) {
    if (e instanceof GiveawayRpcError) throw rpcDown()
    throw e
  }
  const [items, scenes, counted] = await Promise.all([
    db.select().from(giveawayItems).where(eq(giveawayItems.giveawayId, g.id)),
    db.select({ sceneId: giveawayScenes.sceneId }).from(giveawayScenes).where(eq(giveawayScenes.giveawayId, g.id)),
    db.select({ status: giveawayClaims.status, n: sql<number>`count(*)::int` }).from(giveawayClaims)
      .where(eq(giveawayClaims.giveawayId, g.id)).groupBy(giveawayClaims.status),
  ])
  const counts = Object.fromEntries(GIVEAWAY_CLAIM_STATUSES.map((s) => [s, 0])) as Record<GiveawayClaimStatus, number>
  for (const r of counted) if (r.status && r.status in counts) counts[r.status] = r.n
  return {
    id: g.id, name: g.name, chain: g.chain, enabled: g.enabled, walletAddress: g.walletAddress, builderUrl: giveawayBuilderUrl(g.chain),
    startsAt: g.startsAt?.toISOString() ?? null, endsAt: g.endsAt?.toISOString() ?? null, claimCap: g.claimCap,
    minPresentSeconds: g.minPresentSeconds, pausedReason: g.pausedReason, pausedAt: g.pausedAt?.toISOString() ?? null,
    deleteState: g.deleteState ?? null,
    items: items.sort(byItem).map((i) => ({
      id: i.id, contractAddress: i.contractAddress, itemId: i.itemId, name: i.name, thumbnail: i.imageUrl, rarity: i.rarity,
      mintState: i.mintState, remaining: i.remaining, checkedAt: i.checkedAt?.toISOString() ?? null,
    })),
    sceneIds: scenes.map((s) => s.sceneId),
    funding,
    counts,
  }
}

/** One giveaway as its host sees it: items with a fresh minter check, scenes, funding, the wallet address, claim counts. */
export async function hostView(c: GiveawayCaller, id: string): Promise<HostGiveaway> {
  return view(await load(c, id))
}

/** The caller's own giveaways (not deleted), newest first. */
export async function listGiveaways(c: GiveawayCaller) {
  const rows = await db.select().from(giveaways)
    .where(and(eq(giveaways.ownerId, c.userId), isNull(giveaways.deletedAt))).orderBy(desc(giveaways.createdAt))
  return rows.map(lightView)
}

/** Is automatic giving on, and would this caller's gas be covered. */
export async function giveawayAvailability(userId: string) {
  const enabled = config.giveaways.enabled
  return { enabled, gasCovered: enabled && !!config.giveaways.gasKey && (await ownerIsPaid(userId)) }
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** A new giveaway, switched off, with its own wallet. Amoy (test) giveaways are for Virvi admins only. */
export async function createGiveaway(c: GiveawayCaller, body: Record<string, unknown>) {
  const name = parseName(body.name)
  const chain = (body.chain ?? 'polygon') as GiveawayChain
  if (!GIVEAWAY_CHAINS.includes(chain)) throw new GiveawayError(400, 'bad_chain', 'Pick Polygon.')
  if (chain === 'polygon-amoy' && !c.admin) throw new GiveawayError(403, 'forbidden', 'Test giveaways are for Virvi admins.')
  const wallet = newGiveawayWallet()
  const [g] = await db.insert(giveaways).values({
    ownerId: c.userId, name, chain, enabled: false, walletAddress: wallet.address, walletKeyEnc: wallet.keyEnc,
  }).returning()
  return lightView(g)
}

/**
 * Edits a giveaway. Switching it on needs at least one item and one scene, and every item passing the minter check
 * (409 not_ready, with the failing items).
 */
export async function updateGiveaway(c: GiveawayCaller, id: string, patch: Record<string, unknown>): Promise<HostGiveaway> {
  const g = await load(c, id)
  refuseWhileDeleting(g)
  const set: Partial<typeof giveaways.$inferInsert> = {}
  if (patch.name !== undefined) set.name = parseName(patch.name)
  if (patch.startsAt !== undefined) set.startsAt = parseTime(patch.startsAt, 'start')
  if (patch.endsAt !== undefined) set.endsAt = parseTime(patch.endsAt, 'end')
  const startsAt = set.startsAt !== undefined ? set.startsAt : g.startsAt
  const endsAt = set.endsAt !== undefined ? set.endsAt : g.endsAt
  if ((patch.startsAt !== undefined || patch.endsAt !== undefined) && startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new GiveawayError(400, 'bad_window', 'The giveaway must end after it starts.')
  }
  if (patch.claimCap !== undefined) {
    const v = patch.claimCap
    if (v !== null && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 2_147_483_647)) {
      throw new GiveawayError(400, 'bad_cap', 'The claim limit must be a whole number of at least 1, or none.')
    }
    set.claimCap = v as number | null
  }
  if (patch.minPresentSeconds !== undefined) {
    const v = patch.minPresentSeconds
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > GIVEAWAY_MIN_PRESENT_MAX_SECONDS) {
      throw new GiveawayError(400, 'bad_min_present', `The time in the scene must be 0 to ${GIVEAWAY_MIN_PRESENT_MAX_SECONDS / 60} minutes.`)
    }
    set.minPresentSeconds = v as number
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new GiveawayError(400, 'bad_request', 'Enabled must be true or false.')
    if (patch.enabled && !g.enabled) await refuseUnlessReady(g)
    set.enabled = patch.enabled
  }
  if (Object.keys(set).length) {
    await db.update(giveaways).set({ ...set, updatedAt: new Date() }).where(eq(giveaways.id, g.id))
  }
  return view((await db.query.giveaways.findFirst({ where: eq(giveaways.id, g.id) }))!)
}

async function refuseUnlessReady(g: GiveawayRow) {
  const [items, [scenes]] = await Promise.all([
    db.select({ contractAddress: giveawayItems.contractAddress, itemId: giveawayItems.itemId }).from(giveawayItems).where(eq(giveawayItems.giveawayId, g.id)),
    db.select({ n: sql<number>`count(*)::int` }).from(giveawayScenes).where(eq(giveawayScenes.giveawayId, g.id)),
  ])
  const notReady = (message: string, failing: GiveawayMintCheck[] = []) => new GiveawayError(409, 'not_ready', message, { items: failing })
  if (!items.length || items.some((i) => !i.contractAddress || !i.itemId)) throw notReady('Pick the items to give away first.')
  if (!scenes?.n) throw notReady('Pick a scene for the giveaway first.')
  let checks: GiveawayMintCheck[]
  try {
    checks = await mintCheck(g)
  } catch (e) {
    if (e instanceof GiveawayRpcError) throw rpcDown()
    throw e
  }
  const failing = checks.filter((r) => r.state !== 'ready')
  if (failing.length) throw notReady('Every item must pass the minter check before the giveaway can be switched on.', failing)
}

function parseItems(v: unknown): ItemRef[] {
  const bad = () => new GiveawayError(400, 'bad_items', `Pick 1 to ${GIVEAWAY_ITEMS_MAX} different items.`)
  if (!Array.isArray(v) || v.length < 1 || v.length > GIVEAWAY_ITEMS_MAX) throw bad()
  const out: ItemRef[] = []
  const seen = new Set<string>()
  for (const raw of v as Array<Record<string, unknown>>) {
    const contract = raw?.contractAddress
    const itemId = raw?.itemId
    if (typeof contract !== 'string' || !CONTRACT.test(contract) || typeof itemId !== 'string' || !ITEM_ID.test(itemId)) throw bad()
    const key = `${contract.toLowerCase()}:${itemId}`
    if (seen.has(key)) throw bad()
    seen.add(key)
    out.push({ contractAddress: getAddress(contract.toLowerCase()), itemId })
  }
  return out
}

/**
 * Replaces the giveaway's items: 1 to 10, each one the owner's verified wallets created (400 not_your_item), with its
 * name, thumbnail and rarity cached. Refused (409 has_claims) once any claim is past `present`. On a giveaway that is
 * switched on, the new items must pass the minter check too.
 */
export async function setItems(c: GiveawayCaller, id: string, body: Record<string, unknown>): Promise<HostGiveaway> {
  const g = await load(c, id)
  refuseWhileDeleting(g)
  const wanted = parseItems(body.items)
  const hasClaims = () => new GiveawayError(409, 'has_claims', "The items can't change once someone has claimed this giveaway.")
  const claimedIn = async (exec: Pick<typeof db, 'select'>) => (await exec.select({ id: giveawayClaims.id }).from(giveawayClaims)
    .where(and(eq(giveawayClaims.giveawayId, g.id), ne(giveawayClaims.status, 'present'))).limit(1)).length > 0
  // Checked early so a refused request skips the Marketplace and chain calls, and again under the lock below
  if (await claimedIn(db)) throw hasClaims()

  const mine = await creatorItems(g.chain, await verifiedWalletsOf(g.ownerId))
  const found = wanted.map((w) => mine.find((m) => m.contractAddress.toLowerCase() === w.contractAddress.toLowerCase() && m.itemId === w.itemId))
  const missing = wanted.find((_, i) => !found[i])
  if (missing) {
    throw new GiveawayError(400, 'not_your_item', 'Pick items from collections you created, with a wallet linked to your account.', { ...missing })
  }
  if (g.enabled) {
    let checks: GiveawayMintCheck[]
    try {
      checks = await checkItems(g, wanted)
    } catch (e) {
      if (e instanceof GiveawayRpcError) throw rpcDown()
      throw e
    }
    const failing = checks.filter((r) => r.state !== 'ready')
    if (failing.length) throw new GiveawayError(409, 'not_ready', 'Every item must pass the minter check while the giveaway is on.', { items: failing })
  }
  await db.transaction(async (tx) => {
    await tx.select({ id: giveaways.id }).from(giveaways).where(eq(giveaways.id, g.id)).for('update')
    if (await claimedIn(tx)) throw hasClaims()
    await tx.delete(giveawayItems).where(eq(giveawayItems.giveawayId, g.id))
    await tx.insert(giveawayItems).values(found.map((m) => ({
      giveawayId: g.id, contractAddress: m!.contractAddress, itemId: m!.itemId, name: m!.name, imageUrl: m!.thumbnail, rarity: m!.rarity,
    })))
  })
  return view(g)
}

/** Replaces the scenes the giveaway shows in; the caller must be able to run events in each (403 otherwise). */
export async function setScenes(c: GiveawayCaller, id: string, body: Record<string, unknown>): Promise<HostGiveaway> {
  const g = await load(c, id)
  refuseWhileDeleting(g)
  const v = body.sceneIds
  if (!Array.isArray(v) || v.length > GIVEAWAY_SCENES_MAX || !v.every((s) => typeof s === 'string' && UUID.test(s)) ||
    new Set(v.map((s: string) => s.toLowerCase())).size !== v.length) {
    throw new GiveawayError(400, 'bad_scenes', `Pick up to ${GIVEAWAY_SCENES_MAX} different scenes.`)
  }
  const sceneIds = (v as string[]).map((s) => s.toLowerCase())
  if (!sceneIds.length && g.enabled) throw new GiveawayError(409, 'not_ready', 'A giveaway that is on needs a scene.', { items: [] })
  for (const sceneId of sceneIds) {
    if (!(await sceneExists(sceneId)) || !(await mayRunBeatsIn(c, sceneId))) {
      throw new GiveawayError(403, 'forbidden', "You can't run events in every one of those scenes.")
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(giveawayScenes).where(eq(giveawayScenes.giveawayId, g.id))
    if (sceneIds.length) await tx.insert(giveawayScenes).values(sceneIds.map((sceneId) => ({ giveawayId: g.id, sceneId })))
  })
  return view(g)
}

// ── Claims ───────────────────────────────────────────────────────────────────

// The cursor keeps created_at to the microsecond, as Postgres stores it (a JS Date would drop to milliseconds and skip
// rows created later in the same millisecond), and is compared in SQL
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const cursorAtSql = sql<string>`to_char(${giveawayClaims.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString('base64url')
function decodeCursor(v: unknown): { at: string; id: string } | null {
  if (v === undefined || v === null || v === '') return null
  const bad = () => new GiveawayError(400, 'bad_cursor', 'That page link is no longer valid.')
  if (typeof v !== 'string') throw bad()
  const [at, id] = Buffer.from(v, 'base64url').toString('utf8').split('|')
  if (!at || !CURSOR_AT.test(at) || !id || !UUID.test(id)) throw bad()
  return { at, id }
}

/** The claims, newest first, 50 a page: short wallet, status, times and the Polygonscan links of the sent mints. */
export async function listClaims(c: GiveawayCaller, id: string, cursor?: unknown) {
  const g = await load(c, id)
  const after = decodeCursor(cursor)
  const found = await db.select({ claim: giveawayClaims, cursorAt: cursorAtSql }).from(giveawayClaims)
    .where(and(
      eq(giveawayClaims.giveawayId, g.id),
      after ? sql`(${giveawayClaims.createdAt}, ${giveawayClaims.id}) < (${after.at}::timestamptz, ${after.id}::uuid)` : undefined,
    ))
    .orderBy(desc(giveawayClaims.createdAt), desc(giveawayClaims.id)).limit(CLAIMS_PAGE + 1)
  const rows = found.map((r) => r.claim)
  const page = rows.slice(0, CLAIMS_PAGE)
  const hashes = new Map<string, string[]>()
  if (page.length) {
    const mints = await db.select({ claimId: giveawayClaimMints.claimId, txHash: giveawayTxs.txHash }).from(giveawayClaimMints)
      .innerJoin(giveawayTxs, eq(giveawayTxs.id, giveawayClaimMints.txId))
      .where(and(inArray(giveawayClaimMints.claimId, page.map((r) => r.id)), eq(giveawayClaimMints.status, 'sent'), isNotNull(giveawayTxs.txHash)))
    for (const m of mints) hashes.set(m.claimId, [...(hashes.get(m.claimId) ?? []), m.txHash!])
  }
  const last = found[page.length - 1]
  return {
    claims: page.map((r) => {
      const txUrls = (hashes.get(r.id) ?? []).sort().map((h) => giveawayTxUrl(g.chain, h))
      return {
        id: r.id, wallet: shortWallet(r.wallet), status: r.status, failReason: r.failReason,
        claimedAt: r.claimedAt?.toISOString() ?? null, sentAt: r.sentAt?.toISOString() ?? null,
        txUrl: txUrls[0] ?? null, txUrls,
      }
    }),
    nextCursor: rows.length > CLAIMS_PAGE && last ? encodeCursor(last.cursorAt, last.claim.id) : null,
  }
}

// ── Send back and delete ─────────────────────────────────────────────────────

async function openTxFrom(exec: Pick<typeof db, 'select'>, address: string) {
  const [open] = await exec.select({ id: giveawayTxs.id }).from(giveawayTxs)
    .where(and(eq(giveawayTxs.fromAddress, address), inArray(giveawayTxs.status, [...OPEN_TX]))).limit(1)
  return !!open
}

/** The host's withdrawable POL and the gas of one plain transfer at today's fees. */
async function withdrawable(g: GiveawayRow): Promise<{ withdrawable: bigint; transferGas: bigint }> {
  try {
    const [balance, fees, acc] = await Promise.all([walletBalance(g), giveawayChainClient(g.chain).feeData(), accounting(g.id)])
    return { withdrawable: withdrawableWei(balance, acc), transferGas: GIVEAWAY_TRANSFER_GAS * fees.maxFeePerGas }
  } catch (e) {
    if (e instanceof GiveawayRpcError) throw rpcDown()
    throw e
  }
}

/**
 * Queues the host's withdrawable POL, less the transfer's gas, to one of the owner's verified wallets: a `withdraw` row
 * in `sending` with no signed transaction yet, which the minting job signs and broadcasts (one sender path). Refused
 * while another transaction from the giveaway wallet is open (409 busy).
 */
export async function sendBack(c: GiveawayCaller, id: string, body: Record<string, unknown>) {
  const g = await load(c, id)
  refuseWhileDeleting(g)
  const to = typeof body.toWallet === 'string' ? body.toWallet.toLowerCase() : ''
  if (!to || !(await verifiedWalletsOf(g.ownerId)).includes(to)) {
    throw new GiveawayError(400, 'not_your_wallet', 'Pick a wallet verified on your account.')
  }
  if (!g.walletAddress) throw new GiveawayError(409, 'nothing_to_send', 'There is no POL of yours to send back.')
  const from = g.walletAddress
  return db.transaction(async (tx) => {
    // One request at a time per giveaway: the open-transaction check and the insert go together
    await tx.select({ id: giveaways.id }).from(giveaways).where(eq(giveaways.id, g.id)).for('update')
    if (await openTxFrom(tx, from)) throw busy()
    const { withdrawable: w, transferGas } = await withdrawable(g)
    const value = w - transferGas
    if (value <= 0n) throw new GiveawayError(409, 'nothing_to_send', 'There is no POL of yours to send back.')
    const [row] = await tx.insert(giveawayTxs).values({
      giveawayId: g.id, chain: g.chain, kind: 'withdraw', fromAddress: from, toAddress: getAddress(to), status: 'sending', valueWei: value.toString(),
    }).returning({ id: giveawayTxs.id })
    return { txId: row.id, valueWei: value.toString(), toWallet: shortWallet(to) }
  })
}

/**
 * Deletes a giveaway: refused (409 send_back_first) while the host has more POL in it than one transfer's gas. Otherwise
 * it is switched off and marked `returning`; the minting job returns Virvi's float and then sets deletedAt.
 */
export async function deleteGiveaway(c: GiveawayCaller, id: string) {
  const g = await load(c, id)
  if (g.deleteState === 'returning') return { id: g.id, deleteState: 'returning' as const }
  if (g.walletAddress) {
    if (await openTxFrom(db, g.walletAddress)) throw busy()
    const { withdrawable: w, transferGas } = await withdrawable(g)
    if (w > transferGas) throw new GiveawayError(409, 'send_back_first', 'Send your POL back before deleting this giveaway.')
  }
  await db.update(giveaways).set({ enabled: false, deleteState: 'returning', updatedAt: new Date() }).where(eq(giveaways.id, g.id))
  return { id: g.id, deleteState: 'returning' as const }
}

/** The items the caller can give away on this chain (Amoy for Virvi admins only). */
export async function listCreatorItems(c: GiveawayCaller, chainParam: unknown) {
  const chain = (chainParam ?? 'polygon') as GiveawayChain
  if (!GIVEAWAY_CHAINS.includes(chain)) throw new GiveawayError(400, 'bad_chain', 'Pick Polygon.')
  if (chain === 'polygon-amoy' && !c.admin) throw new GiveawayError(403, 'forbidden', 'Test giveaways are for Virvi admins.')
  return { items: await creatorItems(chain, await verifiedWalletsOf(c.userId)) }
}
