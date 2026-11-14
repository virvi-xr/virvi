import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from 'drizzle-orm'
import {
  BEAT_DESCRIPTION_MAX, BEAT_IMAGE_MIN_PX, BEAT_MIN_PRESENT_DEFAULT_MINUTES, BEAT_MIN_PRESENT_MAX_MINUTES, BEAT_NAME_MAX,
  BEAT_SUPPLY_CAP_DEFAULT, BEAT_SUPPLY_CAP_MAX, beatTxUrl, type BeatChain, type PublicBeat,
} from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { beatClaims, beats, beatScenes, mediaAssets, orgMembers, scenes } from '../db/schema.js'
import type { Actor } from '../auth/actor.js'
import { getSceneAccess, hasScope } from '../auth/permissions.js'
import { BeatError } from './errors.js'
import { readImageSize } from './image.js'
import { copyBeatImage, refundBeat } from './payments.js'

/**
 * BEATs (LIV-11), the host side: create, list, read, edit, claimants, cancel and end early. No Fastify here; the routes
 * pass in who is calling. Nothing here logs a wallet or a display name.
 */

export { BeatError } from './errors.js'
export type BeatRow = typeof beats.$inferSelect

/** Who is calling: their account, their scene access actor, and whether they are a Virvi admin (read from the database). */
export interface BeatCaller { userId: string; actor: Actor; admin: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86_400_000
const SCENES_MAX = 20
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

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

export function beatAvailability(admin: boolean) {
  const { enabled, chain } = config.beats
  return { enabled, chain, test: isAmoy(chain), canCreate: enabled && (!isAmoy(chain) || admin) }
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
  wallet: string
  displayName: string | null
  status: string
  claimedAt: string | null
  mintedAt: string | null
  txUrl: string | null
}

export async function listClaimants(c: BeatCaller, beatId: string): Promise<Claimant[]> {
  const { row } = await loadVisible(c, beatId)
  const claims = await db.select().from(beatClaims).where(eq(beatClaims.beatId, row.id)).orderBy(desc(beatClaims.createdAt))
  return claims.map((k) => ({
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
  if (typeof v !== 'string' || !v.trim() || v.trim().length > BEAT_NAME_MAX) throw new BeatError(400, 'bad_name', `Give the BEAT a name of 1 to ${BEAT_NAME_MAX} characters.`)
  return v.trim()
}

function parseDescription(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string' || v.trim().length > BEAT_DESCRIPTION_MAX) throw new BeatError(400, 'bad_name', `The description can be up to ${BEAT_DESCRIPTION_MAX} characters.`)
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
  const imageMediaId = await checkImage(c, body.imageMediaId)

  const row = await db.transaction(async (tx) => {
    await lockScenes(tx, sceneIds)
    await checkOverlap(tx, sceneIds, startsAt, endsAt)
    const [created] = await tx.insert(beats).values({
      chain, ownerUserId: c.userId, name, description, imageMediaId, startsAt, endsAt, minPresentSeconds: minutes * 60, supplyCap, tradeable,
    }).returning()
    await tx.insert(beatScenes).values(sceneIds.map((sceneId) => ({ beatId: created.id, sceneId })))
    return created
  })
  return (await toPublic([row]))[0]
}

// ── Edit ─────────────────────────────────────────────────────────────────────

/**
 * Before payment anything changes. After payment and before the start, with nothing frozen, the name, description,
 * image, window, scenes and minimum time change; the cap and tradeable can't (a cap raise is a top-up). Otherwise locked.
 */
export async function updateBeat(c: BeatCaller, beatId: string, body: Body, now = new Date()): Promise<PublicBeat> {
  const { row: seen, sceneIds: seenScenes } = await loadManageable(c, beatId)
  const locked = (m = "This BEAT can't be changed any more.") => new BeatError(409, 'locked', m)
  const editable = (r: BeatRow) => r.status === 'draft' || (r.status === 'paid' && r.startsAt.getTime() > now.getTime() && r.frozenAt === null)
  if (!editable(seen)) throw locked()

  const newScenes = has(body, 'sceneIds') ? parseSceneIds(body.sceneIds) : null
  if (newScenes) await requireRunAll(c, newScenes)

  // Read outside the transaction: it fetches the file, and must not hold the row lock meanwhile
  const imageChanged = has(body, 'imageMediaId') && body.imageMediaId !== seen.imageMediaId
  const newImage = imageChanged ? await checkImage(c, body.imageMediaId) : null

  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(beats).where(eq(beats.id, beatId)).for('update')
    if (!row || !editable(row)) throw locked()
    const paid = row.status === 'paid'
    const name = has(body, 'name') ? parseName(body.name) : row.name
    const description = has(body, 'description') ? parseDescription(body.description) : row.description
    const startsAt = has(body, 'startsAt') ? parseDate(body.startsAt) : row.startsAt
    const endsAt = has(body, 'endsAt') ? parseDate(body.endsAt) : row.endsAt
    checkWindow(startsAt, endsAt, now)
    const minutes = has(body, 'minPresentMinutes') ? parseMinutes(body.minPresentMinutes) : row.minPresentSeconds / 60
    const supplyCap = has(body, 'supplyCap') ? parseCap(body.supplyCap) : row.supplyCap
    const tradeable = has(body, 'tradeable') ? parseTradeable(body.tradeable) : row.tradeable
    if (paid && supplyCap !== row.supplyCap) throw locked('The supply is paid for. Add more supply instead.')
    if (paid && tradeable !== row.tradeable) throw locked("Whether it can be traded can't change after payment.")
    const imageMediaId = newImage ?? row.imageMediaId
    const sceneIds = newScenes ?? seenScenes
    await lockScenes(tx, sceneIds)
    await checkOverlap(tx, sceneIds, startsAt, endsAt, row.id)
    const [updated] = await tx.update(beats).set({
      name, description, imageMediaId, startsAt, endsAt, minPresentSeconds: Math.round(minutes * 60), supplyCap, tradeable, updatedAt: now,
    }).where(eq(beats.id, row.id)).returning()
    if (newScenes) {
      await tx.delete(beatScenes).where(eq(beatScenes.beatId, row.id))
      await tx.insert(beatScenes).values(newScenes.map((sceneId) => ({ beatId: row.id, sceneId })))
    }
    return { updated, copyImage: paid && imageChanged }
  })
  if (result.copyImage) await copyBeatImage(result.updated.id)
  return getBeatRow(result.updated.id)
}

async function getBeatRow(beatId: string): Promise<PublicBeat> {
  const row = await db.query.beats.findFirst({ where: eq(beats.id, beatId) })
  return (await toPublic([row!]))[0]
}

// ── Cancel and end early ─────────────────────────────────────────────────────

/** Cancels before the start: a draft just becomes cancelled; a paid BEAT is refunded first. After the start it's too late. */
export async function cancelBeat(c: BeatCaller, beatId: string, now = new Date()): Promise<PublicBeat> {
  const { row } = await loadManageable(c, beatId)
  if (row.status === 'cancelled' || row.status === 'ended') throw new BeatError(409, 'locked', 'This BEAT is already over.')
  if (row.status === 'live' || row.startsAt.getTime() <= now.getTime()) throw new BeatError(409, 'too_late', "This BEAT has started, so it can't be cancelled. End it early instead.")
  if (row.status === 'paid') await refundBeat(row.id, now)
  await db.update(beats).set({ status: 'cancelled', updatedAt: now })
    .where(and(eq(beats.id, row.id), inArray(beats.status, ['draft', 'paid', 'cancelled'])))
  return getBeatRow(row.id)
}

/** Ends a live BEAT now. */
export async function endBeatEarly(c: BeatCaller, beatId: string, now = new Date()): Promise<PublicBeat> {
  const { row } = await loadManageable(c, beatId)
  const [ended] = await db.update(beats).set({ status: 'ended', endsAt: now, updatedAt: now })
    .where(and(eq(beats.id, row.id), eq(beats.status, 'live'))).returning({ id: beats.id })
  if (!ended) throw new BeatError(409, 'not_live', "This BEAT isn't running right now.")
  return getBeatRow(row.id)
}

/** True when the scene exists and isn't deleted (the scene page section answers 404 otherwise). */
export async function sceneExists(sceneId: string): Promise<boolean> {
  if (!UUID.test(sceneId)) return false
  const s = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { id: true, deletedAt: true } })
  return !!s && !s.deletedAt
}

export { mayRun as mayRunBeatsIn }
