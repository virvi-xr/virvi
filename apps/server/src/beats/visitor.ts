import { createHmac, randomBytes } from 'node:crypto'
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import {
  BEAT_CARD_LEAD_MS, BEAT_CLAIM_GRACE_MS, BEAT_CONSENT_VERSIONS_ACCEPTED, BEAT_FINAL_FAIL_REASONS, beatTxUrl, cleanDisplayName,
  type AvailableBeat, type BeatClaimStatus, type BeatStatus, type VisitorBeat,
} from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { beatClaims, beatNetworkClaims, beats, beatScenes, mediaAssets } from '../db/schema.js'
import { checkInDelta } from '../presence/attendance.js'
import { ipKey } from '../errors/limits.js'
import { BeatError } from './errors.js'
import { beatRetired } from './contract.js'
import { beatLiveSince } from './live.js'
import { beatImageUrl } from './metadata.js'
import { claimHeld } from './service.js'
import { platformCheck, type BeatPlatform } from './platform-checks.js'
import { isNewWallet, takeNewWallet } from './new-wallet-limit.js'
import { isWalletBlocked } from '../auth/wallet-blocks.js'

/**
 * BEATs (LIV-11), the visitor side: the scene's current BEAT, opting in, check-ins, claiming and stopping. No Fastify
 * here; the routes check the pass (a Decentraland scene pass bound to the scene, with a verified wallet). A claim with
 * `delete_requested` doesn't exist to its visitor any more. Nothing here logs a wallet or a display name.
 */

type BeatRow = typeof beats.$inferSelect
type ClaimRow = typeof beatClaims.$inferSelect
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface VisitorCaller {
  userId: string
  /** The pass's verified wallet, or null. */
  wallet: string | null
  /** The Decentraland sign-in name the pass came with. */
  signInName: string | null
  /** The platform the pass is from: its own wallet check applies (platform-checks.ts). */
  platform?: BeatPlatform
  /** The client's address (request.ip, which respects TRUST_PROXY_HOPS), for the per-network claim limit. */
  ip?: string | null
}

/** A wallet blocked by a reissue or an admin unlink (LIV-11) never earns another BEAT, on any account. */
const beatsBlocked = () => new BeatError(403, 'beats_blocked', "This wallet can't collect BEATs any more.")
const profileRequired = () => new BeatError(403, 'profile_required', 'Set up your Decentraland profile (an avatar) first, then come back to collect this BEAT.')

const tooManyNewWallets = () => new BeatError(429, 'too_many_new_wallets', 'Too many new wallets have collected BEATs from your network. Try again later.')

/**
 * The network a claim came from, as an HMAC keyed by the server secret (BEAT_NETWORK_HASH_SECRET) and the BEAT's own
 * random salt together (fix round N-2): neither a database dump nor the secret alone reverses it, and the same network
 * hashes differently on every BEAT. Rotating the secret only resets the counts.
 */
export function beatNetworkHash(salt: string, ip: string): string {
  const key = createHmac('sha256', config.beats.networkHashSecret).update(salt).digest()
  return createHmac('sha256', key).update(ipKey(ip)).digest('hex').slice(0, 32)
}

