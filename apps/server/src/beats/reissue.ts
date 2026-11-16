import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import { getAddress, id as keccakText, isAddress } from 'ethers'
import {
  BEAT_CHAINS, BEAT_CHAIN_INFO, BEAT_REISSUE_MAX_BATCH, BEAT_REISSUE_NOTE_MAX, BEAT_REISSUE_OPEN, BEAT_REISSUE_REASON_MAX, beatTxUrl,
  type BeatChain, type BeatReissueBlocker, type BeatReissueItemState, type BeatReissueStatus,
} from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { beatClaims, beatReissueItems, beatReissueRequests, beats, userAuthMethods, users } from '../db/schema.js'
import { beatChainClient, type BeatChainClient } from './chain.js'
import { BeatError } from './errors.js'

/**
 * BEAT reissue (LIV-11): a person whose wallet was compromised asks for their BEATs to go to a new wallet; an admin
 * reviews it; Virvi prepares a Safe Transaction Builder batch for the contract's admin-only `reissue`, which the admin
 * Safe's signers check, sign and send. The server never signs or sends a reissue. The minting job's tick then watches the
 * chain (watchReissues) and, at the confirmation depth, moves each claim to the new wallet.
 *
 * Review (approve or reject) and preparing the batch are separate steps, so a support role can take the first later.
 * Nothing here logs a wallet, a reason or a name.
 */

type Req = typeof beatReissueRequests.$inferSelect
type Item = typeof beatReissueItems.$inferSelect
type Exec = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const lc = (s: string) => s.toLowerCase()
const iso = (d: Date | null) => d?.toISOString() ?? null
const notFound = () => new BeatError(404, 'not_found', 'Request not found.')
const isOpen = (s: BeatReissueStatus) => BEAT_REISSUE_OPEN.includes(s)

// ── The person's requests ──────────────────────────────────────────────────────

export interface ReissueBeat {
  claimId: string | null
  beatId: string | null
  name: string
  chain: BeatChain
  tokenId: string
  tradeable: boolean
  /** In the last prepared batch, left out of it, reissued on chain; null before a batch was prepared for its chain. */
  state: BeatReissueItemState | null
}

export interface PublicReissueRequest {
  id: string
  oldWallet: string
  newWallet: string
  reason: string
  status: BeatReissueStatus
  /** The reviewer's note (shown to the person). */
  reviewNote: string | null
  createdAt: string
  reviewedAt: string | null
  proposedAt: string | null
  doneAt: string | null
  cancelledAt: string | null
  beats: ReissueBeat[]
}

function parseWallet(v: unknown): string {
  if (typeof v !== 'string' || !isAddress(v)) throw new BeatError(400, 'bad_wallet', 'Give both wallets as 0x addresses.')
  return lc(v)
}

function parseNote(v: unknown, required: boolean): string | null {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim() && !required)) {
    if (required) throw new BeatError(400, 'bad_note', 'Say why, for the person.')
    return null
  }
  if (typeof v !== 'string' || !v.trim() || [...v.trim()].length > BEAT_REISSUE_NOTE_MAX) {
    throw new BeatError(400, 'bad_note', `Give a note of 1 to ${BEAT_REISSUE_NOTE_MAX} characters.`)
  }
  return v.trim()
}

/** Whether this wallet is linked to, and verified on, this account (as at sign-in: wallet-users.ts). */
async function walletLinked(exec: Pick<typeof db, 'select'>, userId: string, wallet: string): Promise<boolean> {
  const rows = await exec.select({ metadata: userAuthMethods.metadata }).from(userAuthMethods)
    .where(and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, lc(wallet))))
  return rows.some((r) => (r.metadata as { verified?: unknown } | null)?.verified === true)
}

/** The account's minted claims still on this wallet, with their BEATs. */
async function claimsOnWallet(exec: Pick<typeof db, 'select'>, userId: string, wallet: string) {
  return exec.select({ claim: beatClaims, beat: beats }).from(beatClaims).innerJoin(beats, eq(beats.id, beatClaims.beatId))
    .where(and(eq(beatClaims.userId, userId), eq(beatClaims.status, 'minted'), eq(beatClaims.wallet, lc(wallet)), isNotNull(beats.tokenId)))
    .orderBy(beats.chain, beats.tokenId)
}

