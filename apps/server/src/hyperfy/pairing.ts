import type { FastifyInstance } from 'fastify'
import { randomInt } from 'node:crypto'
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { HYPERFY_PAIRING, type HyperfyPairingSummary, type HyperfyVouchLinked, type PairClaimResponse, type PairRenewResponse } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { hyperfyPairings, hyperfyWorlds, scenes, users } from '../db/schema.js'
import { getSceneAccess, type SceneAccess } from '../auth/permissions.js'
import type { Actor } from '../auth/actor.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { issueHyperfyPass } from '../auth/scene-pass.js'
import { sameHash, sha256 } from '../auth/hash.js'
import { findWorldByKey, type HyperfyWorldRow } from './worlds.js'

/**
 * Pairing a Hyperfy player to a Virvi user: the HUD gets a short code, the user approves it on virvi.io, and the HUD
 * trades the code (plus the secret only it knows) for a short-lived scene pass. Codes and secrets are credentials:
 * only their sha256 is stored and they are never logged.
 */

function newCode(): string {
  let code = ''
  for (let i = 0; i < HYPERFY_PAIRING.codeLength; i++) code += HYPERFY_PAIRING.codeAlphabet[randomInt(HYPERFY_PAIRING.codeAlphabet.length)]
  return code
}

/** Who may edit the scene: owner, admin, cohost, editor, or a booking host/cohost during their booking. Narrower grant roles (vj, lighting, ...) cannot. */
function mayEdit(a: SceneAccess): boolean {
  if (a.level === 'admin' || a.level === 'owner' || a.level === 'cohost' || a.level === 'editor') return true
  return a.level === 'grant' && (a.booking?.role === 'host' || a.booking?.role === 'cohost')
}

type PairingRow = typeof hyperfyPairings.$inferSelect

const isHosted = (p: Pick<PairingRow, 'hyperfyPlayerId'>) => p.hyperfyPlayerId !== null

function activeAt(p: PairingRow, now: Date): boolean {
  if (p.status !== 'claimed') return false
  if (isHosted(p)) return (p.lastUsedAt ?? p.createdAt).getTime() + HYPERFY_PAIRING.hostedIdleTtlMs > now.getTime()
  return !!p.expiresAt && p.expiresAt.getTime() > now.getTime()
}

/**
 * Starts a pairing for the world that owns this key. `hyperfyPlayerId` is only for the vouch path (a hosted world
 * speaking for its player); never pass a value that came from a browser. A hosted pairing has no browser secret (`secretHash` null).
 */
export async function startPairing(worldKey: string, secretHash: string | null, playerName: string | null, hyperfyPlayerId: string | null, now = new Date()): Promise<{ code: string; expiresAt: Date }> {
  // Self pairing = browser secret, no player id; hosted pairing = vouched player id, no secret. Exactly one.
  if ((hyperfyPlayerId === null) !== (secretHash !== null)) throw new Error('invalid_pairing_kind')
  const world = await findWorldByKey(worldKey)
  if (!world) throw new Error('invalid_world_key')
  return insertPending(world.id, secretHash, playerName, hyperfyPlayerId, now)
}

async function insertPending(worldId: string, secretHash: string | null, playerName: string | null, hyperfyPlayerId: string | null, now: Date): Promise<{ code: string; expiresAt: Date; pairingId: string }> {
  const expiresAt = new Date(now.getTime() + HYPERFY_PAIRING.codeTtlMs)
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode()
    try {
      const [row] = await db.insert(hyperfyPairings).values({ worldId, codeHash: sha256(code), secretHash, hyperfyPlayerId, playerName, status: 'pending', codeExpiresAt: expiresAt, createdAt: now }).returning({ id: hyperfyPairings.id })
      return { code, expiresAt, pairingId: row.id }
    } catch (err) {
      // A live code collided with this one (unique code_hash): draw another.
      if (attempt === 4 || !/unique|duplicate/i.test(String((err as { message?: string }).message) + String((err as { cause?: { message?: string } }).cause?.message))) throw err
    }
  }
  throw new Error('unreachable')
}

