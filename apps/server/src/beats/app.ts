import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { getAddress } from 'ethers'
import {
  BEAT_APP_CONSENT_VERSION, BEAT_CARD_LEAD_MS, BEAT_CLAIM_GRACE_MS, cleanDisplayName, parseRingCode, BEAT_PIN_RADIUS, type BeatPin, type AppBeatCard, type BeatClaimStatus,
} from '@virvixr/shared'
import { db } from '../db/connection.js'
import { arSpaces, beatArcs, beatClaims, beats, beatScenes, mediaAssets, scenes, users } from '../db/schema.js'
import { liveScene } from '../scenes/live.js'
import { checkInDelta } from '../presence/attendance.js'
import { isWalletBlocked } from '../auth/wallet-blocks.js'
import { BeatError } from './errors.js'
import { locationCheck, type Fix } from './geo.js'
import { arLiveSince } from './live.js'
import { beatImageUrl } from './metadata.js'
import { walletsOf } from './collection.js'
import { platformCheck } from './platform-checks.js'
import { VISIBLE, chargeClaimNetwork, checkNewWallet, claimUntil, hidden, inWindowSeconds, myClaimRow, profileRequired, sceneBeats, takenCount } from './visitor.js'

/**
 * BEATs in the Virvi app (iPhone, and a signed-in Quest): the card for an AR space, tracking, check-ins, claiming with a
 * wallet chosen at claim time, and the caller's own BEATs. Beside the in-world side (visitor.ts), sharing its claims:
 * one claim per account per BEAT wherever it started, so minutes in Decentraland and in an AR space add up.
 *
 * App claims start with no wallet. At claim, one verified wallet that can collect BEATs is used, several ask which, none
 * leaves the claim `waiting` (holding its copy). They skip the per-network claim cap, the new-wallets-per-network limit
 * and the Decentraland profile check (venue Wi-Fi puts every visitor on one network); in their place the account needs
 * a verified email or wallet, and each app install (its App Attest key) has at most one claim per BEAT.
 * No Fastify here; the routes check the session and the install's assertion. Nothing here logs a wallet or a name.
 */

type BeatRow = typeof beats.$inferSelect
type ClaimRow = typeof beatClaims.$inferSelect

/** Where tracking starts: in an AR space, or at an event BEAT's ARC (with the phone's location, never stored). */
export type AppVia = { spaceId: string } | { arcCode: string; location?: AppLocation }
export type AppLocation = Fix
/** Whether the caller may build in a scene: they see its unpublished spaces, as on the space's feed. */
export type MayBuild = (sceneId: string) => Promise<boolean>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHOWN: BeatClaimStatus[] = ['present', 'waiting', 'claimed', 'minting', 'minted']

const notFound = () => new BeatError(404, 'not_found', 'BEAT not found.')
const spaceNotFound = () => new BeatError(404, 'not_found', 'AR space not found.')
const notTracking = () => new BeatError(404, 'not_tracking', "You're not tracking this BEAT.")
const isQuestKey = (key: string | null | undefined) => !!key && key.startsWith('quest:')
/** A Quest has no ARC to scan and no location: an event BEAT with a `quest:` install key can only be a forged request. */
const phoneOnly = () => new BeatError(403, 'phone_only', "Scan this BEAT's ARC with the Virvi app on your phone.")
const thisDevice = () => new BeatError(409, 'this_device', 'This phone already has this BEAT.')
const walletHasIt = () => new BeatError(409, 'wallet_has_it', 'This wallet already has this BEAT.')
const allClaimed = () => new BeatError(409, 'all_claimed', 'All of these BEATs have been claimed.')
const beatsBlocked = () => new BeatError(403, 'beats_blocked', "This wallet can't collect BEATs any more.")

/** A unique index the write ran into, as the refusal it means (any other error is thrown as it is). */
function uniqueRefusal(e: unknown): unknown {
  const err = e as { code?: string; constraint_name?: string }
  if (err.code !== '23505') return e
  if (err.constraint_name === 'beat_claims_beat_install_key_uq') return thisDevice()
  if (err.constraint_name === 'beat_claims_beat_wallet_uq') return walletHasIt()
  return e
}