/** The request's BEATs: its items (once a batch was prepared), then the claims still on the old wallet that have none. */
async function beatsOf(r: Req): Promise<ReissueBeat[]> {
  const items = await db.select({ item: beatReissueItems, name: beats.name }).from(beatReissueItems)
    .leftJoin(beats, eq(beats.id, beatReissueItems.beatId))
    .where(eq(beatReissueItems.requestId, r.id)).orderBy(beatReissueItems.chain, beatReissueItems.tokenId)
  const out: ReissueBeat[] = items.map(({ item, name }) => ({
    claimId: item.claimId, beatId: item.beatId, name: name ?? '', chain: item.chain, tokenId: String(item.tokenId), tradeable: item.tradeable, state: item.state,
  }))
  if (!isOpen(r.status)) return out
  const seen = new Set(items.map(({ item }) => `${item.chain}:${item.tokenId}`))
  for (const { claim, beat } of await claimsOnWallet(db, r.userId, r.oldWallet)) {
    if (seen.has(`${beat.chain}:${beat.tokenId}`)) continue
    out.push({ claimId: claim.id, beatId: beat.id, name: beat.name, chain: beat.chain, tokenId: String(beat.tokenId), tradeable: beat.tradeable, state: null })
  }
  return out
}

async function toPublic(r: Req): Promise<PublicReissueRequest> {
  return {
    id: r.id, oldWallet: r.oldWallet, newWallet: r.newWallet, reason: r.reason, status: r.status, reviewNote: r.reviewNote,
    createdAt: r.createdAt.toISOString(), reviewedAt: iso(r.reviewedAt), proposedAt: iso(r.proposedAt), doneAt: iso(r.doneAt),
    cancelledAt: iso(r.cancelledAt), beats: await beatsOf(r),
  }
}

const requestOpen = () => new BeatError(409, 'request_open', 'You already have a reissue request open.')

/**
 * Asks for a reissue: `newWallet` must be linked to and verified on this account, `oldWallet` must hold at least one of
 * this account's minted claims, and the account may have only one open request (also held by a partial unique index).
 */