async function pendingByCode(code: string) {
  const [row] = await db
    .select({ p: hyperfyPairings, worldName: hyperfyWorlds.name, sceneId: hyperfyWorlds.sceneId, sceneName: scenes.name })
    .from(hyperfyPairings)
    .innerJoin(hyperfyWorlds, eq(hyperfyPairings.worldId, hyperfyWorlds.id))
    .innerJoin(scenes, eq(hyperfyWorlds.sceneId, scenes.id))
    .where(eq(hyperfyPairings.codeHash, sha256(code)))
  return row ?? null
}

/** What the approval page shows for a code, or null when the code is unknown, used up or expired. */
export async function pairingForApproval(code: string, now = new Date()) {
  const row = await pendingByCode(code)
  if (!row || row.p.status !== 'pending' || row.p.codeExpiresAt <= now) return null
  return { pairingId: row.p.id, worldName: row.worldName, sceneId: row.sceneId, sceneName: row.sceneName, playerName: row.p.playerName }
}

export async function approvePairing(code: string, actor: Actor, now = new Date()): Promise<'approved' | 'no_access' | 'expired'> {
  const row = await pendingByCode(code)
  if (!row || row.p.status !== 'pending' || row.p.codeExpiresAt <= now) return 'expired'
  const allowed = !!actor.userId && mayEdit(await getSceneAccess(actor, row.sceneId, now))
  // Only one request can move a pending, live code on.
  const [moved] = await db
    .update(hyperfyPairings)
    .set(allowed ? { status: 'approved', userId: actor.userId } : { status: 'refused' })
    .where(and(eq(hyperfyPairings.id, row.p.id), eq(hyperfyPairings.status, 'pending'), gt(hyperfyPairings.codeExpiresAt, now)))
    .returning({ id: hyperfyPairings.id })
  if (!moved) return 'expired'
  return allowed ? 'approved' : 'no_access'
}

async function mintPass(app: FastifyInstance, p: PairingRow, sceneId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, p.userId!) })
  if (!user) return null
  const [wallet] = await verifiedWalletsOf(user.id)
  return { user, ...issueHyperfyPass(app, user, wallet ?? null, { id: p.id, worldId: p.worldId, sceneId }) }
}

async function sceneOfWorld(worldId: string): Promise<string | null> {
  const [w] = await db.select({ sceneId: hyperfyWorlds.sceneId }).from(hyperfyWorlds).where(eq(hyperfyWorlds.id, worldId))
  return w?.sceneId ?? null
}

/**
 * The HUD trades its code and secret for a pass. A wrong secret looks like "still pending" and consumes nothing.
 * Taking an approved pairing is atomic: only one claim wins. Needs the app to sign the pass.
 */
export async function claimPairing(code: string, secret: string, app: FastifyInstance, now = new Date()): Promise<PairClaimResponse> {
  const codeHash = sha256(code)
  const [row] = await db.select().from(hyperfyPairings).where(eq(hyperfyPairings.codeHash, codeHash))
  if (!row) return { status: 'expired' }
  // Hosted pairings have no browser secret: they are claimed only through the vouch path.
  if (row.secretHash === null) return { status: 'expired' }
  if (!sameHash(row.secretHash, sha256(secret))) return { status: 'pending' }
  if (row.codeExpiresAt <= now) return { status: 'expired' }
  if (row.status === 'pending') return { status: 'pending' }
  if (row.status === 'refused') {
    await db.update(hyperfyPairings).set({ codeHash: null }).where(and(eq(hyperfyPairings.id, row.id), eq(hyperfyPairings.status, 'refused')))
    return { status: 'refused' }
  }
  if (row.status !== 'approved') return { status: 'expired' }

  const [claimed] = await db
    .update(hyperfyPairings)
    .set({ status: 'claimed', codeHash: null, expiresAt: new Date(now.getTime() + HYPERFY_PAIRING.selfPairingTtlMs) })
    .where(and(eq(hyperfyPairings.id, row.id), eq(hyperfyPairings.codeHash, codeHash), eq(hyperfyPairings.status, 'approved'), gt(hyperfyPairings.codeExpiresAt, now)))
    .returning()
  if (!claimed) return { status: 'expired' }
  const sceneId = await sceneOfWorld(claimed.worldId)
  const minted = sceneId ? await mintPass(app, claimed, sceneId) : null
  if (!sceneId || !minted) return { status: 'expired' }
  return { status: 'approved', pass: minted.pass, passExpiresAt: minted.passExpiresAt.toISOString(), pairingId: claimed.id, sceneId, user: { id: minted.user.id, displayName: minted.user.displayName } }
}

