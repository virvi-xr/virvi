import { and, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm'
import { getAddress, id as keccakText, isAddress } from 'ethers'
import {
  BEAT_CHAINS, BEAT_CHAIN_INFO, BEAT_REISSUE_MAX_BATCH, BEAT_REISSUE_NOTE_MAX, BEAT_REISSUE_OPEN, BEAT_REISSUE_REASON_MAX, beatTxUrl,
  type BeatChain, type BeatReissueBlocker, type BeatReissueFileStatus, type BeatReissueFlag, type BeatReissueItemState, type BeatReissueStatus,
} from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import {
  accountWalletEvents, beatClaims, beatReissueFiles, beatReissueItems, beatReissueRequests, beats, userAuthMethods, users, walletBlocks,
  type LinkedBy, type ReissueAudit,
} from '../db/schema.js'
import { blockWallet, isWalletBlocked, sameSignIn, unblockForRequest, unlinkWallet } from '../auth/wallet-blocks.js'
import { recordJobFailure } from '../errors/record.js'
import { beatChainClient, type BeatChainClient } from './chain.js'
import { BeatError } from './errors.js'

/**
 * BEAT reissue (LIV-11): a person whose wallet was compromised asks for their BEATs to go to a new wallet; an admin
 * reviews it; Virvi prepares Safe Transaction Builder files for the contract's admin-only `reissue`, which the admin
 * Safe's signers check, sign and send. The server never signs or sends a reissue. The minting job's tick then watches the
 * chain (watchReissues) and, at the confirmation depth, moves each claim to the new wallet.
 *
 * The thief holds the compromised key, which signs in to the person's account, so (fix round 1):
 * - every request records how its filing (and cancelling) session signed in; one signed in with the old wallet can't
 *   file, and only a session signed in the same way as the filer can cancel;
 * - the admin queue shows the account's wallet links (when, and by which session), its request history and red flags;
 * - approval blocks the old wallet (no sign-in, no link, its sessions end); done unlinks it and keeps it blocked; an
 *   admin can unlink (and block) any other wallet on the account.
 *
 * Review (approve or reject) and proposing the files are separate steps, so a support role can take the first later.
 * Nothing here logs a wallet, a reason or a name.
 */

type Req = typeof beatReissueRequests.$inferSelect
type Item = typeof beatReissueItems.$inferSelect
type FileRow = typeof beatReissueFiles.$inferSelect
type Exec = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86_400_000
/** A new wallet linked this soon before the request is a red flag. */
export const REISSUE_NEW_WALLET_RECENT_MS = 7 * DAY_MS
/** How far back a cancel, or a done reissue to this old wallet, raises a red flag. */
export const REISSUE_RECENT_MS = 30 * DAY_MS
/** Chain reads in flight at once, per request (the admin queue and the watcher). */
const CHAIN_CONCURRENCY = 4
const lc = (s: string) => s.toLowerCase()
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null
const notFound = () => new BeatError(404, 'not_found', 'Request not found.')
const isOpen = (s: BeatReissueStatus) => BEAT_REISSUE_OPEN.includes(s)
const audit = (by: string | null, action: string, now: Date, note?: string): ReissueAudit => ({ at: now.toISOString(), by, action, ...(note ? { note } : {}) })
const pushAudit = (e: ReissueAudit) => sql`${beatReissueRequests.audit} || ${JSON.stringify([e])}::jsonb`

/** Runs `fn` over `items`, at most `n` at a time, in order. */
async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

/** Who is asking, on the person's routes: the account and how its session signed in. */
export type ReissueCaller = { userId: string; signIn: LinkedBy }

// ── The person's requests ──────────────────────────────────────────────────────

export interface ReissueBeat {
  claimId: string | null
  beatId: string | null
  name: string
  chain: BeatChain
  tokenId: string
  tradeable: boolean
  /** proposed, skipped, reissued, clash, withdrawn; null before a file was proposed for its chain. */
  state: BeatReissueItemState | null
}

export interface PublicReissueRequest {
  id: string
  oldWallet: string
  newWallet: string
  reason: string | null
  status: BeatReissueStatus
  /** The reviewer's note (shown to the person). */
  reviewNote: string | null
  createdAt: string
  reviewedAt: string | null
  proposedAt: string | null
  doneAt: string | null
  cancelledAt: string | null
  withdrawnAt: string | null
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
async function walletLinked(exec: Pick<typeof db, 'select'>, userId: string | null, wallet: string): Promise<boolean> {
  if (!userId) return false
  const rows = await exec.select({ metadata: userAuthMethods.metadata }).from(userAuthMethods)
    .where(and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, lc(wallet))))
  return rows.some((r) => (r.metadata as { verified?: unknown } | null)?.verified === true)
}

/** The account's minted claims still on this wallet, with their BEATs (none for a request whose data was deleted). */
async function claimsOnWallet(exec: Pick<typeof db, 'select'>, userId: string | null, wallet: string) {
  if (!userId) return []
  return exec.select({ claim: beatClaims, beat: beats }).from(beatClaims).innerJoin(beats, eq(beats.id, beatClaims.beatId))
    .where(and(eq(beatClaims.userId, userId), eq(beatClaims.status, 'minted'), eq(beatClaims.wallet, lc(wallet)), isNotNull(beats.tokenId)))
    .orderBy(beats.chain, beats.tokenId)
}

/** The request's BEATs: its items (once a file was proposed), then the claims still on the old wallet that have none. */
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
    cancelledAt: iso(r.cancelledAt), withdrawnAt: iso(r.withdrawnAt), beats: await beatsOf(r),
  }
}

const requestOpen = () => new BeatError(409, 'request_open', 'You already have a reissue request open.')

/**
 * Asks for a reissue: `newWallet` must be linked to and verified on this account, `oldWallet` must hold at least one of
 * this account's minted claims, the account may have only one open request (also held by a partial unique index), and
 * the session must not be signed in with the old wallet (the thief holds that key).
 */