export async function createReissueRequest(userId: string, body: Record<string, unknown>, now = new Date()): Promise<PublicReissueRequest> {
  const oldWallet = parseWallet(body.oldWallet)
  const newWallet = parseWallet(body.newWallet)
  if (oldWallet === newWallet) throw new BeatError(400, 'same_wallet', 'The new wallet must differ from the old one.')
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason || [...reason].length > BEAT_REISSUE_REASON_MAX) {
    throw new BeatError(400, 'bad_reason', `Tell us what happened, in 1 to ${BEAT_REISSUE_REASON_MAX} characters.`)
  }
  if (!(await walletLinked(db, userId, newWallet))) {
    throw new BeatError(400, 'wallet_not_linked', 'Link the new wallet to your account and sign in with it first.')
  }
  if (!(await claimsOnWallet(db, userId, oldWallet)).length) {
    throw new BeatError(400, 'no_beats_on_wallet', "None of your BEATs were sent to that wallet.")
  }
  const open = await db.select({ id: beatReissueRequests.id }).from(beatReissueRequests)
    .where(and(eq(beatReissueRequests.userId, userId), inArray(beatReissueRequests.status, [...BEAT_REISSUE_OPEN])))
  if (open.length) throw requestOpen()
  try {
    const [r] = await db.insert(beatReissueRequests).values({ userId, oldWallet, newWallet, reason, createdAt: now, updatedAt: now }).returning()
    return toPublic(r)
  } catch (err) {
    // Two at once: the open-request index refuses the second
    if ((err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505') throw requestOpen()
    throw err
  }
}

export async function listMyReissueRequests(userId: string): Promise<PublicReissueRequest[]> {
  const rows = await db.select().from(beatReissueRequests).where(eq(beatReissueRequests.userId, userId)).orderBy(desc(beatReissueRequests.createdAt))
  return Promise.all(rows.map(toPublic))
}

/** Withdraws the account's own request while it is pending. Someone else's, or none, is 404. */
export async function cancelMyReissueRequest(userId: string, id: string, now = new Date()): Promise<PublicReissueRequest> {
  if (!UUID.test(id)) throw notFound()
  const [r] = await db.select().from(beatReissueRequests).where(and(eq(beatReissueRequests.id, id), eq(beatReissueRequests.userId, userId)))
  if (!r) throw notFound()
  const [done] = await db.update(beatReissueRequests).set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
    .where(and(eq(beatReissueRequests.id, id), eq(beatReissueRequests.status, 'pending'))).returning()
  if (!done) throw new BeatError(409, 'not_pending', 'Only a pending request can be cancelled.')
  return toPublic(done)
}

// ── What the chain says ────────────────────────────────────────────────────────

export interface ReissueCheck {
  claimId: string
  beatId: string
  name: string
  chain: BeatChain
  tokenId: string
  tradeable: boolean
  /** The live read: balanceOf(old, id), replacedBy(id, old) and minted(id, new); null when the chain couldn't be read. */
  chainState: { oldBalance: string; replacedBy: string | null; newMinted: boolean } | null
  blockers: BeatReissueBlocker[]
  eligible: boolean
  /** Already replaced by the new wallet on chain (a batch landed, the watcher hasn't confirmed it yet). */
  landed: boolean
}

type ClaimRow = Awaited<ReturnType<typeof claimsOnWallet>>[number]

/** Reads each claim's BEAT on chain and says what would make `reissue(old, new, [id])` fail, or what Virvi holds back. */
async function checkClaims(rows: ClaimRow[], r: Pick<Req, 'oldWallet' | 'newWallet'>, now: Date): Promise<ReissueCheck[]> {
  const clashes = rows.length
    ? await db.select({ beatId: beatClaims.beatId }).from(beatClaims)
      .where(and(inArray(beatClaims.beatId, rows.map((x) => x.beat.id)), eq(beatClaims.wallet, r.newWallet)))
    : []
  const clash = new Set(clashes.map((c) => c.beatId))
  const out: ReissueCheck[] = []
  for (const { claim, beat } of rows) {
    const tokenId = BigInt(beat.tokenId!)
    const blockers: BeatReissueBlocker[] = []
    let chainState: ReissueCheck['chainState'] = null
    const client = beatChainClient(beat.chain)
    if (client) {
      try {
        const [oldBalance, replacedBy, newMinted] = await Promise.all([
          client.balanceOf(r.oldWallet, tokenId), client.replacedBy(tokenId, r.oldWallet), client.isMinted(tokenId, r.newWallet),
        ])
        chainState = { oldBalance: oldBalance.toString(), replacedBy, newMinted }
      } catch (err) {
        console.error(`[beats] reissue chain read on ${beat.chain} failed (BEAT ${beat.id}): ${(err as Error).name}`)
      }
    }
    if (!chainState) blockers.push('ChainUnavailable')
    // Until the BEAT ends, the old wallet could open a new claim on it and be "minted" again (the contract skips it)
    if (beat.status !== 'cancelled' && beat.endsAt.getTime() > now.getTime()) blockers.push('BeatOpen')
    if (chainState?.replacedBy) blockers.push('AlreadyReplaced')
    if (chainState?.newMinted) blockers.push('AlreadyMinted')
    if (chainState && beat.tradeable && chainState.oldBalance === '0') blockers.push('NothingToReplace')
    if (clash.has(beat.id)) blockers.push('ClaimOnNewWallet')
    out.push({
      claimId: claim.id, beatId: beat.id, name: beat.name, chain: beat.chain, tokenId: String(beat.tokenId), tradeable: beat.tradeable,
      chainState, blockers, eligible: blockers.length === 0, landed: !!chainState?.replacedBy && lc(chainState.replacedBy) === r.newWallet,
    })
  }
  return out
}

// ── The admin queue ────────────────────────────────────────────────────────────

export type AdminReissueBeat = (ReissueCheck | Omit<ReissueCheck, 'chainState' | 'blockers' | 'eligible' | 'landed'> & { chainState: null; blockers: string[]; eligible: false; landed: false }) & {
  state: BeatReissueItemState | null
  callIndex: number | null
  txUrl: string | null
}

export interface AdminReissueRequest extends Omit<PublicReissueRequest, 'beats'> {
  account: { id: string; displayName: string; email: string | null }
  reviewer: { id: string; displayName: string } | null
  beats: AdminReissueBeat[]
}

const ADMIN_STATUS_FILTERS = ['open', 'all', 'pending', 'approved', 'rejected', 'proposed', 'done', 'cancelled'] as const
const ADMIN_LIST_MAX = 100

async function toAdmin(r: Req, now: Date): Promise<AdminReissueRequest> {
  const [account] = await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, r.userId))
  const reviewer = r.reviewerUserId
    ? (await db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, r.reviewerUserId)))[0] ?? null
    : null
  const items = await db.select({ item: beatReissueItems, name: beats.name }).from(beatReissueItems)
    .leftJoin(beats, eq(beats.id, beatReissueItems.beatId))
    .where(eq(beatReissueItems.requestId, r.id))
  const itemOf = new Map(items.map(({ item }) => [`${item.chain}:${item.tokenId}`, item]))
  const out: AdminReissueBeat[] = []
  // Live reads only while it is open; the claims still on the old wallet (a reissued one has moved to the new wallet)
  if (isOpen(r.status)) {
    for (const c of await checkClaims(await claimsOnWallet(db, r.userId, r.oldWallet), r, now)) {
      const item = itemOf.get(`${c.chain}:${c.tokenId}`)
      out.push({ ...c, state: item?.state ?? null, callIndex: item?.state === 'proposed' ? item.callIndex : null, txUrl: null })
      itemOf.delete(`${c.chain}:${c.tokenId}`)
    }
  }
  for (const { item, name } of items) {
    if (!itemOf.has(`${item.chain}:${item.tokenId}`)) continue
    out.push({
      claimId: item.claimId, beatId: item.beatId, name: name ?? '', chain: item.chain, tokenId: String(item.tokenId), tradeable: item.tradeable,
      chainState: null, blockers: item.state === 'skipped' ? item.blockers : [], eligible: false, landed: false,
      state: item.state, callIndex: item.state === 'proposed' ? item.callIndex : null,
      txUrl: item.txHash ? beatTxUrl(item.chain, item.txHash) : null,
    } as AdminReissueBeat)
  }
  out.sort((a, b) => a.chain.localeCompare(b.chain) || Number(BigInt(a.tokenId) - BigInt(b.tokenId)))
  const { beats: _b, ...pub } = await toPublic(r)
  return { ...pub, account: account ?? { id: r.userId, displayName: '', email: null }, reviewer, beats: out }
}

