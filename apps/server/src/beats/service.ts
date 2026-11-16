import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from 'drizzle-orm'
import {
  BEAT_DESCRIPTION_MAX, BEAT_IMAGE_MIN_PX, BEAT_MIN_PRESENT_DEFAULT_MINUTES, BEAT_MIN_PRESENT_MAX_MINUTES, BEAT_NAME_MAX,
  BEAT_CLAIM_GRACE_MS, BEAT_SUPPLY_CAP_DEFAULT, BEAT_SUPPLY_CAP_MAX, beatTxUrl, type BeatChain, type PublicBeat,
} from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { beatClaims, beatMintBatches, beats, beatScenes, mediaAssets, orgMembers, scenes, users } from '../db/schema.js'
import type { Actor } from '../auth/actor.js'
import { getSceneAccess, hasScope } from '../auth/permissions.js'
import { BeatError } from './errors.js'
import { beatChainMissing } from './chain.js'
import { readImageSize } from './image.js'
import { lockBeat } from './lock.js'
import { beatQuote, copyBeatImage, refuseBelowCardMinimum, createBeatCheckout, createCapTopup, refundBeat, type BeatCheckoutResult, type BeatPayMethod, type BeatQuote } from './payments.js'

/**
 * BEATs (LIV-11), the host side: create, list, read, edit, claimants, cancel and end early. No Fastify here; the routes
 * pass in who is calling. Nothing here logs a wallet or a display name.
 */

export { BeatError } from './errors.js'
export type BeatRow = typeof beats.$inferSelect