/** Fix round I-5: a wallet Virvi saw for the first time recently costs its network one of BEAT_NEW_WALLETS_PER_IP_HOUR. */
async function checkNewWallet(ip: string | null | undefined, wallet: string, now: Date): Promise<void> {
  if (!ip) return
  if ((await isNewWallet(wallet, now)) && !takeNewWallet(ip, wallet, now.getTime())) throw tooManyNewWallets()
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VISIBLE: BeatStatus[] = ['paid', 'live', 'ended']
/** The claims that take a token from the supply. */
const TAKEN: BeatClaimStatus[] = ['claimed', 'minting', 'minted', 'failed']

const notFound = () => new BeatError(404, 'not_found', 'BEAT not found.')
const notTracking = () => new BeatError(404, 'not_tracking', "You're not tracking this BEAT.")
const claimUntil = (b: BeatRow) => new Date(b.endsAt.getTime() + BEAT_CLAIM_GRACE_MS)
/** Test BEATs (Amoy) left over once the server runs on mainnet aren't shown to visitors. */
// Test BEATs on mainnet, and retired ones (on a replaced contract: Virvi would never send a claim), aren't shown or claimable
const hidden = (b: BeatRow) => (config.beats.chain === 'polygon' && b.chain === 'polygon-amoy') || beatRetired(b)

/** The BEAT, when it is paid, live or ended and on this scene; 404 otherwise. */
async function beatOnScene(sceneId: string, beatId: string): Promise<BeatRow> {
  if (!UUID.test(sceneId) || !UUID.test(beatId)) throw notFound()
  const [hit] = await db.select({ b: beats }).from(beats)
    .innerJoin(beatScenes, and(eq(beatScenes.beatId, beats.id), eq(beatScenes.sceneId, sceneId)))
    .where(eq(beats.id, beatId))
  if (!hit || !VISIBLE.includes(hit.b.status) || hidden(hit.b)) throw notFound()
  return hit.b
}

/** True when the BEAT is on this scene and cancelled. */
async function cancelledOnScene(sceneId: string, beatId: string): Promise<boolean> {
  if (!UUID.test(sceneId) || !UUID.test(beatId)) return false
  const [hit] = await db.select({ status: beats.status }).from(beats)
    .innerJoin(beatScenes, and(eq(beatScenes.beatId, beats.id), eq(beatScenes.sceneId, sceneId)))
    .where(eq(beats.id, beatId))
  return hit?.status === 'cancelled'
}

/** The user's claim on the BEAT (one that isn't being deleted), locked when inside a transaction that asks for it. */
async function myClaimRow(q: Pick<Tx, 'select'>, beatId: string, userId: string, lock = false): Promise<ClaimRow | null> {
  const base = q.select().from(beatClaims).where(and(eq(beatClaims.beatId, beatId), eq(beatClaims.userId, userId), eq(beatClaims.deleteRequested, false)))
  const [row] = lock ? await base.for('update') : await base
  return row ?? null
}

async function takenCount(q: Pick<Tx, 'select'>, beatId: string): Promise<number> {
  const [r] = await q.select({ n: sql<number>`count(*)::int` }).from(beatClaims).where(and(eq(beatClaims.beatId, beatId), inArray(beatClaims.status, TAKEN)))
  return r?.n ?? 0
}

async function toVisitor(b: BeatRow, claim: ClaimRow | null): Promise<VisitorBeat> {
  const media = b.imageUrl || !b.imageMediaId ? null : await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, b.imageMediaId), columns: { publicUrl: true } })
  return {
    id: b.id,
    name: b.name,
    imageUrl: beatImageUrl(b.imageUrl, media?.publicUrl ?? null),
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    minPresentSeconds: b.minPresentSeconds,
    status: b.status,
    soldOut: (await takenCount(db, b.id)) >= b.supplyCap,
    claimUntil: claimUntil(b).toISOString(),
    test: b.chain === 'polygon-amoy',
    autoClaim: b.autoClaim,
    myClaim: claim ? {
      status: claim.status, secondsPresent: claim.secondsPresent ?? 0, txUrl: claim.mintTx ? beatTxUrl(b.chain, claim.mintTx) : null,
      final: claim.status === 'failed' && (BEAT_FINAL_FAIL_REASONS as readonly string[]).includes(claim.failReason ?? ''),
      heldUntil: claim.status === 'claimed' && claimHeld(b, claim.claimedAt, new Date()) ? claimUntil(b).toISOString() : null,
    } : null,
  }
}

async function visitorView(beatId: string, userId: string): Promise<{ beat: VisitorBeat }> {
  const b = await db.query.beats.findFirst({ where: eq(beats.id, beatId) })
  if (!b) throw notFound()
  return { beat: await toVisitor(b, await myClaimRow(db, beatId, userId)) }
}

/**
 * The scene's BEAT with one of `statuses`, from BEAT_CARD_LEAD_MS before its start until `afterEndMs` after its end
 * (test BEATs hidden on mainnet). One that is running wins over one still in its grace or not yet started, then the
 * latest start.
 */
async function sceneBeat(sceneId: string, now: Date, statuses: BeatStatus[], afterEndMs: number): Promise<BeatRow | null> {
  return (await sceneBeats(sceneId, now, statuses, afterEndMs))[0] ?? null
}