/** Requests for the admin queue, newest first: open ones by default, or `all`, or one status. */
export async function adminListReissueRequests(status: string | undefined, now = new Date()): Promise<AdminReissueRequest[]> {
  const f = status ?? 'open'
  if (!(ADMIN_STATUS_FILTERS as readonly string[]).includes(f)) throw new BeatError(400, 'bad_status', 'Unknown status filter.')
  const where = f === 'all' ? undefined : f === 'open'
    ? inArray(beatReissueRequests.status, [...BEAT_REISSUE_OPEN])
    : eq(beatReissueRequests.status, f as BeatReissueStatus)
  const rows = await db.select().from(beatReissueRequests).where(where).orderBy(desc(beatReissueRequests.createdAt)).limit(ADMIN_LIST_MAX)
  const out: AdminReissueRequest[] = []
  for (const r of rows) out.push(await toAdmin(r, now))
  return out
}

async function loadRequest(id: string): Promise<Req> {
  if (!UUID.test(id)) throw notFound()
  const [r] = await db.select().from(beatReissueRequests).where(eq(beatReissueRequests.id, id))
  if (!r) throw notFound()
  return r
}

/** Approves a pending request, or rejects a pending or approved one. A rejection needs a note (the person sees it); an approval's is optional. */
export async function reviewReissueRequest(
  adminId: string, id: string, decision: 'approve' | 'reject', note: unknown, now = new Date(),
): Promise<AdminReissueRequest> {
  const reviewNote = parseNote(note, decision === 'reject')
  await loadRequest(id)
  const [r] = await db.update(beatReissueRequests)
    .set({ status: decision === 'approve' ? 'approved' : 'rejected', reviewerUserId: adminId, reviewNote, reviewedAt: now, updatedAt: now })
    // A rejection may also undo an approval before a batch was prepared; nothing is reviewed again once proposed
    .where(and(eq(beatReissueRequests.id, id), inArray(beatReissueRequests.status, decision === 'approve' ? ['pending'] : ['pending', 'approved']))).returning()
  if (!r) throw new BeatError(409, 'not_pending', decision === 'approve' ? 'Only a pending request can be approved.' : 'Only a pending or approved request can be rejected.')
  return toAdmin(r, now)
}