/** Who is calling: their account, their scene access actor, and whether they are a Virvi admin (read from the database). */
export interface BeatCaller {
  userId: string; actor: Actor; admin: boolean
  /** A Decentraland scene pass's scene: the BEAT must include it, or it doesn't exist to this caller. */
  passSceneId?: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86_400_000
const SCENES_MAX = 20
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const IMAGE_MAX_BYTES = 10 * 1024 * 1024

const isAmoy = (chain: BeatChain) => chain === 'polygon-amoy'

// ── Access ───────────────────────────────────────────────────────────────────

const mayRun = async (c: BeatCaller, sceneId: string) => hasScope(await getSceneAccess(c.actor, sceneId), 'events.run')

async function mayRunAll(c: BeatCaller, sceneIds: string[]) {
  for (const id of sceneIds) if (!(await mayRun(c, id))) return false
  return true
}

async function mayRunAny(c: BeatCaller, sceneIds: string[]) {
  for (const id of sceneIds) if (await mayRun(c, id)) return true
  return false
}

/** Test BEATs (on Amoy) are for admins only once the server runs on mainnet. */
const hiddenFrom = (c: BeatCaller, chain: BeatChain) => !c.admin && config.beats.chain === 'polygon' && isAmoy(chain)

async function canSee(c: BeatCaller, row: BeatRow, sceneIds: string[]) {
  if (hiddenFrom(c, row.chain)) return false
  return c.admin || row.ownerUserId === c.userId || (await mayRunAny(c, sceneIds))
}

async function canManage(c: BeatCaller, row: BeatRow, sceneIds: string[]) {
  if (hiddenFrom(c, row.chain)) return false
  return c.admin || row.ownerUserId === c.userId || (await mayRunAll(c, sceneIds))
}

/** Test-only seams (never set in production). */
export const testHooks: { afterCancelRead?: (beatId: string) => Promise<void> } = {}

/** False while the server's chain lacks a contract or the minter key: the job could never put a BEAT on chain. */
const chainReady = () => beatChainMissing(config.beats.chain).length === 0

/**
 * BEATs that are switched on but whose chain isn't set up stay enabled (hosts still see their existing BEATs) with
 * `reason: 'not_configured'` and no create, so nobody pays: create, checkout and top-ups refuse then (requireChainReady).
 */
export function beatAvailability(admin: boolean) {
  const { chain, enabled } = config.beats
  const notConfigured = enabled && !chainReady()
  return {
    enabled, chain, test: isAmoy(chain), canCreate: enabled && !notConfigured && (!isAmoy(chain) || admin),
    reason: notConfigured ? 'not_configured' as const : null,
  }
}

/** Create, checkout and top-ups take money (or credit) for a chain, so they refuse while it isn't set up. */
function requireChainReady(): void {
  if (!chainReady()) throw new BeatError(503, 'not_configured', "BEATs aren't set up yet. Try again later.")
}

// ── Reading ──────────────────────────────────────────────────────────────────

async function sceneIdsOf(beatId: string): Promise<string[]> {
  const rows = await db.select({ sceneId: beatScenes.sceneId }).from(beatScenes).where(eq(beatScenes.beatId, beatId)).orderBy(asc(beatScenes.sceneId))
  return rows.map((r) => r.sceneId)
}

/** PublicBeat for each row: its scenes, claim counts by status, and its image (the frozen copy once paid). */
async function toPublic(rows: BeatRow[]): Promise<PublicBeat[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const sceneRows = await db.select().from(beatScenes).where(inArray(beatScenes.beatId, ids))
  const countRows = await db
    .select({ beatId: beatClaims.beatId, status: beatClaims.status, n: sql<number>`count(*)::int` })
    .from(beatClaims).where(inArray(beatClaims.beatId, ids)).groupBy(beatClaims.beatId, beatClaims.status)
  const mediaIds = rows.map((r) => r.imageMediaId).filter((v): v is string => !!v)
  const media = mediaIds.length
    ? await db.select({ id: mediaAssets.id, url: mediaAssets.publicUrl }).from(mediaAssets).where(inArray(mediaAssets.id, mediaIds))
    : []
  const urlOf = new Map(media.map((m) => [m.id, m.url]))
  // Claims waiting for a Send, per BEAT (fix round M-4)
  const now = new Date()
  const heldRows = await db.select({ beatId: beatClaims.beatId, n: sql<number>`count(*)::int` }).from(beatClaims)
    .innerJoin(beats, eq(beats.id, beatClaims.beatId))
    .where(and(inArray(beatClaims.beatId, ids), eq(beatClaims.status, 'claimed'), eq(beats.holdMints, true),
      sql`(${beats.mintsReleasedAt} is null or ${beatClaims.claimedAt} > ${beats.mintsReleasedAt})`))
    .groupBy(beatClaims.beatId)
  const held = new Map(heldRows.map((h) => [h.beatId, h.n]))
  return rows.map((r) => {
    const counts = { claimed: 0, minting: 0, minted: 0, failed: 0 }
    for (const c of countRows) if (c.beatId === r.id && c.status in counts) counts[c.status as keyof typeof counts] = c.n
    return {
      id: r.id,
      chain: r.chain,
      tokenId: r.tokenId === null ? null : String(r.tokenId),
      name: r.name,
      description: r.description,
      imageUrl: r.imageUrl ?? (r.imageMediaId ? urlOf.get(r.imageMediaId) ?? '' : ''),
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      minPresentSeconds: r.minPresentSeconds,
      supplyCap: r.supplyCap,
      tradeable: r.tradeable,
      status: r.status,
      sceneIds: sceneRows.filter((s) => s.beatId === r.id).map((s) => s.sceneId).sort(),
      counts,
      frozen: r.frozenAt !== null,
      test: isAmoy(r.chain),
      holdMints: r.holdMints,
      mintsReleasedAt: r.mintsReleasedAt?.toISOString() ?? null,
      mintsHeldUntil: holdActive(r, now) ? new Date(r.endsAt.getTime() + BEAT_CLAIM_GRACE_MS).toISOString() : null,
      heldClaims: holdActive(r, now) ? held.get(r.id) ?? 0 : 0,
      artStatus: r.imageUrl ? 'frozen' as const : r.artFailedAt ? 'failed' as const : 'pending' as const,
      scheduledEndsAt: r.scheduledEndsAt?.toISOString() ?? null,
    }
  })
}

const notFound = () => new BeatError(404, 'not_found', 'BEAT not found.')

/** The BEAT and its scenes for a caller who may see it; 404 otherwise (a BEAT nobody can see doesn't exist to them). */
async function loadVisible(c: BeatCaller, beatId: string) {
  if (!UUID.test(beatId)) throw notFound()
  const row = await db.query.beats.findFirst({ where: eq(beats.id, beatId) })
  if (!row) throw notFound()
  const sceneIds = await sceneIdsOf(row.id)
  if (c.passSceneId && !sceneIds.includes(c.passSceneId)) throw notFound()
  if (!(await canSee(c, row, sceneIds))) throw notFound()
  return { row, sceneIds }
}

async function loadManageable(c: BeatCaller, beatId: string) {
  const { row, sceneIds } = await loadVisible(c, beatId)
  if (!(await canManage(c, row, sceneIds))) throw new BeatError(403, 'forbidden', "You can't change this BEAT.")
  return { row, sceneIds }
}

export async function getBeat(c: BeatCaller, beatId: string): Promise<PublicBeat> {
  const { row } = await loadVisible(c, beatId)
  return (await toPublic([row]))[0]
}

/** The BEATs the caller created or may see through a scene, newest first. */
export async function listBeats(c: BeatCaller): Promise<PublicBeat[]> {
  const all = await db.select().from(beats).orderBy(desc(beats.startsAt))
  const visible: BeatRow[] = []
  const memo = new Map<string, boolean>()
  const runsScene = async (sceneId: string) => {
    if (!memo.has(sceneId)) memo.set(sceneId, await mayRun(c, sceneId))
    return memo.get(sceneId)!
  }
  const allScenes = all.length ? await db.select().from(beatScenes).where(inArray(beatScenes.beatId, all.map((r) => r.id))) : []
  for (const row of all) {
    if (hiddenFrom(c, row.chain)) continue
    if (c.admin || row.ownerUserId === c.userId) { visible.push(row); continue }
    for (const s of allScenes) {
      if (s.beatId === row.id && (await runsScene(s.sceneId))) { visible.push(row); break }
    }
  }
  return toPublic(visible)
}

/** The BEATs on one scene (the caller has already been checked for `events.run` there). */
export async function listSceneBeats(c: BeatCaller, sceneId: string): Promise<PublicBeat[]> {
  const rows = await db
    .select({ b: beats }).from(beats).innerJoin(beatScenes, eq(beatScenes.beatId, beats.id))
    .where(eq(beatScenes.sceneId, sceneId)).orderBy(desc(beats.startsAt))
  return toPublic(rows.map((r) => r.b).filter((b) => !hiddenFrom(c, b.chain)))
}

export interface Claimant {
  /** The claim's id, for removing it while mints are held (DELETE /api/beats/:id/claims/:claimId). */
  id: string
  wallet: string
  displayName: string | null
  status: string
  claimedAt: string | null
  mintedAt: string | null
  txUrl: string | null
}

export async function listClaimants(c: BeatCaller, beatId: string): Promise<Claimant[]> {
  const { row } = await loadVisible(c, beatId)
  // A claim its visitor asked to delete is gone to the host at once, though the job may still be settling it (privacy I2)
  // A removed claim whose visitor deleted their data is a wallet-only tombstone kept to keep that wallet out: not shown
  const claims = await db.select().from(beatClaims).where(and(
    eq(beatClaims.beatId, row.id), eq(beatClaims.deleteRequested, false),
    sql`not (${beatClaims.status} = 'removed' and ${beatClaims.userId} is null)`,
  ))
    .orderBy(desc(beatClaims.createdAt))
  return claims.map((k) => ({
    id: k.id,
    wallet: k.wallet,
    displayName: k.displayName,
    status: k.status,
    claimedAt: k.claimedAt?.toISOString() ?? null,
    mintedAt: k.mintedAt?.toISOString() ?? null,
    txUrl: k.mintTx ? beatTxUrl(row.chain, k.mintTx) : null,
  }))
}

// ── Validation ───────────────────────────────────────────────────────────────

type Body = Record<string, unknown>
const has = (b: Body, k: string) => b[k] !== undefined

function parseName(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || [...v.trim()].length > BEAT_NAME_MAX) throw new BeatError(400, 'bad_name', `Give the BEAT a name of 1 to ${BEAT_NAME_MAX} characters.`)
  return v.trim()
}