/** The space's scene, when the space is published (or the caller builds there) and its scene isn't deleted; 404 otherwise. */
async function spaceSceneFor(spaceId: string, mayBuild?: MayBuild): Promise<string> {
  if (!UUID.test(spaceId)) throw spaceNotFound()
  const [row] = await db.select({ sceneId: arSpaces.sceneId, published: arSpaces.published }).from(arSpaces)
    .innerJoin(scenes, eq(scenes.id, arSpaces.sceneId)).where(and(eq(arSpaces.id, spaceId), liveScene()))
  if (!row || (!row.published && !(mayBuild && (await mayBuild(row.sceneId))))) throw spaceNotFound()
  return row.sceneId
}

/** The BEAT when it is paid, live or ended, shown to visitors, and (with a scene) on that scene; 404 otherwise. */
async function visibleBeat(beatId: string, sceneId?: string): Promise<BeatRow> {
  if (!UUID.test(beatId)) throw notFound()
  const [hit] = sceneId
    ? await db.select({ b: beats }).from(beats).innerJoin(beatScenes, and(eq(beatScenes.beatId, beats.id), eq(beatScenes.sceneId, sceneId))).where(eq(beats.id, beatId))
    : await db.select({ b: beats }).from(beats).where(eq(beats.id, beatId))
  if (!hit || !VISIBLE.includes(hit.b.status) || hidden(hit.b)) throw notFound()
  return hit.b
}

/** The account's verified wallets that can collect BEATs (not blocked), checksummed. */
async function collectingWallets(userId: string): Promise<string[]> {
  const out: string[] = []
  for (const w of await walletsOf(userId)) if (!(await isWalletBlocked(w.toLowerCase()))) out.push(w)
  return out
}

/**
 * The seconds a claim has. An event claim (source `app_event`): wall-clock time since the check-in, inside the BEAT's
 * window, and never less than it already has. A claim started elsewhere that scanned the event ARC: the seconds it had
 * at the scan plus wall-clock time since the scan, inside the window, and never less than it has (time earned elsewhere
 * since the scan counts once: the larger wins). Any other claim keeps the time it has.
 */
function eventSeconds(b: BeatRow, claim: ClaimRow, now: Date): number {
  const had = claim.secondsPresent ?? 0
  const since = (at: Date) => {
    const from = Math.max(at.getTime(), b.startsAt.getTime())
    const to = Math.min(now.getTime(), b.endsAt.getTime())
    return to > from ? Math.floor((to - from) / 1000) : 0
  }
  if (claim.source === 'app_event') return claim.consentedAt ? Math.max(had, since(claim.consentedAt)) : had
  if (claim.eventCheckedInAt) return Math.max(had, (claim.secondsAtEventScan ?? 0) + since(claim.eventCheckedInAt))
  return had
}

/** Whether the claim checked in at the event (started there, or scanned its ARC later): its claim re-checks the pin. */
const checkedInAtEvent = (claim: ClaimRow) => claim.source === 'app_event' || !!claim.eventCheckedInAt

/** The BEAT's venue pin, when it has one (the radius defaults to 150 m). */
function pinOf(b: BeatRow): BeatPin | null {
  return b.pinLat === null || b.pinLng === null ? null : { lat: b.pinLat, lng: b.pinLng, radiusM: b.pinRadiusM ?? BEAT_PIN_RADIUS.defaultM }
}

const venueOf = (b: BeatRow) => b.locationVenue?.trim() || 'the venue'

/** The pin check at check-in or claim: passes, or the refusal (outside 403, poor fix 422, no location 400). */
function requireAtVenue(b: BeatRow, loc: Fix | undefined, outsideMessage: string): void {
  switch (locationCheck(pinOf(b), loc)) {
    case 'ok': return
    case 'outside': throw new BeatError(403, 'outside', outsideMessage)
    case 'poor': throw new BeatError(422, 'poor_fix', "Couldn't get your location accurately. Step outside or near a window and try again.")
    case 'missing': throw new BeatError(400, 'location_needed', 'Your location is needed to check in at this event.')
  }
}

/** When the claim checked in: the app's consent for a claim started in the app, else the in-world consent. */
const checkedInAtOf = (claim: ClaimRow): Date | null =>
  (claim.source.startsWith('app_') ? claim.appConsentedAt ?? claim.consentedAt : claim.consentedAt) ?? null