export async function createReissueRequest(c: ReissueCaller, body: Record<string, unknown>, now = new Date()): Promise<PublicReissueRequest> {
  const oldWallet = parseWallet(body.oldWallet)
  const newWallet = parseWallet(body.newWallet)
  if (oldWallet === newWallet) throw new BeatError(400, 'same_wallet', 'The new wallet must differ from the old one.')
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason || [...reason].length > BEAT_REISSUE_REASON_MAX) {
    throw new BeatError(400, 'bad_reason', `Tell us what happened, in 1 to ${BEAT_REISSUE_REASON_MAX} characters.`)
  }
  if (c.signIn.method === 'wallet' && c.signIn.wallet === oldWallet) {
    throw new BeatError(403, 'signed_in_with_old_wallet', 'Sign in with your new wallet, or with your email, to ask for this.')
  }
  if (!(await walletLinked(db, c.userId, newWallet)) || (await isWalletBlocked(newWallet))) {
    throw new BeatError(400, 'wallet_not_linked', 'Link the new wallet to your account and sign in with it first.')
  }
  if (!(await claimsOnWallet(db, c.userId, oldWallet)).length) {
    throw new BeatError(400, 'no_beats_on_wallet', "None of your BEATs were sent to that wallet.")
  }
  const open = await db.select({ id: beatReissueRequests.id }).from(beatReissueRequests)
    .where(and(eq(beatReissueRequests.userId, c.userId), inArray(beatReissueRequests.status, [...BEAT_REISSUE_OPEN])))
  if (open.length) throw requestOpen()
  try {
    const [r] = await db.insert(beatReissueRequests).values({ userId: c.userId, oldWallet, newWallet, reason, filedVia: c.signIn, createdAt: now, updatedAt: now }).returning()
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

/**
 * Withdraws the account's own pending request. Only a session signed in the same way as the one that filed it (the
 * same wallet, or the same email) may: else `cancel_not_allowed`. Someone else's request, or none, is 404.
 */
export async function cancelMyReissueRequest(c: ReissueCaller, id: string, now = new Date()): Promise<PublicReissueRequest> {
  if (!UUID.test(id)) throw notFound()
  const [r] = await db.select().from(beatReissueRequests).where(and(eq(beatReissueRequests.id, id), eq(beatReissueRequests.userId, c.userId)))
  if (!r) throw notFound()
  if (r.status !== 'pending') throw new BeatError(409, 'not_pending', 'Only a pending request can be cancelled.')
  if (!sameSignIn(r.filedVia, c.signIn)) {
    throw new BeatError(403, 'cancel_not_allowed', 'Sign in the way you did when you asked (the same wallet or email) to cancel this.')
  }
  const [done] = await db.update(beatReissueRequests).set({ status: 'cancelled', cancelledAt: now, cancelledVia: c.signIn, updatedAt: now })
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
  /** Already replaced by the new wallet on chain (a file landed, the watcher hasn't confirmed it yet). */
  landed: boolean
}

type ClaimRow = Awaited<ReturnType<typeof claimsOnWallet>>[number]

/**
 * Reads each claim's BEAT on chain (CHAIN_CONCURRENCY at a time; one failed read marks only its own BEAT
 * ChainUnavailable) and says what would make `reissue(old, new, [id])` fail, or what Virvi holds back.
 */
async function checkClaims(rows: ClaimRow[], r: Pick<Req, 'oldWallet' | 'newWallet'>, now: Date): Promise<ReissueCheck[]> {
  const clashes = rows.length
    ? await db.select({ beatId: beatClaims.beatId }).from(beatClaims)
      .where(and(inArray(beatClaims.beatId, rows.map((x) => x.beat.id)), eq(beatClaims.wallet, r.newWallet)))
    : []
  const clash = new Set(clashes.map((c) => c.beatId))
  return mapLimit(rows, CHAIN_CONCURRENCY, async ({ claim, beat }) => {
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
    return {
      claimId: claim.id, beatId: beat.id, name: beat.name, chain: beat.chain, tokenId: String(beat.tokenId), tradeable: beat.tradeable,
      chainState, blockers, eligible: blockers.length === 0, landed: !!chainState?.replacedBy && lc(chainState.replacedBy) === r.newWallet,
    }
  })
}

// ── The admin queue ────────────────────────────────────────────────────────────

export type AdminReissueBeat = (ReissueCheck | Omit<ReissueCheck, 'chainState' | 'blockers' | 'eligible' | 'landed'> & { chainState: null; blockers: string[]; eligible: false; landed: false }) & {
  state: BeatReissueItemState | null
  fileId: string | null
  callIndex: number | null
  txUrl: string | null
}

export interface AdminReissueFile {
  id: string
  chain: BeatChain
  callIndex: number
  kind: 'plain' | 'tradeable'
  tokenIds: string[]
  status: BeatReissueFileStatus
  checksum: string
  filename: string
  proposedAt: string
  doneAt: string | null
  voidedAt: string | null
}

/** One of the account's wallets, now or before: when and how it was linked, its last sign-in, and what happened since. */
export interface AdminWalletLink {
  wallet: string
  linked: boolean
  blocked: boolean
  linkedAt: string | null
  linkedBy: LinkedBy | null
  lastSignInAt: string | null
}
export interface AdminWalletEvent { wallet: string; event: string; at: string; byUserId: string | null; requestId: string | null; note: string | null }

export interface AdminRequestHistory {
  id: string
  status: BeatReissueStatus
  oldWallet: string
  newWallet: string
  createdAt: string
  filedVia: LinkedBy | null
  cancelledAt: string | null
  cancelledVia: LinkedBy | null
  reviewedAt: string | null
  doneAt: string | null
  withdrawnAt: string | null
}

export interface AdminReissueRequest extends Omit<PublicReissueRequest, 'beats'> {
  account: { id: string; displayName: string; email: string | null } | null
  reviewer: { id: string; displayName: string } | null
  filedVia: LinkedBy | null
  cancelledVia: LinkedBy | null
  dataDeletedAt: string | null
  audit: ReissueAudit[]
  /** Red flags for the reviewer (BeatReissueFlag). */
  flags: BeatReissueFlag[]
  /** Whether the account can be reached other than through its wallets: an email, a password, a Google or Discord sign-in. */
  otherSignIns: { email: boolean; password: boolean; oauth: boolean }
  wallets: AdminWalletLink[]
  walletEvents: AdminWalletEvent[]
  /** The account's other reissue requests, newest first. */
  history: AdminRequestHistory[]
  files: AdminReissueFile[]
  beats: AdminReissueBeat[]
}

const ADMIN_STATUS_FILTERS = ['open', 'all', 'pending', 'approved', 'rejected', 'proposed', 'done', 'cancelled', 'withdrawn'] as const
export const ADMIN_REISSUE_PAGE = 25

const fileName = (r: Pick<Req, 'id'>, f: Pick<FileRow, 'chain' | 'callIndex'>) => `virvi-beat-reissue-${r.id.slice(0, 8)}-${f.chain}-${f.callIndex + 1}.json`

function fileView(r: Req, f: FileRow): AdminReissueFile {
  return {
    id: f.id, chain: f.chain, callIndex: f.callIndex, kind: f.kind, tokenIds: f.tokenIds, status: f.status, checksum: f.checksum,
    filename: fileName(r, f), proposedAt: f.proposedAt.toISOString(), doneAt: iso(f.doneAt), voidedAt: iso(f.voidedAt),
  }
}

async function provenance(r: Req, now: Date) {
  if (!r.userId) {
    return { account: null, otherSignIns: { email: false, password: false, oauth: false }, wallets: [], walletEvents: [], history: [], flags: [] as BeatReissueFlag[] }
  }
  const [account] = await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, r.userId))
  const methods = await db.select().from(userAuthMethods).where(eq(userAuthMethods.userId, r.userId))
  const events = await db.select().from(accountWalletEvents).where(eq(accountWalletEvents.userId, r.userId)).orderBy(accountWalletEvents.at)
  const walletSet = [...new Set([...methods.filter((m) => m.type === 'wallet').map((m) => m.identifier), ...events.map((e) => e.wallet)])]
  const blocked = walletSet.length
    ? new Set((await db.select({ wallet: walletBlocks.wallet }).from(walletBlocks).where(inArray(walletBlocks.wallet, walletSet))).map((b) => b.wallet))
    : new Set<string>()
  const wallets: AdminWalletLink[] = []
  for (const m of methods.filter((x) => x.type === 'wallet')) {
    wallets.push({
      wallet: m.identifier, linked: true, blocked: blocked.has(m.identifier), linkedAt: (m.linkedAt ?? m.createdAt).toISOString(),
      linkedBy: m.linkedBy, lastSignInAt: m.updatedAt.toISOString(),
    })
  }
  for (const e of events) {
    if (e.event !== 'unlinked' || wallets.some((w) => w.wallet === e.wallet)) continue
    wallets.push({ wallet: e.wallet, linked: false, blocked: blocked.has(e.wallet), linkedAt: iso(e.linkedAt), linkedBy: e.linkedBy ?? null, lastSignInAt: null })
  }
  const others = await db.select().from(beatReissueRequests)
    .where(and(eq(beatReissueRequests.userId, r.userId), ne(beatReissueRequests.id, r.id))).orderBy(desc(beatReissueRequests.createdAt))
  const history: AdminRequestHistory[] = others.map((o) => ({
    id: o.id, status: o.status, oldWallet: o.oldWallet, newWallet: o.newWallet, createdAt: o.createdAt.toISOString(), filedVia: o.filedVia,
    cancelledAt: iso(o.cancelledAt), cancelledVia: o.cancelledVia, reviewedAt: iso(o.reviewedAt), doneAt: iso(o.doneAt), withdrawnAt: iso(o.withdrawnAt),
  }))

  const flags: BeatReissueFlag[] = []
  const newLink = methods.find((m) => m.type === 'wallet' && m.identifier === r.newWallet)
  if (newLink && r.createdAt.getTime() - (newLink.linkedAt ?? newLink.createdAt).getTime() < REISSUE_NEW_WALLET_RECENT_MS) flags.push('new_wallet_recent')
  if (newLink?.linkedBy?.method === 'wallet' && newLink.linkedBy.wallet === r.oldWallet) flags.push('new_wallet_linked_by_old_wallet')
  if (others.some((o) => o.cancelledAt && now.getTime() - o.cancelledAt.getTime() < REISSUE_RECENT_MS)) flags.push('recent_cancel')
  if (others.some((o) => o.status === 'done')) flags.push('earlier_reissue')
  const followUp = await db.select({ id: beatReissueRequests.id }).from(beatReissueRequests).where(and(
    eq(beatReissueRequests.status, 'done'), eq(beatReissueRequests.newWallet, r.oldWallet), ne(beatReissueRequests.id, r.id),
    sql`${beatReissueRequests.doneAt} > ${new Date(now.getTime() - REISSUE_RECENT_MS).toISOString()}::timestamptz`,
  )).limit(1)
  if (followUp.length) flags.push('follow_up_reissue')
  return {
    account: account ?? null,
    otherSignIns: { email: !!account?.email, password: methods.some((m) => m.type === 'email'), oauth: methods.some((m) => m.type === 'oauth') },
    wallets, walletEvents: events.map((e) => ({ wallet: e.wallet, event: e.event, at: e.at.toISOString(), byUserId: e.byUserId, requestId: e.requestId, note: e.note })),
    history, flags,
  }
}