function parseDescription(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string' || [...v.trim()].length > BEAT_DESCRIPTION_MAX) throw new BeatError(400, 'bad_name', `The description can be up to ${BEAT_DESCRIPTION_MAX} characters.`)
  return v.trim()
}

function parseDate(v: unknown): Date {
  const d = typeof v === 'string' ? new Date(v) : null
  if (!d || Number.isNaN(d.getTime())) throw new BeatError(400, 'bad_window', 'Pick a start and an end time.')
  return d
}

function checkWindow(startsAt: Date, endsAt: Date, now: Date) {
  if (startsAt.getTime() <= now.getTime()) throw new BeatError(400, 'bad_window', 'The BEAT must start in the future.')
  if (endsAt.getTime() <= startsAt.getTime()) throw new BeatError(400, 'bad_window', 'The BEAT must end after it starts.')
  if (endsAt.getTime() - startsAt.getTime() > 31 * DAY_MS) throw new BeatError(400, 'bad_window', 'A BEAT can run for up to 31 days.')
}

function parseMinutes(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > BEAT_MIN_PRESENT_MAX_MINUTES) {
    throw new BeatError(400, 'bad_window', `Minimum time must be 0 to ${BEAT_MIN_PRESENT_MAX_MINUTES} minutes.`)
  }
  return v
}

function parseCap(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > BEAT_SUPPLY_CAP_MAX) {
    throw new BeatError(400, 'bad_cap', `Supply must be 1 to ${BEAT_SUPPLY_CAP_MAX}.`)
  }
  return v
}

function parseTradeable(v: unknown): boolean {
  if (v === undefined) return false
  if (typeof v !== 'boolean') throw new BeatError(400, 'bad_request', 'Tradeable must be true or false.')
  return v
}