/** A fresh pass for a live pairing; bumps lastUsedAt. 'revoked' also covers an unknown pairing or a wrong secret. */
export async function renewPairing(pairingId: string, secret: string, app: FastifyInstance, now = new Date()): Promise<PairRenewResponse | 'revoked' | 'expired'> {
  const [row] = await db.select().from(hyperfyPairings).where(eq(hyperfyPairings.id, pairingId))
  if (!row || row.status !== 'claimed' || row.secretHash === null || !sameHash(row.secretHash, sha256(secret))) return 'revoked'
  if (!activeAt(row, now)) return 'expired'
  const [bumped] = await db
    .update(hyperfyPairings)
    .set({ lastUsedAt: now })
    .where(and(eq(hyperfyPairings.id, row.id), eq(hyperfyPairings.status, 'claimed')))
    .returning()
  if (!bumped) return 'revoked'
  const sceneId = await sceneOfWorld(bumped.worldId)
  const minted = sceneId ? await mintPass(app, bumped, sceneId) : null
  if (!sceneId || !minted) return 'revoked'
  return { pass: minted.pass, passExpiresAt: minted.passExpiresAt.toISOString(), sceneId }
}

/** Ends a pairing the user owns. Its passes stop working at once on this process. */
export async function revokePairing(pairingId: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(hyperfyPairings)
    .set({ status: 'revoked', codeHash: null })
    .where(and(eq(hyperfyPairings.id, pairingId), eq(hyperfyPairings.userId, userId), inArray(hyperfyPairings.status, ['approved', 'claimed'])))
    .returning({ id: hyperfyPairings.id })
  revokeGeneration++
  liveCache.delete(pairingId)
  return rows.length > 0
}

/** After pairings were revoked in a transaction that has committed: drops their live answers on this process. */
export function forgetPairings(ids: string[]): void {
  revokeGeneration++
  for (const id of ids) liveCache.delete(id)
}

export async function listPairings(userId: string, now = new Date()): Promise<HyperfyPairingSummary[]> {
  const rows = await db
    .select({ p: hyperfyPairings, worldName: hyperfyWorlds.name, sceneId: hyperfyWorlds.sceneId, sceneName: scenes.name })
    .from(hyperfyPairings)
    .innerJoin(hyperfyWorlds, eq(hyperfyPairings.worldId, hyperfyWorlds.id))
    .innerJoin(scenes, eq(hyperfyWorlds.sceneId, scenes.id))
    .where(and(eq(hyperfyPairings.userId, userId), eq(hyperfyPairings.status, 'claimed')))
  return rows
    .filter((r) => activeAt(r.p, now))
    .map((r) => ({
      id: r.p.id,
      worldId: r.p.worldId,
      worldName: r.worldName,
      sceneId: r.sceneId,
      sceneName: r.sceneName,
      kind: isHosted(r.p) ? ('hosted' as const) : ('self' as const),
      createdAt: r.p.createdAt.toISOString(),
      lastUsedAt: r.p.lastUsedAt ? r.p.lastUsedAt.toISOString() : null,
      expiresAt: r.p.expiresAt ? r.p.expiresAt.toISOString() : null,
    }))
}

/** Is this pairing still good: claimed, not revoked, and inside its lifetime (self: expiresAt; hosted: idle window)? */
export async function pairingActive(pairingId: string, now = new Date()): Promise<boolean> {
  const [row] = await db.select().from(hyperfyPairings).where(eq(hyperfyPairings.id, pairingId))
  return !!row && activeAt(row, now)
}

// Per-pairing answer for the auth middleware, kept for 10 s; revoking on this process drops the entry.
const LIVE_CACHE_MS = 10_000
const liveCache = new Map<string, { live: boolean; until: number }>()
/** Bumped by every revoke: a read that started before one may have seen the row still live, so it isn't cached. */
let revokeGeneration = 0

/** `read` is the database check (a seam for tests). */
export async function pairingLive(pairingId: string, read: (id: string) => Promise<boolean> = pairingActive): Promise<boolean> {
  const hit = liveCache.get(pairingId)
  if (hit && hit.until > Date.now()) return hit.live
  const generation = revokeGeneration
  const live = await read(pairingId)
  if (generation === revokeGeneration) liveCache.set(pairingId, { live, until: Date.now() + LIVE_CACHE_MS })
  return live
}