async function toCard(b: BeatRow, claim: ClaimRow | null, wallets: string[]): Promise<AppBeatCard> {
  const media = b.imageUrl || !b.imageMediaId ? null : await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, b.imageMediaId), columns: { publicUrl: true } })
  return {
    beatId: b.id,
    name: b.name,
    imageUrl: beatImageUrl(b.imageUrl, media?.publicUrl ?? null),
    minMinutes: Math.ceil(b.minPresentSeconds / 60),
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    location: b.locationType === 'in_person' && b.locationVenue ? { type: b.locationType, venue: b.locationVenue } : { type: b.locationType },
    claim: claim ? {
      status: claim.status,
      secondsPresent: claim.status === 'present' ? eventSeconds(b, claim, new Date()) : claim.secondsPresent ?? 0,
      wallet: claim.wallet ? getAddress(claim.wallet) : null,
      checkedInAt: checkedInAtOf(claim)?.toISOString() ?? null,
    } : null,
    wallets,
  }
}

/** The caller's card for a BEAT (what an event ARC's lookup returns to a signed-in caller). */
export const appBeatCard = (beatId: string, userId: string) => cardFor(beatId, userId)

async function cardFor(beatId: string, userId: string): Promise<AppBeatCard> {
  const b = await db.query.beats.findFirst({ where: eq(beats.id, beatId) })
  if (!b) throw notFound()
  return toCard(b, await myClaimRow(db, beatId, userId), await collectingWallets(userId))
}

/**
 * The space's BEAT for the card, picked as the in-world card picks it (sceneBeats): any of the scene's BEATs, whatever
 * its location type, from the lead time until the claim grace after its end; after its end only for a caller with a
 * claim on it. Null when there is none. 404 for a space that isn't published (unless the caller builds there).
 */
export async function appSpaceBeat(spaceId: string, userId: string | null, mayBuild?: MayBuild, now = new Date()): Promise<AppBeatCard | null> {
  const sceneId = await spaceSceneFor(spaceId, mayBuild)
  for (const b of await sceneBeats(sceneId, now, VISIBLE, BEAT_CLAIM_GRACE_MS)) {
    const claim = userId ? await myClaimRow(db, b.id, userId) : null
    const over = now.getTime() > b.endsAt.getTime() || b.status === 'ended'
    if (over && !claim) continue
    return toCard(b, claim, userId ? await collectingWallets(userId) : [])
  }
  return null
}

export interface AppTrack {
  userId: string
  /** The install's key id (App Attest): at most one claim per install per BEAT. */
  installKeyId: string
  consentVersion: unknown
  via: AppVia
  mayBuild?: MayBuild
  /** For an event BEAT with 0 minimum minutes, where tracking claims at once: the wallet chosen and the client's address, as at claim. */
  wallet?: unknown
  ip?: string | null
}

/** The code must be this BEAT's own ARC (any other code, or a BEAT without one, is a 400). */
async function requireBeatArc(beatId: string, code: string): Promise<void> {
  const ringId = parseRingCode(code)
  const [arc] = ringId === null ? [] : await db.select({ id: beatArcs.id }).from(beatArcs).where(and(eq(beatArcs.beatId, beatId), eq(beatArcs.ringId, ringId)))
  if (!arc) throw new BeatError(400, 'bad_request', "Scan this BEAT's ARC again.")
}

/**
 * Track my attendance in the app: the app's consent (BEAT_APP_CONSENT_VERSION), an account with a verified email or a
 * verified wallet, from the card's lead time until the end. A new claim has no wallet and remembers the install. The
 * account's claim from elsewhere (Decentraland, say) is reused: its time carries on and its source stays, and it takes
 * this install's key if it had none. Idempotent.
 */