async function toAdmin(r: Req, now: Date): Promise<AdminReissueRequest> {
  const reviewer = r.reviewerUserId
    ? (await db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, r.reviewerUserId)))[0] ?? null
    : null
  const items = await db.select({ item: beatReissueItems, name: beats.name }).from(beatReissueItems)
    .leftJoin(beats, eq(beats.id, beatReissueItems.beatId))
    .where(eq(beatReissueItems.requestId, r.id))
  const itemOf = new Map(items.map(({ item }) => [`${item.chain}:${item.tokenId}`, item]))
  const files = await db.select().from(beatReissueFiles).where(eq(beatReissueFiles.requestId, r.id)).orderBy(beatReissueFiles.chain, beatReissueFiles.proposedAt, beatReissueFiles.callIndex)
  const out: AdminReissueBeat[] = []
  const inFile = (item: Item | undefined) => (item?.state === 'proposed' ? { fileId: item.fileId, callIndex: item.callIndex } : { fileId: null, callIndex: null })
  // Live reads only while it is open; the claims still on the old wallet (a reissued one has moved to the new wallet)
  if (isOpen(r.status)) {
    for (const c of await checkClaims(await claimsOnWallet(db, r.userId, r.oldWallet), r, now)) {
      const item = itemOf.get(`${c.chain}:${c.tokenId}`)
      out.push({ ...c, state: item?.state ?? null, ...inFile(item), txUrl: item?.txHash ? beatTxUrl(c.chain, item.txHash) : null })
      itemOf.delete(`${c.chain}:${c.tokenId}`)
    }
  }
  for (const { item, name } of items) {
    if (!itemOf.has(`${item.chain}:${item.tokenId}`)) continue
    out.push({
      claimId: item.claimId, beatId: item.beatId, name: name ?? '', chain: item.chain, tokenId: String(item.tokenId), tradeable: item.tradeable,
      chainState: null, blockers: item.blockers, eligible: false, landed: false,
      state: item.state, ...inFile(item), txUrl: item.txHash ? beatTxUrl(item.chain, item.txHash) : null,
    } as AdminReissueBeat)
  }
  out.sort((a, b) => a.chain.localeCompare(b.chain) || Number(BigInt(a.tokenId) - BigInt(b.tokenId)))
  const p = await provenance(r, now)
  if (items.some(({ item }) => item.state === 'clash')) p.flags.push('clash')
  const { beats: _b, ...pub } = await toPublic(r)
  return {
    ...pub, ...p, reviewer, filedVia: r.filedVia, cancelledVia: r.cancelledVia, dataDeletedAt: iso(r.dataDeletedAt), audit: r.audit,
    files: files.map((f) => fileView(r, f)), beats: out,
  }
}