/** Every BEAT `sceneBeat` could pick, best first. */
async function sceneBeats(sceneId: string, now: Date, statuses: BeatStatus[], afterEndMs: number): Promise<BeatRow[]> {
  const t = now.toISOString()
  const rows = await db.select({ b: beats }).from(beats)
    .innerJoin(beatScenes, eq(beatScenes.beatId, beats.id))
    .where(and(
      eq(beatScenes.sceneId, sceneId),
      inArray(beats.status, statuses),
      lte(beats.startsAt, new Date(now.getTime() + BEAT_CARD_LEAD_MS)),
      gte(beats.endsAt, new Date(now.getTime() - afterEndMs)),
    ))
    .orderBy(sql`(${beats.startsAt} <= ${t}::timestamptz and ${beats.endsAt} >= ${t}::timestamptz) desc`, desc(beats.startsAt))
  return rows.map((r) => r.b).filter((r) => !hidden(r))
}

/**
 * The scene's BEAT for the card: paid, live or ended, from the lead time until the claim grace after its end. After
 * its end a BEAT is shown only to visitors with a claim on it (LIV-184); anyone else gets the scene's next BEAT, if any.
 */
export async function currentBeat(sceneId: string, userId: string, now = new Date()): Promise<{ beat: VisitorBeat | null }> {
  if (!UUID.test(sceneId)) throw notFound()
  for (const b of await sceneBeats(sceneId, now, VISIBLE, BEAT_CLAIM_GRACE_MS)) {
    const claim = await myClaimRow(db, b.id, userId)
    const over = now.getTime() > b.endsAt.getTime() || b.status === 'ended'
    if (over && !claim) continue
    return { beat: await toVisitor(b, claim) }
  }
  return { beat: null }
}

/**
 * For the room's `beat_available` (guests can't use REST): the scene's paid or live BEAT inside the card window
 * (lead time to end), as its name and test flag only.
 */
export async function availableBeat(sceneId: string, now = new Date()): Promise<AvailableBeat | null> {
  if (!UUID.test(sceneId)) return null
  const b = await sceneBeat(sceneId, now, ['paid', 'live'], 0)
  return b ? { name: b.name, test: b.chain === 'polygon-amoy' } : null
}

/**
 * Opt in: the consent must be a version the server accepts (BEAT_CONSENT_VERSIONS_ACCEPTED; the claim stores the one
 * sent) and the caller needs a verified wallet. Allowed from the card's lead time until the end. Idempotent: tracking
 * again keeps the time present, and a newer version sent over a present claim's older one replaces it. On a BEAT that
 * has started with a minimum of 0, an auto-claim (LIV-180) follows at once.
 */
export async function trackBeat(sceneId: string, beatId: string, c: VisitorCaller, consentVersion: unknown, now = new Date()): Promise<{ beat: VisitorBeat }> {
  const b = await beatOnScene(sceneId, beatId)
  if (typeof consentVersion !== 'number' || !BEAT_CONSENT_VERSIONS_ACCEPTED.includes(consentVersion)) {
    throw new BeatError(400, 'bad_consent', 'This scene needs an update before visitors can claim BEATs. Ask the host to update it.')
  }
  const version = consentVersion
  if (!c.wallet) throw new BeatError(403, 'no_wallet', "Sign in to Decentraland with a wallet to earn this BEAT. Guests can't.")
  if (now.getTime() > b.endsAt.getTime()) throw new BeatError(409, 'too_late', 'This BEAT has ended.')
  if (now.getTime() < b.startsAt.getTime() - BEAT_CARD_LEAD_MS) throw new BeatError(409, 'too_early', "This BEAT hasn't opened yet.")
  // Checked before tracking starts too, so a wallet that can't claim learns it now rather than after its time
  if (!(await platformCheck(c.platform ?? 'decentraland', c.wallet, now))) throw profileRequired()
  await checkNewWallet(c.ip, c.wallet, now)
  if (await isWalletBlocked(c.wallet)) throw beatsBlocked()
  const wallet = c.wallet.toLowerCase()
  const displayName = cleanDisplayName(c.signInName, wallet)
  const claim = await db.transaction(async (tx) => {
    // The user's row, or the wallet's (unique per BEAT): either may already exist
    await tx.insert(beatClaims).values({
      beatId: b.id, userId: c.userId, wallet, displayName, consentVersion: version, consentedAt: now, lastSeenAt: now, createdAt: now,
    }).onConflictDoNothing()
    const [mine] = await tx.select().from(beatClaims).where(and(eq(beatClaims.beatId, b.id), eq(beatClaims.userId, c.userId))).for('update')
    // Being deleted, or the wallet's row belongs to no one now (its data was removed): not brought back
    if (!mine || mine.deleteRequested) throw new BeatError(409, 'not_available', "You stopped tracking this BEAT, so you can't start again.")
    // Only ever upgraded: a scene on an older runtime doesn't take back wording the visitor agreed to elsewhere
    if (mine.status === 'present' && mine.consentVersion < version) {
      await tx.update(beatClaims).set({ consentVersion: version, consentedAt: now }).where(eq(beatClaims.id, mine.id))
      return { ...mine, consentVersion: version }
    }
    return mine
  })
  if (now.getTime() >= b.startsAt.getTime() && b.minPresentSeconds === 0) await autoClaim(sceneId, b, claim, c, now)
  return visitorView(b.id, c.userId)
}