export async function appTrack(beatId: string, t: AppTrack, now = new Date()): Promise<AppBeatCard> {
  let b: BeatRow
  let source: 'app_space' | 'app_event'
  if ('spaceId' in t.via) {
    b = await visibleBeat(beatId, await spaceSceneFor(t.via.spaceId, t.mayBuild))
    source = 'app_space'
  } else {
    b = await visibleBeat(beatId)
    source = 'app_event'
    if (isQuestKey(t.installKeyId)) throw phoneOnly()
    await requireBeatArc(b.id, t.via.arcCode)
  }
  if (t.consentVersion !== BEAT_APP_CONSENT_VERSION) throw new BeatError(400, 'bad_consent', 'Update the Virvi app to earn this BEAT.')
  const [u] = await db.select({ displayName: users.displayName, emailVerifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.id, t.userId))
  if (!u) throw notFound()
  if (!u.emailVerifiedAt && (await collectingWallets(t.userId)).length === 0) throw new BeatError(403, 'verify_first', 'Verify your email at virvi.io to earn BEATs.')
  if (now.getTime() > b.endsAt.getTime()) throw new BeatError(409, 'too_late', 'This BEAT has ended.')
  if (now.getTime() < b.startsAt.getTime() - BEAT_CARD_LEAD_MS) throw new BeatError(409, 'too_early', "This BEAT hasn't opened yet.")
  // Tracking at an event is the check-in: the phone has to be at the venue now (the location is used, not kept)
  if (!('spaceId' in t.via)) requireAtVenue(b, t.via.location, `You need to be at ${venueOf(b)} to check in.`)
  const name = u.displayName?.trim() ? cleanDisplayName(u.displayName, '') : null
  try {
    await db.transaction(async (tx) => {
      const keyTaken = async (exceptId?: string) => {
        const [other] = await tx.select({ id: beatClaims.id }).from(beatClaims)
          .where(and(eq(beatClaims.beatId, b.id), eq(beatClaims.installKeyId, t.installKeyId), ...(exceptId ? [ne(beatClaims.id, exceptId)] : [])))
        return !!other
      }
      let [mine] = await tx.select().from(beatClaims).where(and(eq(beatClaims.beatId, b.id), eq(beatClaims.userId, t.userId))).for('update')
      if (!mine) {
        if (await keyTaken()) throw thisDevice()
        await tx.insert(beatClaims).values({
          beatId: b.id, userId: t.userId, wallet: null, displayName: name, consentVersion: BEAT_APP_CONSENT_VERSION, consentedAt: now, lastSeenAt: now,
          createdAt: now, source, installKeyId: t.installKeyId, appConsentVersion: BEAT_APP_CONSENT_VERSION, appConsentedAt: now,
        }).onConflictDoNothing()
        ;[mine] = await tx.select().from(beatClaims).where(and(eq(beatClaims.beatId, b.id), eq(beatClaims.userId, t.userId))).for('update')
        if (!mine) throw thisDevice()
      }
      if (mine.deleteRequested) throw new BeatError(409, 'not_available', "You stopped tracking this BEAT, so you can't start again.")
      // The app's consent, on a claim started anywhere: its time is the first agreement to this version (a later Track
      // of the same version keeps it, so the card's check-in time stays put)
      if (mine.appConsentVersion !== BEAT_APP_CONSENT_VERSION || !mine.appConsentedAt) {
        await tx.update(beatClaims).set({ appConsentVersion: BEAT_APP_CONSENT_VERSION, appConsentedAt: now }).where(eq(beatClaims.id, mine.id))
      }
      if (!mine.installKeyId) {
        if (await keyTaken(mine.id)) throw thisDevice()
        await tx.update(beatClaims).set({ installKeyId: t.installKeyId }).where(eq(beatClaims.id, mine.id))
      }
      // A claim started elsewhere scanning the event ARC: its first scan is its check-in here, and from then its time
      // also counts by the wall clock (eventSeconds). A later scan keeps the first
      if (source === 'app_event' && mine.source !== 'app_event' && mine.status === 'present' && !mine.eventCheckedInAt) {
        await tx.update(beatClaims).set({ eventCheckedInAt: now, secondsAtEventScan: mine.secondsPresent ?? 0 })
          .where(and(eq(beatClaims.id, mine.id), isNull(beatClaims.eventCheckedInAt)))
      }
    })
  } catch (e) {
    throw uniqueRefusal(e)
  }
  // An event BEAT with no minimum minutes: the scan is the claim (once it has started; before, the claim waits for the start)
  if (!('spaceId' in t.via) && b.minPresentSeconds === 0 && now.getTime() >= b.startsAt.getTime()) {
    return appClaim(b.id, { userId: t.userId, installKeyId: t.installKeyId, wallet: t.wallet, location: t.via.location, ip: t.ip }, now)
  }
  return cardFor(b.id, t.userId)
}

/**
 * A check-in from an AR space: the time since the last (checkInDelta, capped), inside the BEAT's window, and only since
 * the account's app has been polling that space's feed (live.ts arLiveSince): none credits nothing (the check-in is
 * still accepted). A check-in too soon after the last changes nothing.
 */