function parseHold(v: unknown): boolean {
  if (v === undefined) return false
  if (typeof v !== 'boolean') throw new BeatError(400, 'bad_request', 'Hold for review must be true or false.')
  return v
}

function parseSceneIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > SCENES_MAX || !v.every((s) => typeof s === 'string' && UUID.test(s)) || new Set(v.map((s: string) => s.toLowerCase())).size !== v.length) {
    throw new BeatError(400, 'bad_scenes', `Pick 1 to ${SCENES_MAX} different scenes.`)
  }
  return (v as string[]).map((s) => s.toLowerCase())
}

/** The scenes must all be ones the caller may run events in; a missing scene reads the same as no access. */
async function requireRunAll(c: BeatCaller, sceneIds: string[]) {
  if (!(await mayRunAll(c, sceneIds))) throw new BeatError(403, 'forbidden', "You can't run events in every one of those scenes.")
}

/** A media item the caller can use (their own, or their organization's), of an image type, square and big enough. */
async function checkImage(c: BeatCaller, mediaId: unknown): Promise<string> {
  const bad = (m: string) => new BeatError(400, 'bad_image', m)
  if (typeof mediaId !== 'string' || !UUID.test(mediaId)) throw bad('Pick an image.')
  const orgs = (await db.select({ id: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, c.userId))).map((o) => o.id)
  const media = await db.query.mediaAssets.findFirst({
    where: and(eq(mediaAssets.id, mediaId), or(eq(mediaAssets.ownerId, c.userId), ...(orgs.length ? [inArray(mediaAssets.orgId, orgs)] : []))),
  })
  if (!media || media.status !== 'ready' || !media.publicUrl) throw bad('Pick an image from your library.')
  if (!IMAGE_TYPES.includes(media.contentType)) throw bad('The image must be a PNG, JPEG or WebP.')
  if (media.sizeBytes > IMAGE_MAX_BYTES) throw bad('The image file is too big (10 MB at most).')
  const size = await readImageSize(media.publicUrl)
  if (!size) throw bad("We couldn't read that image.")
  if (size.width !== size.height) throw bad('The image must be square.')
  if (size.width < BEAT_IMAGE_MIN_PX) throw bad(`The image must be at least ${BEAT_IMAGE_MIN_PX} by ${BEAT_IMAGE_MIN_PX} pixels.`)
  return media.id
}

type Tx = Pick<typeof db, 'select' | 'execute'>

/** One scene can't carry two live BEAT cards at once: no overlap with another non-cancelled BEAT. Touching windows are fine. */
async function checkOverlap(tx: Tx, sceneIds: string[], startsAt: Date, endsAt: Date, excludeId?: string) {
  const [hit] = await tx
    .select({ id: beats.id }).from(beats).innerJoin(beatScenes, eq(beatScenes.beatId, beats.id))
    .where(and(
      inArray(beatScenes.sceneId, sceneIds), ne(beats.status, 'cancelled'), lt(beats.startsAt, endsAt), gt(beats.endsAt, startsAt),
      ...(excludeId ? [ne(beats.id, excludeId)] : []),
    ))
    .limit(1)
  if (hit) throw new BeatError(409, 'overlap', 'Another BEAT is already running in one of those scenes at that time.')
}

/** Serializes writers on the same scenes so two overlapping BEATs can't both pass the overlap check. */
async function lockScenes(tx: Tx, sceneIds: string[]) {
  for (const id of [...sceneIds].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`beat-scene:${id}`}))`)
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createBeat(c: BeatCaller, body: Body, now = new Date()): Promise<PublicBeat> {
  const chain = config.beats.chain
  if (isAmoy(chain) && !c.admin) throw new BeatError(403, 'forbidden', "BEATs aren't open to everyone yet.")
  requireChainReady()
  const sceneIds = parseSceneIds(body.sceneIds)
  await requireRunAll(c, sceneIds)
  const name = parseName(body.name)
  const description = parseDescription(body.description)
  const startsAt = parseDate(body.startsAt)
  const endsAt = parseDate(body.endsAt)
  checkWindow(startsAt, endsAt, now)
  const minutes = has(body, 'minPresentMinutes') ? parseMinutes(body.minPresentMinutes) : BEAT_MIN_PRESENT_DEFAULT_MINUTES
  const supplyCap = has(body, 'supplyCap') ? parseCap(body.supplyCap) : BEAT_SUPPLY_CAP_DEFAULT
  const tradeable = parseTradeable(body.tradeable)
  const holdMints = parseHold(body.holdMints)
  const imageMediaId = await checkImage(c, body.imageMediaId)

  const row = await db.transaction(async (tx) => {
    await lockScenes(tx, sceneIds)
    await checkOverlap(tx, sceneIds, startsAt, endsAt)
    const [created] = await tx.insert(beats).values({
      chain, ownerUserId: c.userId, name, description, imageMediaId, startsAt, endsAt, minPresentSeconds: minutes * 60, supplyCap, tradeable, holdMints,
    }).returning()
    await tx.insert(beatScenes).values(sceneIds.map((sceneId) => ({ beatId: created.id, sceneId })))
    return created
  })
  return (await toPublic([row]))[0]
}

// ── Edit ─────────────────────────────────────────────────────────────────────

/** The database's clock, read inside a transaction (fix round M-1): every lock-holder judges time by the same clock, and
 * claims are stamped by it too (claimed_at), so a Send's cut-off compares one clock with itself. */
async function dbNow(tx: Pick<typeof db, 'execute'>): Promise<Date> {
  // clock_timestamp(), not now(): the moment of the call, not the transaction's start (fix round N-1)
  const rows = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`) as unknown as { now: string }[]
  return new Date(rows[0].now)
}