// ── The Safe Transaction Builder batch ───────────────────────────────────────

/**
 * Safe{Wallet} Transaction Builder's batch file, as its app imports it (safe-global/safe-react-apps,
 * apps/tx-builder/src/typings/models.ts: BatchFile, BatchFileMeta, BatchTransaction, ContractMethod): every number is a
 * string, and a transaction with `data: null` is encoded by the app from `contractMethod` and `contractInputsValues`, so
 * the signers see the decoded call. Array inputs are written "[1,2,3]" (its utils.ts parseInputValue).
 */
export interface SafeBatchFile {
  version: '1.0'
  chainId: string
  createdAt: number
  meta: { name: string; description: string; createdFromSafeAddress?: string; checksum: string }
  transactions: Array<{
    to: string
    value: '0'
    data: null
    contractMethod: { inputs: Array<{ internalType: string; name: string; type: string }>; name: 'reissue'; payable: false }
    contractInputsValues: { from: string; to: string; ids: string }
  }>
}

const REISSUE_METHOD: SafeBatchFile['transactions'][number]['contractMethod'] = {
  inputs: [
    { internalType: 'address', name: 'from', type: 'address' },
    { internalType: 'address', name: 'to', type: 'address' },
    { internalType: 'uint256[]', name: 'ids', type: 'uint256[]' },
  ],
  name: 'reissue',
  payable: false,
}

/**
 * The file's checksum as Transaction Builder computes it (apps/tx-builder/src/lib/checksum.ts): keccak-256 of a
 * key-sorted serialization of the whole file with `meta.name` set to null and no `meta.checksum`. Without one the app
 * warns that the file "was modified since it was generated".
 */
export function txBuilderChecksum(file: Omit<SafeBatchFile, 'meta'> & { meta: Record<string, unknown> }): string {
  const ser = (j: unknown): string => {
    if (Array.isArray(j)) return `[${j.map(ser).join(',')}]`
    if (typeof j === 'object' && j !== null) {
      const o = j as Record<string, unknown>
      const keys = Object.keys(o).sort()
      let acc = `{${JSON.stringify(keys)}`
      for (const k of keys) acc += `${ser(o[k])},`
      return `${acc}}`
    }
    return JSON.stringify(j === undefined ? null : j)
  }
  const { checksum: _c, ...meta } = file.meta
  return keccakText(ser({ ...file, meta: { ...meta, name: null } }))
}

/**
 * The calls for one chain (the contract README's runbook): every eligible non-tradeable id in one `reissue`, split at
 * MAX_BATCH, then one call per eligible tradeable id, so a thief moving one tradeable copy can fail only its own call.
 */
export function planReissueCalls(eligible: Array<{ tokenId: string; tradeable: boolean }>): string[][] {
  const plain = eligible.filter((e) => !e.tradeable).map((e) => e.tokenId)
  const calls: string[][] = []
  for (let i = 0; i < plain.length; i += BEAT_REISSUE_MAX_BATCH) calls.push(plain.slice(i, i + BEAT_REISSUE_MAX_BATCH))
  for (const e of eligible) if (e.tradeable) calls.push([e.tokenId])
  return calls
}