export async function appCheckIn(beatId: string, c: { userId: string; spaceId: string; mayBuild?: MayBuild }, now = new Date()): Promise<AppBeatCard> {
  const sceneId = await spaceSceneFor(c.spaceId, c.mayBuild)
  const b = await visibleBeat(beatId, sceneId)
  const liveSince = await arLiveSince(c.spaceId, c.userId)
  await db.transaction(async (tx) => {
    const claim = await myClaimRow(tx, b.id, c.userId, true)
    if (!claim) throw notTracking()
    if (claim.status !== 'present') return
    const { accepted, addSeconds } = checkInDelta(claim.lastSeenAt, now)
    if (!accepted) return
    const live = liveSince === null ? 0 : Math.max(0, Math.min(addSeconds, Math.floor((now.getTime() - liveSince) / 1000)))
    const add = inWindowSeconds(b, now, live)
    await tx.update(beatClaims).set({ lastSeenAt: now, secondsPresent: sql`${beatClaims.secondsPresent} + ${add}` }).where(eq(beatClaims.id, claim.id))
  })
  return cardFor(b.id, c.userId)
}

/** The time rules of a claim: after the start, before the grace runs out, with enough time present. */
function checkClaimTime(b: BeatRow, claim: ClaimRow, now: Date): void {
  // A claim checked in at the event also counts the wall clock since that check-in (eventSeconds); any other has what it has
  // Tracking opens before the start, so with a minimum of 0 the time alone would allow it
  if (now.getTime() < b.startsAt.getTime()) throw new BeatError(409, 'not_started', "This event hasn't started yet.")
  if (now.getTime() > claimUntil(b).getTime()) throw new BeatError(409, 'too_late', 'The time to claim this BEAT is over.')
  if (eventSeconds(b, claim, now) < b.minPresentSeconds) throw new BeatError(409, 'not_yet', "You haven't been here long enough yet.")
}

export interface AppClaim {
  userId: string
  installKeyId: string
  /** The wallet chosen on the phone; needed only when the account has several. */
  wallet?: unknown
  location?: AppLocation
  /** The client's address (request.ip): only for a claim started in Decentraland, which keeps its network limits. */
  ip?: string | null
}

/**
 * Claim in the app: a present claim with enough time, from the start until the grace runs out, while the supply lasts
 * (counted under the BEAT row's lock, as claimBeat counts it). The wallet: the one given (it must be the account's),
 * else the claim's own (one started in Decentraland), else the account's only wallet that can collect BEATs; several
 * → 409 `choose_wallet` with them; none → the claim waits for one (`waiting`, holding its copy). A blocked wallet, or
 * one another claim of this BEAT holds, is refused. A claim started in the app has no per-network limits; one started
 * in Decentraland keeps them (BEAT_CLAIMS_PER_IP and the new-wallet limit, as claimBeat) and the Decentraland profile
 * check (when it has a wallet), and so does a claim with a
 * Quest's key (`quest:`, no App Attest behind it). An event BEAT refuses a Quest key (403 `phone_only`). A claim already further along
 * is returned as it is.
 */