/** Requests for the admin queue, newest first: open ones by default, or `all`, or one status; ADMIN_REISSUE_PAGE a page. */
export async function adminListReissueRequests(status: string | undefined, offsetArg: unknown, now = new Date()): Promise<AdminReissueRequest[]> {
  const f = status ?? 'open'
  if (!(ADMIN_STATUS_FILTERS as readonly string[]).includes(f)) throw new BeatError(400, 'bad_status', 'Unknown status filter.')
  const offset = offsetArg === undefined ? 0 : Number(offsetArg)
  if (!Number.isInteger(offset) || offset < 0) throw new BeatError(400, 'bad_offset', 'Offset must be a whole number.')
  const where = f === 'all' ? undefined : f === 'open'
    ? inArray(beatReissueRequests.status, [...BEAT_REISSUE_OPEN])
    : eq(beatReissueRequests.status, f as BeatReissueStatus)
  const rows = await db.select().from(beatReissueRequests).where(where)
    .orderBy(desc(beatReissueRequests.createdAt), desc(beatReissueRequests.id)).limit(ADMIN_REISSUE_PAGE).offset(offset)
  const out: AdminReissueRequest[] = []
  for (const r of rows) out.push(await toAdmin(r, now))
  return out
}

async function loadRequest(id: string, exec: Pick<typeof db, 'select'> = db): Promise<Req> {
  if (!UUID.test(id)) throw notFound()
  const [r] = await exec.select().from(beatReissueRequests).where(eq(beatReissueRequests.id, id))
  if (!r) throw notFound()
  return r
}

/** Re-checks a request before approval and before proposing (M8): its new wallet is still linked and unblocked, and
 * the account still has minted claims on the old wallet. */
async function recheck(r: Req): Promise<void> {
  if (!r.userId || r.dataDeletedAt) throw new BeatError(409, 'data_deleted', 'The person deleted their data; withdraw this request.')
  if (!(await walletLinked(db, r.userId, r.newWallet)) || (await isWalletBlocked(r.newWallet))) {
    throw new BeatError(409, 'wallet_not_linked', 'The new wallet is no longer linked to and verified on the account.')
  }
  if (!(await claimsOnWallet(db, r.userId, r.oldWallet)).length) {
    throw new BeatError(409, 'no_beats_on_wallet', 'The account has no minted BEATs on the old wallet any more.')
  }
}

/**
 * Approves a pending request, or rejects a pending or approved one. A rejection needs a note (the person sees it); an
 * approval's is optional. Approval re-checks the request, then blocks the old wallet: it can't sign in or be linked,
 * and its sessions end. A rejection after approval lifts that block.
 */
export async function reviewReissueRequest(
  adminId: string, id: string, decision: 'approve' | 'reject', note: unknown, now = new Date(),
): Promise<AdminReissueRequest> {
  const reviewNote = parseNote(note, decision === 'reject')
  const r0 = await loadRequest(id)
  if (decision === 'approve' && r0.status === 'pending') await recheck(r0)
  const r = await db.transaction(async (tx) => {
    const [row] = await tx.update(beatReissueRequests)
      .set({
        status: decision === 'approve' ? 'approved' : 'rejected', reviewerUserId: adminId, reviewNote, reviewedAt: now, updatedAt: now,
        audit: pushAudit(audit(adminId, decision === 'approve' ? 'approved' : 'rejected', now, reviewNote ?? undefined)),
      })
      // A rejection may also undo an approval before files were proposed; nothing is reviewed again once proposed
      .where(and(eq(beatReissueRequests.id, id), inArray(beatReissueRequests.status, decision === 'approve' ? ['pending'] : ['pending', 'approved']))).returning()
    if (!row) return null
    if (decision === 'approve') {
      await blockWallet(tx, row.oldWallet, { userId: row.userId, requestId: row.id, reason: 'reissue', byUserId: adminId, now })
    } else {
      await unblockForRequest(tx, row.oldWallet, row.id, { userId: row.userId, byUserId: adminId, now })
    }
    return row
  })
  if (!r) throw new BeatError(409, 'not_pending', decision === 'approve' ? 'Only a pending request can be approved.' : 'Only a pending or approved request can be rejected.')
  return toAdmin(r, now)
}

/**
 * Takes a wallet off the request's account (a backdoor wallet a reviewer found), blocking it too so its sessions end.
 * Not the request's new wallet while the request is open.
 */
export async function unlinkAccountWallet(adminId: string, id: string, walletArg: unknown, now = new Date()): Promise<AdminReissueRequest> {
  const r = await loadRequest(id)
  const wallet = parseWallet(walletArg)
  if (!r.userId) throw new BeatError(409, 'data_deleted', 'The person deleted their data.')
  if (isOpen(r.status) && wallet === r.newWallet) throw new BeatError(409, 'is_new_wallet', "That is the request's new wallet; reject the request instead.")
  const done = await db.transaction(async (tx) => {
    const gone = await unlinkWallet(tx, r.userId, wallet, { byUserId: adminId, requestId: r.id, note: 'unlinked by admin', now })
    if (!gone) return false
    await blockWallet(tx, wallet, { userId: r.userId, requestId: r.id, reason: 'unlinked_by_admin', byUserId: adminId, now })
    await tx.update(beatReissueRequests).set({ audit: pushAudit(audit(adminId, 'unlinked_wallet', now, wallet)), updatedAt: now }).where(eq(beatReissueRequests.id, r.id))
    return true
  })
  if (!done) throw new BeatError(404, 'wallet_not_on_account', 'That wallet is not linked to this account.')
  return toAdmin(await loadRequest(id), now)
}