/** The batch file for these calls (planReissueCalls) of one request on one chain. */
export function buildSafeBatchFile(r: Pick<Req, 'id' | 'oldWallet' | 'newWallet'>, chain: BeatChain, contract: string, calls: string[][], now: Date): SafeBatchFile {
  const n = calls.reduce((s, c) => s + c.length, 0)
  const safe = config.beats.adminSafes?.[chain]
  const body = {
    version: '1.0' as const,
    chainId: String(BEAT_CHAIN_INFO[chain].chainId),
    createdAt: now.getTime(),
    meta: {
      name: `Virvi BEAT reissue ${r.id.slice(0, 8)}`,
      description: `Virvi reissue request ${r.id}: ${n} BEAT${n === 1 ? '' : 's'} from ${getAddress(r.oldWallet)} to ${getAddress(r.newWallet)} on ${BEAT_CHAIN_INFO[chain].label}, in ${calls.length} call${calls.length === 1 ? '' : 's'} (non-tradeable BEATs together, each tradeable one alone).`,
      ...(safe ? { createdFromSafeAddress: safe } : {}),
    },
    transactions: calls.map((ids) => ({
      to: getAddress(contract), value: '0' as const, data: null, contractMethod: REISSUE_METHOD,
      contractInputsValues: { from: getAddress(r.oldWallet), to: getAddress(r.newWallet), ids: `[${ids.join(',')}]` },
    })),
  }
  return { ...body, meta: { ...body.meta, checksum: txBuilderChecksum(body) } }
}

/** `done` once nothing is proposed and every chain with the account's BEATs on the old wallet has had a batch prepared. */
async function settleIfDone(tx: Exec, r: Req, now: Date): Promise<boolean> {
  const items = await tx.select({ chain: beatReissueItems.chain, state: beatReissueItems.state }).from(beatReissueItems)
    .where(eq(beatReissueItems.requestId, r.id))
  if (!items.length || items.some((i) => i.state === 'proposed')) return false
  const prepared = new Set(items.map((i) => i.chain))
  const left = await claimsOnWallet(tx, r.userId, r.oldWallet)
  if (left.some((c) => !prepared.has(c.beat.chain))) return false
  await tx.update(beatReissueRequests).set({ status: 'done', doneAt: now, updatedAt: now })
    .where(and(eq(beatReissueRequests.id, r.id), eq(beatReissueRequests.status, 'proposed')))
  return true
}

/**
 * Prepares the Safe batch for an approved (or already proposed) request on one chain, from a fresh chain read: the
 * eligible BEATs not yet reissued go in, the rest are recorded as skipped with their blockers. The request becomes
 * `proposed`. Preparing again (some ids never landed) replaces the chain's earlier proposal. With nothing eligible it
 * refuses (`nothing_to_reissue`), still recording the blockers, and a proposed request with nothing left is done.
 */