/** True once a create of the BEAT went to the chain, or may have: a batch sending, sent, confirmed or replaced. */
async function createOnChain(tx: Pick<typeof db, 'select'>, row: BeatRow): Promise<boolean> {
  if (row.createdOnChainTx) return true
  const [b] = await tx.select({ id: beatMintBatches.id }).from(beatMintBatches).where(and(
    eq(beatMintBatches.beatId, row.id), eq(beatMintBatches.kind, 'create'),
    sql`(${beatMintBatches.status} in ('sending', 'sent', 'confirmed') or (${beatMintBatches.status} = 'failed' and ${beatMintBatches.lastError} = 'replaced'))`,
  )).limit(1)
  return !!b
}

/** What an edit may change: 'all' (a draft), 'paid' (paid, before go-live: all but the cap), 'image' (started but not on
 * chain yet: only the art, to fix one that failed) or 'none'. Judged on the locked row by the database's clock. */
type EditScope = 'all' | 'paid' | 'image' | 'none'
async function editScope(tx: Pick<typeof db, 'select'>, row: BeatRow, now: Date): Promise<EditScope> {
  if (row.status === 'draft') return 'all'
  if (row.status === 'cancelled' || (await createOnChain(tx, row))) return 'none'
  const started = row.startsAt.getTime() <= now.getTime() || row.status === 'live' || row.status === 'ended'
  if (row.status === 'paid' && !started && row.frozenAt === null) return 'paid'
  if (started && row.frozenAt === null) return 'image'
  return 'none'
}

/**
 * Before payment anything changes. After payment and before the start (go-live), the name, description, image,
 * tradeable, hold for review, window, scenes and minimum time change; the cap can't (a cap raise is a top-up). From
 * go-live everything is locked (409 `locked`), since the BEAT then goes on chain with its tradeable flag: except the
 * image, while the BEAT isn't on chain yet, so a host can replace art that couldn't be frozen (fix round I-3). Once a
 * create batch exists, or the BEAT is on chain (the old flow created it at payment), nothing changes (M-1, M-2). All
 * of this is judged under the BEAT's lock, by the database's clock. A new image is frozen at once after the commit.
 */