/** The first consent version whose text tells the visitor that agreeing claims the BEAT for them. */
const AUTO_CLAIM_CONSENT = 3

/**
 * Auto-claim (LIV-180): when the BEAT has it on, the claim is present, its visitor agreed to a consent that says so
 * (v3+) and has the time, claims through claimBeat (its locks and every check). A refusal (not yet, too late, all
 * claimed, the network, the wallet checks) is swallowed: the caller returns the visitor view, whose card then shows the
 * state as before (sold out, or the Claim button).
 */
async function autoClaim(sceneId: string, b: BeatRow, claim: ClaimRow, c: Pick<VisitorCaller, 'userId' | 'platform' | 'ip'>, now: Date): Promise<void> {
  if (!b.autoClaim || claim.status !== 'present' || claim.consentVersion < AUTO_CLAIM_CONSENT) return
  if ((claim.secondsPresent ?? 0) < b.minPresentSeconds) return
  try {
    await claimBeat(sceneId, b.id, c, now)
  } catch (e) {
    if (!(e instanceof BeatError)) throw e
  }
}

/** The seconds of [now - addSeconds, now] that fall inside the BEAT's window. */
function inWindowSeconds(b: BeatRow, now: Date, addSeconds: number): number {
  const from = Math.max(now.getTime() - addSeconds * 1000, b.startsAt.getTime())
  const to = Math.min(now.getTime(), b.endsAt.getTime())
  return to > from ? Math.floor((to - from) / 1000) : 0
}

/**
 * A check-in: the time since the last (checkInDelta, capped) counts, but only the part inside [starts_at, ends_at], and
 * only while the user held a live room connection from this scene (live.ts): the part since that connection opened. With
 * none the check-in is accepted (its time moves on) and credits nothing. A check-in too soon after the last (another
 * scene of the same BEAT, say) changes nothing and returns the claim as it is. A check-in that moved the time on may
 * auto-claim (LIV-180).
 */
export async function checkInBeat(sceneId: string, beatId: string, c: Pick<VisitorCaller, 'userId' | 'platform' | 'ip'>, now = new Date()): Promise<{ beat: VisitorBeat }> {
  const userId = c.userId
  const b = await beatOnScene(sceneId, beatId)
  const liveSince = await beatLiveSince(sceneId, userId)
  const after = await db.transaction(async (tx) => {
    const claim = await myClaimRow(tx, b.id, userId, true)
    if (!claim) throw notTracking()
    if (claim.status !== 'present') return null
    const { accepted, addSeconds } = checkInDelta(claim.lastSeenAt, now)
    if (!accepted) return null
    const live = liveSince === null ? 0 : Math.max(0, Math.min(addSeconds, Math.floor((now.getTime() - liveSince) / 1000)))
    const add = inWindowSeconds(b, now, live)
    const [updated] = await tx.update(beatClaims).set({ lastSeenAt: now, secondsPresent: sql`${beatClaims.secondsPresent} + ${add}` }).where(eq(beatClaims.id, claim.id)).returning()
    return updated ?? null
  })
  // Only after a check-in that updated the time; claimBeat takes its own locks and checks again
  if (after) await autoClaim(sceneId, b, after, c, now)
  return visitorView(b.id, userId)
}

/**
 * Claim: a present claim with enough time, from the start until the grace runs out, while the supply lasts and the
 * claimer's network has claimed fewer than BEAT_CLAIMS_PER_IP of this BEAT. Under the BEAT row's lock, so concurrent
 * claims count the supply and the network one at a time. The platform's wallet check (platform-checks.ts) runs first.
 * A claim already further along is returned as it is.
 */