export async function appClaim(beatId: string, c: AppClaim, now = new Date()): Promise<AppBeatCard> {
  const seen = await visibleBeat(beatId)
  const pre = await myClaimRow(db, seen.id, c.userId)
  if (!pre) throw notTracking()
  let wallet: string | null = null
  if (pre.status === 'present') {
    // Before asking which wallet: a claim that can't go yet says so first (checked again under the lock)
    checkClaimTime(seen, pre, now)
    if (pre.source === 'app_event' && (isQuestKey(c.installKeyId) || isQuestKey(pre.installKeyId))) throw phoneOnly()
    if (checkedInAtEvent(pre)) requireAtVenue(seen, c.location, `Come back to ${venueOf(seen)} to claim this BEAT.`)
    if ((await takenCount(db, seen.id)) >= seen.supplyCap) throw allClaimed()
    if (c.wallet !== undefined && c.wallet !== null) {
      const mine = typeof c.wallet === 'string' ? (await walletsOf(c.userId)).find((w) => w.toLowerCase() === (c.wallet as string).toLowerCase()) : undefined
      if (!mine) throw new BeatError(400, 'not_your_wallet', "That wallet isn't linked to your Virvi account.")
      wallet = mine.toLowerCase()
    } else if (pre.wallet) {
      wallet = pre.wallet
    } else {
      const usable = await collectingWallets(c.userId)
      if (usable.length > 1) throw new BeatError(409, 'choose_wallet', 'Choose the wallet to send this BEAT to.', { wallets: usable })
      wallet = usable[0]?.toLowerCase() ?? null
    }
    if (wallet && (await isWalletBlocked(wallet))) throw beatsBlocked()
    // A claim started in Decentraland (or from a Quest) keeps the in-world checks: the network limits under the lock
    // below, and the Decentraland profile check here, before it, as claimBeat runs it (a network call, never under the lock)
    const quest = isQuestKey(c.installKeyId) || isQuestKey(pre.installKeyId)
    if (wallet && (!pre.source.startsWith('app_') || quest) && !(await platformCheck('decentraland', wallet, now))) throw profileRequired()
  }
  try {
    await db.transaction(async (tx) => {
      const [b] = await tx.select().from(beats).where(eq(beats.id, seen.id)).for('update')
      if (!b || !VISIBLE.includes(b.status) || hidden(b)) throw notFound()
      const claim = await myClaimRow(tx, b.id, c.userId, true)
      if (!claim) throw notTracking()
      if (claim.status !== 'present') return
      checkClaimTime(b, claim, now)
      const quest = isQuestKey(c.installKeyId) || isQuestKey(claim.installKeyId)
      if (claim.source === 'app_event' && quest) throw phoneOnly()
      if (checkedInAtEvent(claim)) requireAtVenue(b, c.location, `Come back to ${venueOf(b)} to claim this BEAT.`)
      if ((await takenCount(tx, b.id)) >= b.supplyCap) throw allClaimed()
      if (wallet) {
        const [other] = await tx.select({ id: beatClaims.id }).from(beatClaims).where(and(eq(beatClaims.beatId, b.id), eq(beatClaims.wallet, wallet), ne(beatClaims.id, claim.id)))
        if (other) throw walletHasIt()
      }
      if (!claim.installKeyId) {
        const [other] = await tx.select({ id: beatClaims.id }).from(beatClaims).where(and(eq(beatClaims.beatId, b.id), eq(beatClaims.installKeyId, c.installKeyId)))
        if (other) throw thisDevice()
      }
      // A claim started in Decentraland keeps the in-world network limits wherever it is claimed (only app-started claims
      // skip them): the per-network cap here, and the new-wallet limit last, since it is kept in memory, not in this transaction
      // A Quest has no App Attest, so its claims are treated like in-world ones: they keep the network limits too
      if (!claim.source.startsWith('app_') || quest) {
        await chargeClaimNetwork(tx, b, c.ip)
        if (wallet) await checkNewWallet(c.ip, wallet, now)
      }
      // Stamped by the database's clock, as claimBeat and a host's Send are
      await tx.update(beatClaims).set({
        status: wallet ? 'claimed' : 'waiting', wallet, claimedAt: sql`clock_timestamp()`, secondsPresent: eventSeconds(b, claim, now), installKeyId: claim.installKeyId ?? c.installKeyId,
      }).where(and(eq(beatClaims.id, claim.id), eq(beatClaims.status, 'present')))
    })
  } catch (e) {
    throw uniqueRefusal(e)
  }
  return cardFor(seen.id, c.userId)
}

/** Stop tracking: deletes the account's present claim on the BEAT. Once claimed it stays (`already_claimed`). */
export async function appStopTracking(beatId: string, userId: string): Promise<void> {
  if (!UUID.test(beatId)) throw notFound()
  const gone = await db.delete(beatClaims)
    .where(and(eq(beatClaims.beatId, beatId), eq(beatClaims.userId, userId), eq(beatClaims.status, 'present'), eq(beatClaims.deleteRequested, false)))
    .returning({ id: beatClaims.id })
  if (gone.length) return
  if (await myClaimRow(db, beatId, userId)) throw new BeatError(409, 'already_claimed', "You've claimed this BEAT, so it can't be stopped.")
  throw notTracking()
}

/** The account's BEATs for the app's My BEATs: in progress, waiting for a wallet, and claimed to minted, newest first. */
export async function appMyBeats(userId: string): Promise<AppBeatCard[]> {
  const rows = await db.select({ c: beatClaims, b: beats }).from(beatClaims).innerJoin(beats, eq(beats.id, beatClaims.beatId))
    .where(and(eq(beatClaims.userId, userId), eq(beatClaims.deleteRequested, false), inArray(beatClaims.status, SHOWN)))
    .orderBy(desc(beatClaims.createdAt))
  const wallets = await collectingWallets(userId)
  const out: AppBeatCard[] = []
  for (const r of rows) if (!hidden(r.b)) out.push(await toCard(r.b, r.c, wallets))
  return out
}