export async function updateBeat(c: BeatCaller, beatId: string, body: Body, now?: Date): Promise<PublicBeat> {
  const { row: seen } = await loadManageable(c, beatId)
  const locked = (m = "This BEAT can't be changed any more.") => new BeatError(409, 'locked', m)
  if (seen.status === 'cancelled') throw locked()
  void now

  const newScenes = has(body, 'sceneIds') ? parseSceneIds(body.sceneIds) : null
  if (newScenes) await requireRunAll(c, newScenes)

  // Read outside the transaction: it fetches the file, and must not hold the row lock meanwhile
  const imageChanged = has(body, 'imageMediaId') && body.imageMediaId !== seen.imageMediaId
  const newImage = imageChanged ? await checkImage(c, body.imageMediaId) : null

  const result = await db.transaction(async (tx) => {
    await lockBeat(tx, beatId)
    const [row] = await tx.select().from(beats).where(eq(beats.id, beatId)).for('update')
    if (!row) throw notFound()
    const t = await dbNow(tx)
    const scope = await editScope(tx, row, t)
    if (scope === 'none') throw locked()
    if (scope === 'image') {
      // A form sent whole is fine: only a field whose value differs counts as a change
      const iso = (d: Date) => d.toISOString()
      const same: Record<string, (v: unknown) => boolean> = {
        name: (v) => v === row.name, description: (v) => (v ?? '') === row.description, tradeable: (v) => v === row.tradeable,
        holdMints: (v) => v === row.holdMints, supplyCap: (v) => v === row.supplyCap, minPresentMinutes: (v) => v === row.minPresentSeconds / 60,
        startsAt: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && iso(new Date(v)) === iso(row.startsAt),
        endsAt: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && iso(new Date(v)) === iso(row.endsAt),
      }
      const stored = (await tx.select({ sceneId: beatScenes.sceneId }).from(beatScenes).where(eq(beatScenes.beatId, row.id))).map((r) => r.sceneId).sort()
      same.sceneIds = () => !newScenes || JSON.stringify([...newScenes].sort()) === JSON.stringify(stored)
      const others = Object.keys(body).filter((k) => body[k] !== undefined && k !== 'imageMediaId' && !(same[k]?.(body[k]) ?? false))
      if (others.length) throw locked('This BEAT has started: only its image can still change, until it is on chain.')
      if (!newImage || newImage === row.imageMediaId) return row
      const [updated] = await tx.update(beats).set({
        imageMediaId: newImage, imageUrl: null, artFailedAt: null, artAttempts: 0, artNextAttemptAt: null, updatedAt: t,
      }).where(eq(beats.id, row.id)).returning()
      return updated
    }
    const paid = scope === 'paid'
    const name = has(body, 'name') ? parseName(body.name) : row.name
    const description = has(body, 'description') ? parseDescription(body.description) : row.description
    const startsAt = has(body, 'startsAt') ? parseDate(body.startsAt) : row.startsAt
    const endsAt = has(body, 'endsAt') ? parseDate(body.endsAt) : row.endsAt
    checkWindow(startsAt, endsAt, t)
    const minutes = has(body, 'minPresentMinutes') ? parseMinutes(body.minPresentMinutes) : row.minPresentSeconds / 60
    const supplyCap = has(body, 'supplyCap') ? parseCap(body.supplyCap) : row.supplyCap
    const tradeable = has(body, 'tradeable') ? parseTradeable(body.tradeable) : row.tradeable
    const holdMints = has(body, 'holdMints') ? parseHold(body.holdMints) : row.holdMints
    if (paid && supplyCap !== row.supplyCap) throw locked('The supply is paid for. Add more supply instead.')
    const imageMediaId = newImage ?? row.imageMediaId
    // The BEAT's scenes as they are now, read after the lock (another edit may have moved them since loadManageable)
    const sceneIds = newScenes ?? (await tx.select({ sceneId: beatScenes.sceneId }).from(beatScenes).where(eq(beatScenes.beatId, row.id))).map((r) => r.sceneId)
    await lockScenes(tx, sceneIds)
    await checkOverlap(tx, sceneIds, startsAt, endsAt, row.id)
    const [updated] = await tx.update(beats).set({
      name, description, imageMediaId, startsAt, endsAt, minPresentSeconds: Math.round(minutes * 60), supplyCap, tradeable, holdMints, updatedAt: t,
      // A stale copy (of the old image) never stands for the new one; it is frozen again right after the commit
      ...(imageChanged ? { imageUrl: null, artFailedAt: null, artAttempts: 0, artNextAttemptAt: null } : {}),
    }).where(eq(beats.id, row.id)).returning()
    if (newScenes) {
      await tx.delete(beatScenes).where(eq(beatScenes.beatId, row.id))
      await tx.insert(beatScenes).values(newScenes.map((sceneId) => ({ beatId: row.id, sceneId })))
    }
    return updated
  })
  // A paid (or started) BEAT freezes its new art now (fix round I-3); copyBeatImage records a failure for the host to see
  if (imageChanged && result.status !== 'draft' && result.tokenId !== null && result.imageUrl === null) {
    await copyBeatImage(result.id).catch(() => {})
  }
  return getBeatRow(result.id)
}

async function getBeatRow(beatId: string): Promise<PublicBeat> {
  const row = await db.query.beats.findFirst({ where: eq(beats.id, beatId) })
  return (await toPublic([row!]))[0]
}

// ── Cancel and end early ─────────────────────────────────────────────────────

/**
 * Cancels before the start: a draft just becomes cancelled; a paid BEAT is refunded first, and marked cancelled only after
 * the refund returns. The state is read again under the lock, so a draft that was paid meanwhile is refunded. Cancelling
 * an already cancelled BEAT changes nothing (200). Task 6's refundBeat must be idempotent per BEAT: a crash between the
 * refund and the status update leaves the BEAT paid, and a retry calls it again.
 *
 * Task 6 notes: the advisory lock `beat:<id>` (lockBeat) only orders the writers that take it. Payment confirmation and the
 * paid -> live transition must take it too. refundBeat should be short: this transaction stays open around it, and it may
 * itself set `cancelled` (the final update then finds nothing to change and accepts that). copyBeatImage must write
 * image_url only if image_media_id still equals the image it copied. The update below is guarded on the status read here,
 * so a confirmation that slips in anyway gives 409 `conflict`, never a cancel without its refund.
 */