export async function claimBeat(
  sceneId: string, beatId: string, c: Pick<VisitorCaller, 'userId' | 'platform' | 'ip'>, now = new Date(),
): Promise<{ beat: VisitorBeat }> {
  const userId = c.userId
  const seen = await beatOnScene(sceneId, beatId)
  const pre = await myClaimRow(db, seen.id, userId)
  if (pre?.status === 'present') {
    if (!(await platformCheck(c.platform ?? 'decentraland', pre.wallet, now))) throw profileRequired()
    await checkNewWallet(c.ip, pre.wallet, now)
    if (await isWalletBlocked(pre.wallet)) throw beatsBlocked()
  }
  await db.transaction(async (tx) => {
    const [b] = await tx.select().from(beats).where(eq(beats.id, seen.id)).for('update')
    if (!b || !VISIBLE.includes(b.status)) throw notFound()
    const claim = await myClaimRow(tx, b.id, userId, true)
    if (!claim) throw notTracking()
    if (claim.status !== 'present') return
    // Tracking opens before the start, so with a minimum of 0 the time alone would allow it
    if (now.getTime() < b.startsAt.getTime()) throw new BeatError(409, 'not_started', "This event hasn't started yet.")
    if (now.getTime() > claimUntil(b).getTime()) throw new BeatError(409, 'too_late', 'The time to claim this BEAT is over.')
    if ((claim.secondsPresent ?? 0) < b.minPresentSeconds) throw new BeatError(409, 'not_yet', "You haven't been here long enough yet.")
    if ((await takenCount(tx, b.id)) >= b.supplyCap) throw new BeatError(409, 'all_claimed', 'All of these BEATs have been claimed.')
    if (c.ip) {
      // Counted per network in beat_network_claims, apart from the claims (fix round I-2): a delete of a claim's data or
      // a host's removal never hands the network a claim back. The salt is the BEAT's own, made on first use
      let salt = b.networkSalt
      if (!salt) {
        salt = randomBytes(32).toString('hex')
        await tx.update(beats).set({ networkSalt: salt }).where(eq(beats.id, b.id))
      }
      const netHash = beatNetworkHash(salt, c.ip)
      const [n] = await tx.select({ claims: beatNetworkClaims.claims }).from(beatNetworkClaims)
        .where(and(eq(beatNetworkClaims.beatId, b.id), eq(beatNetworkClaims.netHash, netHash))).for('update')
      if ((n?.claims ?? 0) >= config.beats.claimsPerIp) {
        throw new BeatError(429, 'too_many_from_network', 'This BEAT has already been claimed too many times from your network.')
      }
      await tx.insert(beatNetworkClaims).values({ beatId: b.id, netHash, claims: 1 })
        .onConflictDoUpdate({ target: [beatNetworkClaims.beatId, beatNetworkClaims.netHash], set: { claims: sql`${beatNetworkClaims.claims} + 1` } })
    }
    // Stamped by the database's clock, as a host's Send is (fix round N-1)
    await tx.update(beatClaims).set({ status: 'claimed', claimedAt: sql`clock_timestamp()` }).where(and(eq(beatClaims.id, claim.id), eq(beatClaims.status, 'present')))
  })
  return visitorView(seen.id, userId)
}

/**
 * Stop tracking: deletes a present claim. Once claimed it stays (`already_claimed`). On a cancelled BEAT it always
 * succeeds: cancelling deleted every present claim already (privacy I4).
 */
export async function stopTrackingBeat(sceneId: string, beatId: string, userId: string): Promise<void> {
  if (await cancelledOnScene(sceneId, beatId)) {
    await db.delete(beatClaims).where(and(eq(beatClaims.beatId, beatId), eq(beatClaims.userId, userId), eq(beatClaims.status, 'present')))
    return
  }
  const b = await beatOnScene(sceneId, beatId)
  const claim = await myClaimRow(db, b.id, userId)
  if (!claim) throw notTracking()
  const gone = await db.delete(beatClaims).where(and(eq(beatClaims.id, claim.id), eq(beatClaims.status, 'present'), eq(beatClaims.deleteRequested, false))).returning({ id: beatClaims.id })
  if (!gone.length) throw new BeatError(409, 'already_claimed', "You've claimed this BEAT, so it can't be stopped.")
}