// ── The Safe Transaction Builder files ───────────────────────────────────────

/**
 * Safe{Wallet} Transaction Builder's batch file, as its app imports it (safe-global/safe-react-apps,
 * apps/tx-builder/src/typings/models.ts: BatchFile, BatchFileMeta, BatchTransaction, ContractMethod): every number is a
 * string, and a transaction with `data: null` is encoded by the app from `contractMethod` and `contractInputsValues`, so
 * the signers see the decoded call. Array inputs are written "[1,2,3]" (its utils.ts parseInputValue). Each file holds
 * one transaction: Transaction Builder sends a file of several as one all-or-nothing MultiSend.
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

export type PlannedCall = { kind: 'plain' | 'tradeable'; tokenIds: string[] }

/**
 * The calls for one chain (the contract README's runbook), each its own Safe transaction: every eligible
 * non-tradeable id in one `reissue`, split at MAX_BATCH, then one per eligible tradeable id, so a thief moving one
 * tradeable copy can fail only its own transaction.
 */
export function planReissueCalls(eligible: Array<{ tokenId: string; tradeable: boolean }>): PlannedCall[] {
  const plain = eligible.filter((e) => !e.tradeable).map((e) => e.tokenId)
  const calls: PlannedCall[] = []
  for (let i = 0; i < plain.length; i += BEAT_REISSUE_MAX_BATCH) calls.push({ kind: 'plain', tokenIds: plain.slice(i, i + BEAT_REISSUE_MAX_BATCH) })
  for (const e of eligible) if (e.tradeable) calls.push({ kind: 'tradeable', tokenIds: [e.tokenId] })
  return calls
}

/** The Transaction Builder file for one call (file `index` of `count`) of a request on one chain. */
export function buildSafeBatchFile(
  r: Pick<Req, 'id' | 'oldWallet' | 'newWallet'>, chain: BeatChain, contract: string, call: PlannedCall, index: number, count: number, now: Date,
): SafeBatchFile {
  const n = call.tokenIds.length
  const safe = config.beats.adminSafes?.[chain]
  const what = call.kind === 'plain' ? `${n} non-tradeable BEAT${n === 1 ? '' : 's'}` : `tradeable BEAT ${call.tokenIds[0]}`
  const body = {
    version: '1.0' as const,
    chainId: String(BEAT_CHAIN_INFO[chain].chainId),
    createdAt: now.getTime(),
    meta: {
      name: `Virvi BEAT reissue ${r.id.slice(0, 8)} (${index + 1} of ${count})`,
      description: `Virvi reissue request ${r.id}, file ${index + 1} of ${count}: ${what} from ${getAddress(r.oldWallet)} to ${getAddress(r.newWallet)} on ${BEAT_CHAIN_INFO[chain].label}. Each file is its own Safe transaction: send the non-tradeable file first. If a tradeable file fails, reject its nonce in the Safe before sending the next.`,
      ...(safe ? { createdFromSafeAddress: safe } : {}),
    },
    transactions: [{
      to: getAddress(contract), value: '0' as const, data: null, contractMethod: REISSUE_METHOD,
      contractInputsValues: { from: getAddress(r.oldWallet), to: getAddress(r.newWallet), ids: `[${call.tokenIds.join(',')}]` },
    }],
  }
  return { ...body, meta: { ...body.meta, checksum: txBuilderChecksum(body) } }
}

/**
 * Settles a request after its items changed: each file is done once all its items are reissued (or clash). The request
 * is `done` once nothing is proposed or in a clash, at least one BEAT was reissued, and every claim of the account still
 * on the old wallet has an item (M5): the old wallet is then unlinked, and stays blocked. With nothing proposed and
 * nothing reissued, a proposed request goes back to `approved`. A request whose data was deleted goes once it is done.
 */
async function settle(tx: Exec, r: Req, now: Date): Promise<'done' | 'open'> {
  await tx.execute(sql`update beat_reissue_files f set status = 'done', done_at = ${now.toISOString()}::timestamptz
    where f.request_id = ${r.id}::uuid and f.status = 'proposed'
    and exists (select 1 from beat_reissue_items i where i.file_id = f.id)
    and not exists (select 1 from beat_reissue_items i where i.file_id = f.id and i.state not in ('reissued', 'clash'))`)
  const items = await tx.select({ claimId: beatReissueItems.claimId, state: beatReissueItems.state }).from(beatReissueItems)
    .where(eq(beatReissueItems.requestId, r.id))
  if (!items.length || items.some((i) => i.state === 'proposed' || i.state === 'clash')) return 'open'
  const covered = new Set(items.map((i) => i.claimId))
  const left = await claimsOnWallet(tx, r.userId, r.oldWallet)
  if (left.some((c) => !covered.has(c.claim.id))) return 'open'
  if (!items.some((i) => i.state === 'reissued')) {
    if (r.status === 'proposed') {
      await tx.update(beatReissueRequests).set({ status: 'approved', updatedAt: now, audit: pushAudit(audit(null, 'nothing_proposed', now, 'Nothing left in a file; back to approved.')) })
        .where(and(eq(beatReissueRequests.id, r.id), eq(beatReissueRequests.status, 'proposed')))
    }
    return 'open'
  }
  const [done] = await tx.update(beatReissueRequests).set({ status: 'done', doneAt: now, updatedAt: now, audit: pushAudit(audit(null, 'done', now)) })
    .where(and(eq(beatReissueRequests.id, r.id), eq(beatReissueRequests.status, 'proposed'))).returning()
  if (!done) return 'open'
  await unlinkWallet(tx, r.userId, r.oldWallet, { byUserId: null, requestId: r.id, note: 'reissue done', now })
  if (r.dataDeletedAt) await tx.delete(beatReissueRequests).where(eq(beatReissueRequests.id, r.id))
  return 'done'
}

export interface SafeBatchPreview {
  chain: BeatChain
  /** What proposing now would write, from a live read (nothing is recorded). */
  files: Array<PlannedCall & { callIndex: number; file: SafeBatchFile }>
  beats: ReissueCheck[]
  /** The files already proposed for this chain (not voided). */
  proposed: AdminReissueFile[]
}