export async function cancelBeat(c: BeatCaller, beatId: string, now = new Date()): Promise<PublicBeat> {
  const { row: seen } = await loadManageable(c, beatId)
  await db.transaction(async (tx) => {
    await lockBeat(tx, beatId)
    const [row] = await tx.select().from(beats).where(eq(beats.id, beatId))
    if (!row) throw notFound()
    if (row.status === 'cancelled') return
    const late = () => new BeatError(409, 'too_late', "This BEAT has started, so it can't be cancelled. End it early instead.")
    if (row.status === 'ended' || row.status === 'live') {
      // It moved on since we looked: say so rather than guess
      if (row.status !== seen.status) throw new BeatError(409, 'conflict', 'This BEAT just changed. Reload and try again.')
      throw row.status === 'live' ? late() : new BeatError(409, 'locked', 'This BEAT is already over.')
    }
    if (row.startsAt.getTime() <= now.getTime()) throw late()
    if (row.status === 'paid') await refundBeat(row.id, now)
    await testHooks.afterCancelRead?.(row.id)
    // Only from the status we read: a payment confirmation (no lock of ours) may have turned a draft paid since, and
    // must not be cancelled without its refund
    const done = await tx.update(beats).set({ status: 'cancelled', updatedAt: now }).where(and(eq(beats.id, row.id), eq(beats.status, row.status))).returning({ id: beats.id })
    if (!done.length) {
      const [now2] = await tx.select({ status: beats.status }).from(beats).where(eq(beats.id, beatId))
      if (now2?.status !== 'cancelled') throw new BeatError(409, 'conflict', 'This BEAT just changed. Reload and try again.')
    }
    // Nobody can claim a cancelled BEAT, so what tracking stored goes with it (privacy I4)
    await tx.delete(beatClaims).where(and(eq(beatClaims.beatId, beatId), eq(beatClaims.status, 'present')))
  })
  return getBeatRow(beatId)
}

/** Ends a live BEAT now. ends_at becomes now; the scheduled end is kept for the token metadata (standards M7). */
export async function endBeatEarly(c: BeatCaller, beatId: string, now = new Date()): Promise<PublicBeat> {
  const { row } = await loadManageable(c, beatId)
  const [ended] = await db.update(beats).set({ status: 'ended', endsAt: now, scheduledEndsAt: sql`coalesce(${beats.scheduledEndsAt}, ${beats.endsAt})`, updatedAt: now })
    .where(and(eq(beats.id, row.id), eq(beats.status, 'live'))).returning({ id: beats.id })
  if (!ended) throw new BeatError(409, 'not_live', "This BEAT isn't running right now.")
  return getBeatRow(row.id)
}

// ── Host review (hold mints) ─────────────────────────────────────────────────

/** True while the BEAT holds claims for the host's review: hold is on and the claim grace after its end hasn't run out. */
export function holdActive(r: Pick<BeatRow, 'holdMints' | 'endsAt'>, now: Date): boolean {
  return r.holdMints && r.endsAt.getTime() + BEAT_CLAIM_GRACE_MS > now.getTime()
}

/** True while this claim waits for a Send (fix round M-4): hold is active and it was claimed after the last Send (or no
 * Send yet). A Send covers only the claims made up to it. */
export function claimHeld(r: Pick<BeatRow, 'holdMints' | 'endsAt' | 'mintsReleasedAt'>, claimedAt: Date | null, now: Date): boolean {
  if (!holdActive(r, now)) return false
  return !r.mintsReleasedAt || !claimedAt || claimedAt.getTime() > r.mintsReleasedAt.getTime()
}

/**
 * The host's Send: the claims made so far go to the minting job; any made later wait for another Send (or the end of the
 * claim grace). Judged under the BEAT's lock, by the database's clock. 409 `not_live` before the start, `not_held`
 * when hold is off or its grace is over.
 */
export async function releaseBeatMints(c: BeatCaller, beatId: string): Promise<PublicBeat> {
  await loadManageable(c, beatId)
  await db.transaction(async (tx) => {
    await lockBeat(tx, beatId)
    const [row] = await tx.select().from(beats).where(eq(beats.id, beatId)).for('update')
    if (!row) throw notFound()
    const t = await dbNow(tx)
    if (row.status !== 'live' && row.status !== 'ended') throw new BeatError(409, 'not_live', "This BEAT hasn't started, so there's nothing to send yet.")
    if (!holdActive(row, t)) throw new BeatError(409, 'not_held', "This BEAT's claims aren't being held.")
    await tx.update(beats).set({ mintsReleasedAt: t, updatedAt: t }).where(eq(beats.id, beatId))
  })
  return getBeatRow(beatId)
}