export async function prepareSafeBatch(id: string, chainArg: unknown, now = new Date()): Promise<SafeBatchFile> {
  if (typeof chainArg !== 'string' || !(BEAT_CHAINS as readonly string[]).includes(chainArg)) throw new BeatError(400, 'bad_chain', 'Unknown chain.')
  const chain = chainArg as BeatChain
  const r = await loadRequest(id)
  if (r.status !== 'approved' && r.status !== 'proposed') throw new BeatError(409, 'not_approved', 'Approve the request first.')
  const contract = config.beats.contracts[chain]
  if (!contract) throw new BeatError(409, 'no_contract', 'No BEAT contract is set up on that chain.')
  if (!(await walletLinked(db, r.userId, r.newWallet))) {
    throw new BeatError(409, 'wallet_not_linked', 'The new wallet is no longer linked to and verified on the account.')
  }
  const rows = (await claimsOnWallet(db, r.userId, r.oldWallet)).filter((x) => x.beat.chain === chain)
  const checks = await checkClaims(rows, r, now)
  const eligible = checks.filter((c) => c.eligible)
  const calls = planReissueCalls(eligible)
  const callOf = new Map<string, number>()
  calls.forEach((ids, i) => { for (const t of ids) callOf.set(t, i) })
  let proposedBlock: number | null = null
  if (calls.length) {
    // Where the watcher starts looking for the Reissued logs (a failed read leaves it to search from the claim's mint)
    try {
      proposedBlock = await beatChainClient(chain)!.latestBlock()
    } catch {
      throw new BeatError(503, 'chain_unavailable', "The chain can't be read right now. Try again.")
    }
  }
  const existing = await db.select({ tokenId: beatReissueItems.tokenId, state: beatReissueItems.state }).from(beatReissueItems)
    .where(and(eq(beatReissueItems.requestId, r.id), eq(beatReissueItems.chain, chain)))
  const proposedBefore = new Set(existing.filter((i) => i.state === 'proposed').map((i) => String(i.tokenId)))
  const landed = checks.filter((c) => c.landed)
  await db.transaction(async (tx) => {
    for (const c of checks) {
      const tokenId = Number(c.tokenId)
      if (c.landed) {
        // Replaced by the new wallet already (an earlier batch, or the Safe acting on its own): the watcher confirms it at
        // depth and moves the claim, so it stays (or becomes) proposed and goes in no call
        if (!proposedBefore.has(c.tokenId)) {
          const values = { claimId: c.claimId, beatId: c.beatId, tradeable: c.tradeable, state: 'proposed' as const, blockers: [], callIndex: null, proposedAt: now, proposedBlock: null }
          await tx.insert(beatReissueItems).values({ requestId: r.id, chain, tokenId, ...values })
            .onConflictDoUpdate({ target: [beatReissueItems.requestId, beatReissueItems.chain, beatReissueItems.tokenId], set: values, where: ne(beatReissueItems.state, 'reissued') })
        }
        continue
      }
      const proposed = callOf.has(c.tokenId)
      const values = {
        claimId: c.claimId, beatId: c.beatId, tradeable: c.tradeable,
        state: (proposed ? 'proposed' : 'skipped') as BeatReissueItemState, blockers: proposed ? [] : c.blockers,
        callIndex: proposed ? callOf.get(c.tokenId)! : null, proposedAt: proposed ? now : null, proposedBlock: proposed ? proposedBlock : null,
      }
      await tx.insert(beatReissueItems).values({ requestId: r.id, chain, tokenId, ...values })
        .onConflictDoUpdate({ target: [beatReissueItems.requestId, beatReissueItems.chain, beatReissueItems.tokenId], set: values, where: ne(beatReissueItems.state, 'reissued') })
    }
    if (calls.length || landed.length) {
      await tx.update(beatReissueRequests).set({ status: 'proposed', proposedAt: now, updatedAt: now }).where(eq(beatReissueRequests.id, r.id))
    } else if (r.status === 'proposed') {
      await settleIfDone(tx, r, now)
    }
  })
  if (!calls.length) throw new BeatError(409, 'nothing_to_reissue', 'None of these BEATs can be reissued now.', { beats: checks.map(({ tokenId, blockers }) => ({ tokenId, blockers })) })
  return buildSafeBatchFile(r, chain, contract, calls, now)
}

// ── Completion (on the minting job's tick) ───────────────────────────────────

/** Blocks per Reissued log query, and the most queries per request per tick (newest first; the hash is a nicety). */
const LOG_CHUNK = 2_000
const LOG_CHUNKS_MAX = 10

/** The Reissued logs' tx hash per token id, searched newest first from `head` down to `from`. */
async function findHashes(client: BeatChainClient, r: Req, ids: Set<string>, from: number, head: number): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  let hi = head
  for (let i = 0; i < LOG_CHUNKS_MAX && hi >= from && found.size < ids.size; i++) {
    const lo = Math.max(from, hi - LOG_CHUNK + 1)
    try {
      for (const l of await client.reissuedLogs(r.oldWallet, r.newWallet, lo, hi)) {
        const k = l.tokenId.toString()
        if (ids.has(k) && !found.has(k)) found.set(k, l.txHash)
      }
    } catch (err) {
      console.error(`[beats] reissue log read on ${client.chain} failed (request ${r.id}): ${(err as Error).name}`)
      break
    }
    hi = lo - 1
  }
  return found
}

/**
 * The reissue watcher: for each proposed BEAT on this chain, reads `replacedBy(id, old)` at the chain's confirmation
 * depth (30 blocks on Polygon, 5 on Amoy, counted as for mints). One that names the new wallet is done: its claim moves
 * to the new wallet (the old one kept in replaced_wallet) with the reissue's tx hash when the logs give it. One replaced
 * to another wallet is skipped (AlreadyReplaced). A request is done when nothing of it is proposed any more; one whose
 * ids never land stays proposed, and an admin can prepare a new batch for the rest.
 */