async function proposalInputs(id: string, chainArg: unknown, now: Date) {
  if (typeof chainArg !== 'string' || !(BEAT_CHAINS as readonly string[]).includes(chainArg)) throw new BeatError(400, 'bad_chain', 'Unknown chain.')
  const chain = chainArg as BeatChain
  const r = await loadRequest(id)
  if (r.status !== 'approved' && r.status !== 'proposed') throw new BeatError(409, 'not_approved', 'Approve the request first.')
  const contract = config.beats.contracts[chain]
  if (!contract) throw new BeatError(409, 'no_contract', 'No BEAT contract is set up on that chain.')
  await recheck(r)
  const rows = (await claimsOnWallet(db, r.userId, r.oldWallet)).filter((x) => x.beat.chain === chain)
  const checks = await checkClaims(rows, r, now)
  const calls = planReissueCalls(checks.filter((c) => c.eligible))
  return { r, chain, contract, checks, calls }
}

/** GET safe-batch: a read-only preview of the files proposing would make, and the files already proposed. */
export async function previewSafeBatch(id: string, chainArg: unknown, now = new Date()): Promise<SafeBatchPreview> {
  const { r, chain, contract, checks, calls } = await proposalInputs(id, chainArg, now)
  const recorded = await db.select().from(beatReissueFiles)
    .where(and(eq(beatReissueFiles.requestId, r.id), eq(beatReissueFiles.chain, chain), ne(beatReissueFiles.status, 'voided')))
    .orderBy(beatReissueFiles.proposedAt, beatReissueFiles.callIndex)
  return {
    chain,
    files: calls.map((c, i) => ({ ...c, callIndex: i, file: buildSafeBatchFile(r, chain, contract, c, i, calls.length, now) })),
    beats: checks,
    proposed: recorded.map((f) => fileView(r, f)),
  }
}

/**
 * Proposes an approved (or already proposed) request on one chain, from a fresh chain read: one Transaction Builder file
 * per call, each recorded with its own status. The eligible BEATs not yet reissued go in; the rest are recorded as
 * skipped with their blockers. Proposing again (some ids never landed) voids the chain's earlier files that nothing of
 * landed from, and moves their BEATs to the new files. An id already replaced by the new wallet on chain stays in its
 * file for the watcher. With nothing eligible it refuses (`nothing_to_reissue`), still recording the blockers.
 */
export async function proposeSafeBatch(adminId: string, id: string, chainArg: unknown, now = new Date()): Promise<{ files: Array<AdminReissueFile & { file: SafeBatchFile }> }> {
  const { r, chain, contract, checks, calls } = await proposalInputs(id, chainArg, now)
  let proposedBlock: number | null = null
  if (calls.length) {
    try {
      proposedBlock = await beatChainClient(chain)!.latestBlock()
    } catch {
      throw new BeatError(503, 'chain_unavailable', "The chain can't be read right now. Try again.")
    }
  }
  const landed = checks.filter((c) => c.landed)
  const landedTokens = new Set(landed.map((c) => c.tokenId))
  const made: FileRow[] = []
  await db.transaction(async (tx) => {
    const existing = await tx.select().from(beatReissueItems).where(and(eq(beatReissueItems.requestId, r.id), eq(beatReissueItems.chain, chain)))
    const itemOf = new Map(existing.map((i) => [String(i.tokenId), i]))
    // Earlier files: kept while something of theirs landed or was reissued, else voided (their BEATs go in the new files)
    const openFiles = await tx.select().from(beatReissueFiles)
      .where(and(eq(beatReissueFiles.requestId, r.id), eq(beatReissueFiles.chain, chain), eq(beatReissueFiles.status, 'proposed')))
    for (const f of openFiles) {
      const keep = existing.some((i) => i.fileId === f.id && (i.state === 'reissued' || i.state === 'clash' || landedTokens.has(String(i.tokenId))))
      if (!keep) await tx.update(beatReissueFiles).set({ status: 'voided', voidedAt: now }).where(eq(beatReissueFiles.id, f.id))
    }
    const fileOf = new Map<string, FileRow>()
    for (const [i, call] of calls.entries()) {
      const file = buildSafeBatchFile(r, chain, contract, call, i, calls.length, now)
      const [row] = await tx.insert(beatReissueFiles).values({
        requestId: r.id, chain, callIndex: i, kind: call.kind, tokenIds: call.tokenIds, file, checksum: file.meta.checksum, proposedAt: now, proposedBlock,
      }).returning()
      made.push(row)
      for (const t of call.tokenIds) fileOf.set(t, row)
    }
    const target = [beatReissueItems.requestId, beatReissueItems.chain, beatReissueItems.tokenId]
    for (const c of checks) {
      const tokenId = Number(c.tokenId)
      const prev = itemOf.get(c.tokenId)
      if (c.landed) {
        // Replaced by the new wallet already (an earlier file, or the Safe on its own): the watcher confirms it at depth
        // and moves the claim, so it stays (or becomes) proposed, in its earlier file if it had one
        if (prev?.state === 'proposed') continue
        const values = { claimId: c.claimId, beatId: c.beatId, tradeable: c.tradeable, state: 'proposed' as const, blockers: [], fileId: null, callIndex: null, proposedAt: now, proposedBlock: null }
        await tx.insert(beatReissueItems).values({ requestId: r.id, chain, tokenId, ...values })
          .onConflictDoUpdate({ target, set: values, where: and(ne(beatReissueItems.state, 'reissued'), ne(beatReissueItems.state, 'clash')) })
        continue
      }
      const f = fileOf.get(c.tokenId)
      const values = {
        claimId: c.claimId, beatId: c.beatId, tradeable: c.tradeable,
        state: (f ? 'proposed' : 'skipped') as BeatReissueItemState, blockers: f ? [] : c.blockers,
        fileId: f?.id ?? null, callIndex: f?.callIndex ?? null, proposedAt: f ? now : null, proposedBlock: f ? proposedBlock : null,
      }
      await tx.insert(beatReissueItems).values({ requestId: r.id, chain, tokenId, ...values })
        .onConflictDoUpdate({ target, set: values, where: and(ne(beatReissueItems.state, 'reissued'), ne(beatReissueItems.state, 'clash')) })
    }
    if (calls.length || landed.length) {
      await tx.update(beatReissueRequests).set({
        status: 'proposed', proposedAt: now, updatedAt: now,
        audit: pushAudit(audit(adminId, 'proposed', now, `${chain}: ${calls.length} file${calls.length === 1 ? '' : 's'}`)),
      }).where(eq(beatReissueRequests.id, r.id))
    } else if (r.status === 'proposed') {
      await settle(tx, r, now)
    }
  })
  if (!calls.length) throw new BeatError(409, 'nothing_to_reissue', 'None of these BEATs can be reissued now.', { beats: checks.map(({ tokenId, blockers }) => ({ tokenId, blockers })) })
  return { files: made.map((f) => ({ ...fileView(r, f), file: f.file as SafeBatchFile })) }
}