/**
 * The host takes a held claim out before it is sent: it becomes `removed` (never minted, can't be claimed again by that
 * wallet) and frees its supply. Only a `claimed` claim still waiting for a Send, under the BEAT's lock, by the
 * database's clock. 404 for a claim not on this BEAT; 409 `not_held` for one already sent (or hold off or over),
 * `not_removable` for one in any other state, or that the job took meanwhile.
 */
export async function removeBeatClaim(c: BeatCaller, beatId: string, claimId: string): Promise<{ removed: true }> {
  await loadManageable(c, beatId)
  if (!UUID.test(claimId)) throw new BeatError(404, 'not_found', 'Claim not found.')
  await db.transaction(async (tx) => {
    await lockBeat(tx, beatId)
    const [row] = await tx.select().from(beats).where(eq(beats.id, beatId)).for('update')
    if (!row) throw notFound()
    const t = await dbNow(tx)
    const [claim] = await tx.select().from(beatClaims).where(and(eq(beatClaims.id, claimId), eq(beatClaims.beatId, beatId), eq(beatClaims.deleteRequested, false)))
    if (!claim) throw new BeatError(404, 'not_found', 'Claim not found.')
    if (!claimHeld(row, claim.claimedAt, t)) throw new BeatError(409, 'not_held', "This claim is already being sent, so it can't be removed.")
    const notRemovable = () => new BeatError(409, 'not_removable', 'Only a claim that is waiting to be sent can be removed.')
    if (claim.status !== 'claimed') throw notRemovable()
    const done = await tx.update(beatClaims).set({ status: 'removed' })
      .where(and(eq(beatClaims.id, claimId), eq(beatClaims.status, 'claimed'))).returning({ id: beatClaims.id })
    if (!done.length) throw notRemovable()
  })
  return { removed: true }
}

// ── Payments ─────────────────────────────────────────────────────────────────

/**
 * What a supply costs: a draft's at `cap` (its own supply when omitted), or a paid BEAT's raise to `cap`. Unless `method`
 * is 'credit', a price a card can't pay (under Stripe's minimum) is refused as `below_minimum` with the smallest supply.
 */
export async function quoteBeat(c: BeatCaller, beatId: string, capRaw: unknown, methodRaw?: unknown): Promise<BeatQuote> {
  const { row } = await loadManageable(c, beatId)
  const cap = capRaw === undefined || capRaw === '' ? row.supplyCap : parseCap(typeof capRaw === 'string' && /^\d+$/.test(capRaw) ? Number(capRaw) : NaN)
  if (row.status === 'paid' || row.status === 'live') {
    if (cap <= row.supplyCap) throw new BeatError(400, 'bad_cap', `The new supply must be more than ${row.supplyCap}.`)
  } else if (row.status !== 'draft') {
    throw new BeatError(409, 'locked', "This BEAT can't be changed any more.")
  }
  const method = methodRaw === undefined || methodRaw === '' ? 'card' : parseMethod(methodRaw)
  const q = beatQuote(row, cap)
  if (method === 'card') refuseBelowCardMinimum(row, q)
  return q
}

function parseMethod(v: unknown): BeatPayMethod {
  if (v === undefined) return 'card'
  if (v !== 'card' && v !== 'credit') throw new BeatError(400, 'bad_request', 'Pay by card or with credit.')
  return v
}

async function payerOf(c: BeatCaller) {
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, c.userId))
  return { id: c.userId, email: u?.email ?? null, admin: c.admin }
}

/** Pays for a draft BEAT: a Stripe Checkout URL for card, or paid at once by credit (or free, on Amoy). */
export async function checkoutBeat(c: BeatCaller, beatId: string, body: Body, now = new Date()): Promise<BeatCheckoutResult> {
  const { row } = await loadManageable(c, beatId)
  requireChainReady()
  return createBeatCheckout(row, await payerOf(c), parseMethod(body.method), now)
}

/** Raises a paid or live BEAT's supply before its end; the cap changes once the top-up is paid. */
export async function raiseBeatCap(c: BeatCaller, beatId: string, body: Body, now = new Date()): Promise<BeatCheckoutResult> {
  const { row } = await loadManageable(c, beatId)
  requireChainReady()
  const method = parseMethod(body.method)
  return createCapTopup(row, await payerOf(c), parseCap(body.supplyCap), method, now)
}

/** True when the scene exists and isn't deleted (the scene page section answers 404 otherwise). */
export async function sceneExists(sceneId: string): Promise<boolean> {
  if (!UUID.test(sceneId)) return false
  const s = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { id: true, deletedAt: true } })
  return !!s && !s.deletedAt
}

export { mayRun as mayRunBeatsIn }