export async function watchReissues(client: BeatChainClient, now: Date): Promise<{ reissued: number; done: number }> {
  const chain = client.chain
  const open = await db.select({ item: beatReissueItems, req: beatReissueRequests }).from(beatReissueItems)
    .innerJoin(beatReissueRequests, eq(beatReissueRequests.id, beatReissueItems.requestId))
    .where(and(eq(beatReissueItems.chain, chain), eq(beatReissueItems.state, 'proposed'), eq(beatReissueRequests.status, 'proposed')))
  if (!open.length) return { reissued: 0, done: 0 }
  const head = (await client.latestBlock()) - BEAT_CHAIN_INFO[chain].confirmations
  const byReq = new Map<string, { req: Req; items: Item[] }>()
  for (const { item, req } of open) {
    const g = byReq.get(req.id) ?? { req, items: [] }
    g.items.push(item)
    byReq.set(req.id, g)
  }
  let reissued = 0
  let done = 0
  for (const { req, items } of byReq.values()) {
    const landed: Item[] = []
    const elsewhere: Item[] = []
    for (const it of items) {
      const to = await client.replacedBy(BigInt(it.tokenId), req.oldWallet, head)
      if (!to) continue
      ;(lc(to) === req.newWallet ? landed : elsewhere).push(it)
    }
    if (!landed.length && !elsewhere.length) continue
    const from = Math.min(...landed.map((i) => i.proposedBlock ?? 0))
    const hashes = landed.length ? await findHashes(client, req, new Set(landed.map((i) => String(i.tokenId))), from, head) : new Map<string, string>()
    await db.transaction(async (tx) => {
      for (const it of landed) {
        const hash = hashes.get(String(it.tokenId)) ?? null
        await tx.update(beatReissueItems).set({ state: 'reissued', txHash: hash, reissuedAt: now, blockers: [] }).where(eq(beatReissueItems.id, it.id))
        if (!it.claimId) continue
        // The new wallet can't already be on another claim of this BEAT (ClaimOnNewWallet when it was prepared); if one
        // appeared since, the claim keeps its wallet rather than break the per-BEAT wallet rule
        const [clash] = await tx.select({ id: beatClaims.id }).from(beatClaims)
          .where(and(eq(beatClaims.wallet, req.newWallet), ne(beatClaims.id, it.claimId),
            sql`${beatClaims.beatId} = (select beat_id from beat_claims where id = ${it.claimId}::uuid)`))
        if (clash) {
          console.error(`[beats] reissue request ${req.id}: claim ${it.claimId} reissued on chain but another claim holds the new wallet`)
          continue
        }
        await tx.update(beatClaims).set({ wallet: req.newWallet, replacedWallet: req.oldWallet, reissueTx: hash, reissuedAt: now })
          .where(and(eq(beatClaims.id, it.claimId), eq(beatClaims.wallet, req.oldWallet)))
        reissued++
      }
      for (const it of elsewhere) {
        await tx.update(beatReissueItems).set({ state: 'skipped', blockers: ['AlreadyReplaced'], callIndex: null }).where(eq(beatReissueItems.id, it.id))
      }
      if (await settleIfDone(tx, req, now)) done++
    })
    console.log(`[beats] reissue request ${req.id} on ${chain}: ${landed.length} reissued, ${elsewhere.length} replaced elsewhere`)
  }
  return { reissued, done }
}

// ── Privacy ──────────────────────────────────────────────────────────────────

/** Delete-my-data: the account's reissue requests (and their items) go. */
export async function deleteMyReissueRequests(exec: Pick<typeof db, 'delete'>, userId: string): Promise<number> {
  return (await exec.delete(beatReissueRequests).where(eq(beatReissueRequests.userId, userId)).returning({ id: beatReissueRequests.id })).length
}

/** The 30-day scrub: requests closed (rejected, cancelled, done) that long ago go. Open ones are kept. */
export async function scrubReissueRequests(cutoff: Date): Promise<number> {
  const closedAt = sql`coalesce(${beatReissueRequests.doneAt}, ${beatReissueRequests.cancelledAt}, ${beatReissueRequests.reviewedAt}, ${beatReissueRequests.updatedAt})`
  const rows = await db.delete(beatReissueRequests).where(and(
    inArray(beatReissueRequests.status, ['rejected', 'cancelled', 'done']),
    sql`${closedAt} <= ${cutoff.toISOString()}::timestamptz`,
  )).returning({ id: beatReissueRequests.id })
  return rows.length
}