export type VouchResponse =
  | HyperfyVouchLinked
  | { status: 'unlinked'; code: string; expiresAt: string; pairingId: string }
  | { status: 'pending' | 'refused' | 'expired' }

/**
 * A hosted world speaks for one of its players (the caller has already proved the world). No browser secret is involved:
 * 1. an active hosted pairing for this player gets a fresh pass (this is also how hosted links renew) and a lastUsedAt bump;
 * 2. else an approved, unclaimed one is claimed now (expiresAt stays null; a hosted pairing ages out by idleness) and gets a pass;
 * 3. else a new pending hosted pairing is created and its code returned for the player's browser.
 * Each step that changes a row is a conditional update, so a concurrent revoke or claim wins cleanly.
 */
export async function vouchPairing(app: FastifyInstance, world: Pick<HyperfyWorldRow, 'id' | 'sceneId'>, hyperfyPlayerId: string, playerName: string | null, pendingPairingId?: string, now = new Date()): Promise<VouchResponse> {
  if (pendingPairingId !== undefined) {
    // Polling for a pairing created by an earlier vouch: report it, never mint another code.
    const [mine] = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pendingPairingId)
      ? await db.select().from(hyperfyPairings).where(and(eq(hyperfyPairings.id, pendingPairingId), eq(hyperfyPairings.worldId, world.id), eq(hyperfyPairings.hyperfyPlayerId, hyperfyPlayerId)))
      : []
    if (!mine) return { status: 'expired' }
    if (mine.status === 'refused') return { status: 'refused' }
    if (mine.status === 'pending') return mine.codeExpiresAt > now ? { status: 'pending' } : { status: 'expired' }
    if (mine.status === 'approved' && mine.codeExpiresAt <= now) return { status: 'expired' }
    if (mine.status !== 'approved' && mine.status !== 'claimed') return { status: 'expired' }
    // approved or claimed: the normal path below links it
  }
  const rows = await db
    .select()
    .from(hyperfyPairings)
    .where(and(eq(hyperfyPairings.worldId, world.id), eq(hyperfyPairings.hyperfyPlayerId, hyperfyPlayerId), inArray(hyperfyPairings.status, ['claimed', 'approved'])))
    .orderBy(desc(hyperfyPairings.lastUsedAt), desc(hyperfyPairings.createdAt))

  const link = async (p: PairingRow): Promise<VouchResponse | null> => {
    const minted = await mintPass(app, p, world.sceneId)
    if (!minted) return null
    return { status: 'linked', pass: minted.pass, passExpiresAt: minted.passExpiresAt.toISOString(), pairingId: p.id, sceneId: world.sceneId, user: { id: minted.user.id, displayName: minted.user.displayName } }
  }

  for (const row of rows.filter((r) => r.status === 'claimed' && activeAt(r, now))) {
    const idleFloor = new Date(now.getTime() - HYPERFY_PAIRING.hostedIdleTtlMs)
    const [bumped] = await db
      .update(hyperfyPairings)
      .set({ lastUsedAt: now })
      .where(and(eq(hyperfyPairings.id, row.id), eq(hyperfyPairings.status, 'claimed'), sql`coalesce(${hyperfyPairings.lastUsedAt}, ${hyperfyPairings.createdAt}) > ${idleFloor.toISOString()}::timestamptz`))
      .returning()
    const linked = bumped && (await link(bumped))
    if (linked) return linked
  }

  for (const row of rows.filter((r) => r.status === 'approved' && r.codeExpiresAt > now)) {
    const [claimed] = await db
      .update(hyperfyPairings)
      .set({ status: 'claimed', codeHash: null, lastUsedAt: now })
      .where(and(eq(hyperfyPairings.id, row.id), eq(hyperfyPairings.status, 'approved'), gt(hyperfyPairings.codeExpiresAt, now)))
      .returning()
    const linked = claimed && (await link(claimed))
    if (linked) return linked
  }

  const pending = await insertPending(world.id, null, playerName, hyperfyPlayerId, now)
  return { status: 'unlinked', code: pending.code, expiresAt: pending.expiresAt.toISOString(), pairingId: pending.pairingId }
}