/** One recorded file, exactly as proposed, to download again (not a voided one). */
export async function getSafeBatchFile(id: string, fileId: string): Promise<{ filename: string; file: SafeBatchFile }> {
  const r = await loadRequest(id)
  if (!UUID.test(fileId)) throw new BeatError(404, 'not_found', 'File not found.')
  const [f] = await db.select().from(beatReissueFiles).where(and(eq(beatReissueFiles.id, fileId), eq(beatReissueFiles.requestId, r.id)))
  if (!f) throw new BeatError(404, 'not_found', 'File not found.')
  if (f.status === 'voided') throw new BeatError(409, 'file_voided', 'This file was voided; propose again for a new one.')
  return { filename: fileName(r, f), file: f.file as SafeBatchFile }
}

/** Whether any of these proposed items has landed on chain (replacedBy names the new wallet at the latest block). */
async function anyLanded(r: Req, items: Item[]): Promise<boolean> {
  const results = await mapLimit(items, CHAIN_CONCURRENCY, async (it) => {
    const client = beatChainClient(it.chain)
    if (!client) throw new BeatError(503, 'chain_unavailable', "The chain can't be read right now. Try again.")
    try {
      const to = await client.replacedBy(BigInt(it.tokenId), r.oldWallet)
      return !!to && lc(to) === r.newWallet
    } catch {
      throw new BeatError(503, 'chain_unavailable', "The chain can't be read right now. Try again.")
    }
  })
  return results.some(Boolean)
}

/**
 * Withdraws an approved or proposed request (or, with `fileId`, one proposed file of it) that hasn't landed: its files
 * are voided, so the watcher ignores them, and its BEATs not yet reissued are withdrawn (one file: skipped, `Withdrawn`).
 * A withdrawn request is closed and the person may file again; the old wallet's block is lifted unless something of it
 * was already reissued (then the old wallet is unlinked and stays blocked). The admin must also discard the pending Safe
 * transaction. A request whose data was deleted goes once withdrawn.
 */
export async function withdrawReissue(adminId: string, id: string, body: Record<string, unknown>, now = new Date()): Promise<AdminReissueRequest | { deleted: true }> {
  const note = parseNote(body.note, false)
  const r = await loadRequest(id)
  if (r.status !== 'approved' && r.status !== 'proposed') throw new BeatError(409, 'not_withdrawable', 'Only an approved or proposed request can be withdrawn.')
  const fileId = body.fileId
  let file: FileRow | null = null
  if (fileId !== undefined) {
    if (typeof fileId !== 'string' || !UUID.test(fileId)) throw new BeatError(404, 'not_found', 'File not found.')
    ;[file] = await db.select().from(beatReissueFiles).where(and(eq(beatReissueFiles.id, fileId), eq(beatReissueFiles.requestId, r.id)))
    if (!file) throw new BeatError(404, 'not_found', 'File not found.')
    if (file.status !== 'proposed') throw new BeatError(409, 'file_not_proposed', 'Only a proposed file can be withdrawn.')
  }
  const proposed = await db.select().from(beatReissueItems).where(and(
    eq(beatReissueItems.requestId, r.id), eq(beatReissueItems.state, 'proposed'), ...(file ? [eq(beatReissueItems.fileId, file.id)] : []),
  ))
  if (await anyLanded(r, proposed)) throw new BeatError(409, 'already_landed', 'Some of these BEATs were already reissued on chain; wait for the watcher.')
  let deleted = false
  await db.transaction(async (tx) => {
    if (file) {
      await tx.update(beatReissueFiles).set({ status: 'voided', voidedAt: now }).where(eq(beatReissueFiles.id, file.id))
      await tx.update(beatReissueItems).set({ state: 'skipped', blockers: ['Withdrawn'], fileId: null, callIndex: null })
        .where(and(eq(beatReissueItems.fileId, file.id), eq(beatReissueItems.state, 'proposed')))
      await tx.update(beatReissueRequests).set({ updatedAt: now, audit: pushAudit(audit(adminId, 'withdrew_file', now, [`${file.chain} file ${file.callIndex + 1}`, note].filter(Boolean).join(': '))) })
        .where(eq(beatReissueRequests.id, r.id))
      await settle(tx, (await loadRequest(r.id, tx)), now)
      return
    }
    await tx.update(beatReissueFiles).set({ status: 'voided', voidedAt: now }).where(and(eq(beatReissueFiles.requestId, r.id), eq(beatReissueFiles.status, 'proposed')))
    await tx.update(beatReissueItems).set({ state: 'withdrawn', fileId: null, callIndex: null })
      .where(and(eq(beatReissueItems.requestId, r.id), inArray(beatReissueItems.state, ['proposed', 'skipped'])))
    const [reissued] = await tx.select({ id: beatReissueItems.id }).from(beatReissueItems)
      .where(and(eq(beatReissueItems.requestId, r.id), eq(beatReissueItems.state, 'reissued'))).limit(1)
    await tx.update(beatReissueRequests).set({ status: 'withdrawn', withdrawnAt: now, updatedAt: now, audit: pushAudit(audit(adminId, 'withdrawn', now, note ?? undefined)) })
      .where(eq(beatReissueRequests.id, r.id))
    if (reissued) await unlinkWallet(tx, r.userId, r.oldWallet, { byUserId: adminId, requestId: r.id, note: 'reissue withdrawn after a partial reissue', now })
    else await unblockForRequest(tx, r.oldWallet, r.id, { userId: r.userId, byUserId: adminId, now })
    if (r.dataDeletedAt) {
      await tx.delete(beatReissueRequests).where(eq(beatReissueRequests.id, r.id))
      deleted = true
    }
  })
  if (deleted) return { deleted: true }
  return toAdmin(await loadRequest(id), now)
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
 * The reissue watcher: for each proposed BEAT on this chain not in a voided file, reads `replacedBy(id, old)` at the
 * chain's confirmation depth (30 blocks on Polygon, 5 on Amoy, counted as for mints), CHAIN_CONCURRENCY at a time; a
 * failed read skips only that BEAT, and a failure in one request never stops the others. One that names the new
 * wallet is done: its claim moves to the new wallet (the old one kept in replaced_wallet, unless the claim was unlinked)
 * with the reissue's tx hash when the logs give it. If another claim holds the new wallet, the item is a `clash`, with
 * one admin alert. One replaced to another wallet is skipped (AlreadyReplaced).
 */
export async function watchReissues(client: BeatChainClient, now: Date): Promise<{ reissued: number; done: number }> {
  const chain = client.chain
  const open = await db.select({ item: beatReissueItems, req: beatReissueRequests }).from(beatReissueItems)
    .innerJoin(beatReissueRequests, eq(beatReissueRequests.id, beatReissueItems.requestId))
    .leftJoin(beatReissueFiles, eq(beatReissueFiles.id, beatReissueItems.fileId))
    .where(and(
      eq(beatReissueItems.chain, chain), eq(beatReissueItems.state, 'proposed'), eq(beatReissueRequests.status, 'proposed'),
      or(sql`${beatReissueItems.fileId} is null`, ne(beatReissueFiles.status, 'voided')),
    ))
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
    try {
      const reads = await mapLimit(items, CHAIN_CONCURRENCY, async (it) => {
        try {
          return await client.replacedBy(BigInt(it.tokenId), req.oldWallet, head)
        } catch (err) {
          console.error(`[beats] reissue read on ${chain} failed (request ${req.id}, BEAT ${it.tokenId}): ${(err as Error).name}`)
          return undefined
        }
      })
      const landed: Item[] = []
      const elsewhere: Item[] = []
      items.forEach((it, i) => {
        const to = reads[i]
        if (!to) return
        ;(lc(to) === req.newWallet ? landed : elsewhere).push(it)
      })
      if (!landed.length && !elsewhere.length) continue
      const from = Math.min(...landed.map((i) => i.proposedBlock ?? 0))
      const hashes = landed.length ? await findHashes(client, req, new Set(landed.map((i) => String(i.tokenId))), from, head) : new Map<string, string>()
      const clashes: Item[] = []
      await db.transaction(async (tx) => {
        for (const it of landed) {
          const hash = hashes.get(String(it.tokenId)) ?? null
          const [claim] = it.claimId ? await tx.select().from(beatClaims).where(eq(beatClaims.id, it.claimId)) : []
          // The new wallet can't already be on another claim of this BEAT (ClaimOnNewWallet when it was proposed); if one
          // appeared since, the claim keeps its wallet (the per-BEAT wallet rule) and an admin is told
          const [clash] = claim
            ? await tx.select({ id: beatClaims.id }).from(beatClaims)
              .where(and(eq(beatClaims.beatId, claim.beatId), eq(beatClaims.wallet, req.newWallet), ne(beatClaims.id, claim.id)))
            : []
          if (clash) {
            await tx.update(beatReissueItems).set({ state: 'clash', txHash: hash, reissuedAt: now, blockers: ['ClaimOnNewWallet'] }).where(eq(beatReissueItems.id, it.id))
            clashes.push(it)
            continue
          }
          await tx.update(beatReissueItems).set({ state: 'reissued', txHash: hash, reissuedAt: now, blockers: [] }).where(eq(beatReissueItems.id, it.id))
          if (!claim) continue
          await tx.update(beatClaims).set({ wallet: req.newWallet, replacedWallet: claim.userId ? req.oldWallet : null, reissueTx: hash, reissuedAt: now })
            .where(and(eq(beatClaims.id, claim.id), eq(beatClaims.wallet, req.oldWallet)))
          reissued++
        }
        for (const it of elsewhere) {
          await tx.update(beatReissueItems).set({ state: 'skipped', blockers: ['AlreadyReplaced'], fileId: null, callIndex: null }).where(eq(beatReissueItems.id, it.id))
        }
        if ((await settle(tx, req, now)) === 'done') done++
      })
      if (clashes.length) {
        recordJobFailure('beat_reissue', `BEAT reissue request ${req.id}: ${clashes.length} BEAT(s) reissued on chain, but another claim holds the new wallet; the claim was not moved (${chain}).`)
      }
      console.log(`[beats] reissue request ${req.id} on ${chain}: ${landed.length - clashes.length} reissued, ${clashes.length} clash, ${elsewhere.length} replaced elsewhere`)
    } catch (err) {
      console.error(`[beats] reissue request ${req.id} on ${chain} failed: ${(err as Error).name}`)
    }
  }
  return { reissued, done }
}

// ── Privacy ──────────────────────────────────────────────────────────────────

/**
 * Delete-my-data: the account's reissue requests go, except one that is approved or proposed (a Safe transaction may be
 * on its way). That one keeps only its wallets, BEAT ids and state, unlinked from the account (no reason, notes or
 * sign-in records), with an audit note for the admin, until it settles or is withdrawn; then it is deleted.
 */
export async function deleteMyReissueRequests(exec: Exec, userId: string, now = new Date()): Promise<number> {
  // A blocked wallet stays blocked (it was compromised, or an admin removed it), but no longer names the account
  await exec.update(walletBlocks).set({ userId: null }).where(eq(walletBlocks.userId, userId))
  await exec.update(beatReissueRequests).set({
    userId: null, reason: null, reviewNote: null, filedVia: null, cancelledVia: null, dataDeletedAt: now, updatedAt: now,
    audit: pushAudit(audit(null, 'data_deleted', now, 'The person deleted their data during the reissue: only the wallets, BEAT ids and state are kept, until it is done or withdrawn.')),
  }).where(and(eq(beatReissueRequests.userId, userId), inArray(beatReissueRequests.status, ['approved', 'proposed'])))
  return (await exec.delete(beatReissueRequests).where(eq(beatReissueRequests.userId, userId)).returning({ id: beatReissueRequests.id })).length
}

/** The 30-day scrub: requests closed (rejected, cancelled, done, withdrawn) that long ago go. Open ones are kept. */
export async function scrubReissueRequests(cutoff: Date): Promise<number> {
  const closedAt = sql`coalesce(${beatReissueRequests.doneAt}, ${beatReissueRequests.cancelledAt}, ${beatReissueRequests.withdrawnAt}, ${beatReissueRequests.reviewedAt}, ${beatReissueRequests.updatedAt})`
  const rows = await db.delete(beatReissueRequests).where(and(
    inArray(beatReissueRequests.status, ['rejected', 'cancelled', 'done', 'withdrawn']),
    sql`${closedAt} <= ${cutoff.toISOString()}::timestamptz`,
  )).returning({ id: beatReissueRequests.id })
  return rows.length
}
