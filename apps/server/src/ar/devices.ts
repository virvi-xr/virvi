import type { FastifyInstance } from 'fastify'
import { randomInt } from 'node:crypto'
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { AR_PAIRING, HYPERFY_PAIRING, type ArDeviceKind, type ArDeviceScene, type ArDeviceSpace, type ArDeviceStatus, type ArDeviceSummary, type ArPairClaimResponse } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { arDevices, arFloors, arMarkers, arSpaces, sceneCollaborators, sceneRoles, scenes, users } from '../db/schema.js'
import { getSceneAccess } from '../auth/permissions.js'
import type { Actor } from '../auth/actor.js'
import { isUuid } from '../auth/scene-from.js'
import { issueArPass } from '../auth/scene-pass.js'
import { sameHash, sha256 } from '../auth/hash.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { mayBuild, spaceScene } from './access.js'

/**
 * Pairing an AR headset to a Virvi user: the headset sends the sha256 of a secret only it knows and gets a short code;
 * the user approves the code on the website as a personal or a shared headset; the headset trades code and secret for
 * a device id, then mints short-lived AR passes with id and secret. The approver's build access is checked at each
 * mint, never at approval. Codes and secrets are credentials: only their sha256 is stored and they are never logged.
 */

type DeviceRow = typeof arDevices.$inferSelect

function newCode(): string {
  let code = ''
  for (let i = 0; i < HYPERFY_PAIRING.codeLength; i++) code += HYPERFY_PAIRING.codeAlphabet[randomInt(HYPERFY_PAIRING.codeAlphabet.length)]
  return code
}

const isUniqueClash = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.code === '23505' || e?.cause?.code === '23505'
}

/** Paired and inside its lifetime. */
const activeAt = (d: DeviceRow, now: Date) => d.status === 'claimed' && !!d.expiresAt && d.expiresAt.getTime() > now.getTime()

export async function startDevicePairing(secretHash: string, deviceName: string | null, now = new Date()): Promise<{ code: string; codeExpiresAt: Date }> {
  const codeExpiresAt = new Date(now.getTime() + AR_PAIRING.codeTtlMs)
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode()
    try {
      await db.insert(arDevices).values({ codeHash: sha256(code), secretHash, deviceName, status: 'pending', codeExpiresAt, createdAt: now })
      return { code, codeExpiresAt }
    } catch (err) {
      // A live code collided with this one (unique code_hash): draw another.
      if (attempt === 4 || !isUniqueClash(err)) throw err
    }
  }
  throw new Error('unreachable')
}

async function byCode(code: string): Promise<DeviceRow | null> {
  const [row] = await db.select().from(arDevices).where(eq(arDevices.codeHash, sha256(code)))
  return row ?? null
}

/** What the approval page shows for a code, or null when the code is unknown, used or expired. */
export async function devicePairingForApproval(code: string, now = new Date()): Promise<{ deviceName: string | null; codeExpiresAt: Date } | null> {
  const row = await byCode(code)
  if (!row || row.status !== 'pending' || row.codeExpiresAt <= now) return null
  return { deviceName: row.deviceName, codeExpiresAt: row.codeExpiresAt }
}

/**
 * Any signed-in, verified account may approve: what the headset may then do is the approver's own build access,
 * checked at every mint. Only one request can move a pending, live code on.
 */
export async function approveDevicePairing(code: string, actor: Actor, kind: ArDeviceKind, now = new Date()): Promise<'approved' | 'expired'> {
  if (!actor.userId) return 'expired'
  const [moved] = await db
    .update(arDevices)
    .set({ status: 'approved', userId: actor.userId, kind })
    .where(and(eq(arDevices.codeHash, sha256(code)), eq(arDevices.status, 'pending'), gt(arDevices.codeExpiresAt, now)))
    .returning({ id: arDevices.id })
  return moved ? 'approved' : 'expired'
}

const ttlOf = (kind: string | null) => (kind === 'shared' ? AR_PAIRING.sharedSessionTtlMs : AR_PAIRING.personalIdleTtlMs)

/**
 * The headset trades its code and secret for its device id. A wrong secret is refused and consumes nothing. Taking an
 * approved code is atomic: only one claim wins, and the code is spent.
 */
export async function claimDevicePairing(code: string, secret: string, now = new Date()): Promise<ArPairClaimResponse | 'bad_secret' | 'expired'> {
  const codeHash = sha256(code)
  const row = await byCode(code)
  if (!row) return 'expired'
  if (!sameHash(row.secretHash, sha256(secret))) return 'bad_secret'
  if (row.codeExpiresAt <= now) return 'expired'
  if (row.status === 'pending') return { status: 'pending' }
  if (row.status === 'refused') {
    await db.update(arDevices).set({ codeHash: null }).where(and(eq(arDevices.id, row.id), eq(arDevices.status, 'refused')))
    return { status: 'refused' }
  }
  if (row.status !== 'approved') return 'expired'
  const [claimed] = await db
    .update(arDevices)
    .set({ status: 'claimed', codeHash: null, expiresAt: new Date(now.getTime() + ttlOf(row.kind)) })
    .where(and(eq(arDevices.id, row.id), eq(arDevices.codeHash, codeHash), eq(arDevices.status, 'approved'), gt(arDevices.codeExpiresAt, now)))
    .returning()
  if (!claimed || !claimed.expiresAt) return 'expired'
  return { status: 'approved', deviceId: claimed.id, kind: claimed.kind as ArDeviceKind, expiresAt: claimed.expiresAt.toISOString() }
}

/** The device behind an id and secret, if it is still live. An id that is not a uuid is no device. */
async function liveDevice(deviceId: string, secret: string, now: Date): Promise<DeviceRow | 'bad_secret' | 'device_revoked'> {
  if (!isUuid(deviceId)) return 'device_revoked'
  const [row] = await db.select().from(arDevices).where(eq(arDevices.id, deviceId))
  if (!row) return 'device_revoked'
  if (!sameHash(row.secretHash, sha256(secret))) return 'bad_secret'
  if (!activeAt(row, now) || !row.userId) return 'device_revoked'
  return row
}

/** The approver as an actor: the same one their own scene passes act as (verified, first verified wallet). */
async function approverOf(d: DeviceRow): Promise<{ user: typeof users.$inferSelect; wallet: string | null; actor: Actor } | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, d.userId!) })
  if (!user) return null
  const [wallet] = await verifiedWalletsOf(user.id)
  return { user, wallet: wallet ?? null, actor: { userId: user.id, role: user.role, wallet: wallet ?? null, verified: true } }
}

export type MintError = 'bad_secret' | 'device_revoked' | 'no_access' | 'not_found'

/**
 * An AR pass for the space's scene, when the approver can build there. A personal headset's expiry slides forward on
 * each mint; a shared one's never moves. The pass never outlives the headset.
 */
export async function mintArPass(app: FastifyInstance, deviceId: string, secret: string, spaceId: string, now = new Date()): Promise<{ pass: string; passExpiresAt: Date; sceneId: string } | MintError> {
  const device = await liveDevice(deviceId, secret, now)
  if (typeof device === 'string') return device
  const sceneId = await spaceScene(spaceId)
  if (!sceneId) return 'not_found'
  return mintForScene(app, device, sceneId, now)
}

/**
 * An AR pass for a whole scene (no space), when the approver can build there. Personal headsets only: a shared one is
 * refused before any access check. Otherwise the same pass as `mintArPass`.
 */
export async function mintArPassForScene(app: FastifyInstance, deviceId: string, secret: string, sceneId: string, now = new Date()): Promise<{ pass: string; passExpiresAt: Date; sceneId: string } | MintError | 'personal_only'> {
  const device = await liveDevice(deviceId, secret, now)
  if (typeof device === 'string') return device
  if (device.kind !== 'personal') return 'personal_only'
  if (!isUuid(sceneId)) return 'no_access'
  return mintForScene(app, device, sceneId, now)
}

/** The shared tail of both mints: the approver's access to the scene is checked here, then the pass is issued. */
async function mintForScene(app: FastifyInstance, device: DeviceRow, sceneId: string, now: Date): Promise<{ pass: string; passExpiresAt: Date; sceneId: string } | MintError> {
  const approver = await approverOf(device)
  if (!approver) return 'device_revoked'
  if (!mayBuild(await getSceneAccess(approver.actor, sceneId, now))) return 'no_access'
  const [bumped] = await db
    .update(arDevices)
    .set(device.kind === 'personal' ? { lastUsedAt: now, expiresAt: new Date(now.getTime() + AR_PAIRING.personalIdleTtlMs) } : { lastUsedAt: now })
    .where(and(eq(arDevices.id, device.id), eq(arDevices.status, 'claimed'), gt(arDevices.expiresAt, now)))
    .returning()
  if (!bumped?.expiresAt) return 'device_revoked'
  const { pass, passExpiresAt } = issueArPass(app, approver.user, approver.wallet, { deviceId: device.id, sceneId, notAfter: bumped.expiresAt }, now)
  return { pass, passExpiresAt, sceneId }
}

/** Scenes the approver owns, collaborates on or holds a role in: candidates only, each still checked like a mint. */
async function candidateSceneIds(userId: string): Promise<string[]> {
  const wallets = await verifiedWalletsOf(userId)
  const [owned, collabs, roles] = await Promise.all([
    db.select({ id: scenes.id }).from(scenes).where(eq(scenes.ownerId, userId)),
    db.select({ id: sceneCollaborators.sceneId }).from(sceneCollaborators).where(eq(sceneCollaborators.userId, userId)),
    db
      .select({ id: sceneRoles.sceneId })
      .from(sceneRoles)
      .where(and(isNull(sceneRoles.revokedAt), wallets.length ? or(eq(sceneRoles.userId, userId), inArray(sceneRoles.walletAddress, wallets)) : eq(sceneRoles.userId, userId))),
  ])
  return [...new Set([...owned, ...collabs, ...roles].map((r) => r.id))]
}

/** Every scene the approver can build on, by name, with or without a space: what a headset can open a pass for. */
export async function listDeviceScenes(deviceId: string, secret: string, now = new Date()): Promise<ArDeviceScene[] | 'bad_secret' | 'device_revoked'> {
  const device = await liveDevice(deviceId, secret, now)
  if (typeof device === 'string') return device
  const approver = await approverOf(device)
  if (!approver) return 'device_revoked'
  const candidates = await candidateSceneIds(approver.user.id)
  if (!candidates.length) return []
  const rows = await db.select({ sceneId: scenes.id, sceneName: scenes.name }).from(scenes).where(inArray(scenes.id, candidates)).orderBy(scenes.name, scenes.id)
  const out: ArDeviceScene[] = []
  for (const r of rows) {
    if (mayBuild(await getSceneAccess(approver.actor, r.sceneId, now))) out.push(r)
  }
  return out
}

/**
 * Every space on a scene the approver can build on, for the headset's "pick a space" list. Candidates are the scenes
 * the approver owns, collaborates on or holds a role in; each is then checked like a mint would. Each space carries
 * its ring codes, so a headset can match the ring it sees to a space even when that ring is unpublished.
 */
export async function listDeviceSpaces(deviceId: string, secret: string, now = new Date()): Promise<ArDeviceSpace[] | 'bad_secret' | 'device_revoked'> {
  const device = await liveDevice(deviceId, secret, now)
  if (typeof device === 'string') return device
  const approver = await approverOf(device)
  if (!approver) return 'device_revoked'
  const candidates = await candidateSceneIds(approver.user.id)
  if (!candidates.length) return []
  const rows = await db
    .select({ spaceId: arSpaces.id, spaceName: arSpaces.name, sceneId: scenes.id, sceneName: scenes.name })
    .from(arSpaces)
    .innerJoin(scenes, eq(scenes.id, arSpaces.sceneId))
    .where(inArray(arSpaces.sceneId, candidates))
    .orderBy(scenes.name, arSpaces.name)
  const buildable = new Set<string>()
  for (const sceneId of new Set(rows.map((r) => r.sceneId))) {
    if (mayBuild(await getSceneAccess(approver.actor, sceneId, now))) buildable.add(sceneId)
  }
  const spaces = rows.filter((r) => buildable.has(r.sceneId))
  const markers = spaces.length
    ? await db
        .select({ spaceId: arFloors.spaceId, markerId: arMarkers.id, floorId: arMarkers.floorId, code: arMarkers.code })
        .from(arMarkers)
        .innerJoin(arFloors, eq(arFloors.id, arMarkers.floorId))
        .where(inArray(arFloors.spaceId, spaces.map((s) => s.spaceId)))
        .orderBy(arFloors.sortOrder, arMarkers.createdAt)
    : []
  return spaces.map((s) => ({
    ...s,
    markers: markers.filter((m) => m.spaceId === s.spaceId).map(({ markerId, floorId, code }) => ({ markerId, floorId, code })),
  }))
}

/**
 * Called when a headset's session ends (`endDeviceSession`) or the headset is revoked from the website, with the
 * device id. Task 7 registers here to end that device's AR drafts. A failing hook never undoes the end.
 */
const deviceEndedHooks: Array<(deviceId: string) => Promise<void> | void> = []
export function onDeviceEnded(hook: (deviceId: string) => Promise<void> | void): void {
  deviceEndedHooks.push(hook)
}
async function runDeviceEndedHooks(deviceId: string): Promise<void> {
  for (const hook of deviceEndedHooks) {
    try {
      await hook(deviceId)
    } catch (err) {
      console.error('[ar-devices] device-ended hook failed', { deviceId, error: (err as Error).message })
    }
  }
}

function forget(deviceId: string): void {
  revokeGeneration++
  liveCache.delete(deviceId)
}

/**
 * The headset says its session is over. A shared headset is revoked (the next visitor pairs afresh); a personal one
 * stays paired. Either way its AR drafts end. Ending an already-ended session is fine.
 */
export async function endDeviceSession(deviceId: string, secret: string): Promise<'ended' | 'bad_secret' | 'device_revoked'> {
  if (!isUuid(deviceId)) return 'device_revoked'
  const [row] = await db.select().from(arDevices).where(eq(arDevices.id, deviceId))
  if (!row) return 'device_revoked'
  if (!sameHash(row.secretHash, sha256(secret))) return 'bad_secret'
  if (row.kind === 'shared') {
    await db.update(arDevices).set({ status: 'revoked', codeHash: null }).where(and(eq(arDevices.id, row.id), inArray(arDevices.status, ['approved', 'claimed'])))
    forget(row.id)
  }
  await runDeviceEndedHooks(row.id)
  return 'ended'
}

/** The user's paired headsets (approved and not yet claimed, or claimed and live), newest first. */
export async function listDevices(userId: string, now = new Date()): Promise<ArDeviceSummary[]> {
  const rows = await db
    .select()
    .from(arDevices)
    .where(and(eq(arDevices.userId, userId), inArray(arDevices.status, ['approved', 'claimed'])))
    .orderBy(desc(arDevices.createdAt))
  return rows
    .filter((d) => (d.status === 'approved' ? d.codeExpiresAt > now : activeAt(d, now)))
    .map((d) => ({
      id: d.id,
      deviceName: d.deviceName,
      kind: d.kind as ArDeviceKind | null,
      status: d.status as ArDeviceStatus,
      lastUsedAt: d.lastUsedAt ? d.lastUsedAt.toISOString() : null,
      expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
    }))
}

/** Revokes one of the user's headsets. Its passes stop working at once on this process. */
export async function revokeDevice(id: string, userId: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const rows = await db
    .update(arDevices)
    .set({ status: 'revoked', codeHash: null })
    .where(and(eq(arDevices.id, id), eq(arDevices.userId, userId), inArray(arDevices.status, ['approved', 'claimed'])))
    .returning({ id: arDevices.id })
  forget(id)
  if (rows.length) await runDeviceEndedHooks(id)
  return rows.length > 0
}

/** Is this headset still paired: claimed, not revoked, inside its lifetime? */
export async function deviceActive(deviceId: string, now = new Date()): Promise<boolean> {
  if (!isUuid(deviceId)) return false
  const [row] = await db.select().from(arDevices).where(eq(arDevices.id, deviceId))
  return !!row && activeAt(row, now)
}

// Per-device answer for the auth middleware, kept for 10 s; revoking or ending on this process drops the entry.
const LIVE_CACHE_MS = 10_000
const liveCache = new Map<string, { live: boolean; until: number }>()
/** Bumped by every revoke or end: a read that started before one may have seen the row still live, so it isn't cached. */
let revokeGeneration = 0

/** `read` is the database check (a seam for tests). */
export async function deviceLive(deviceId: string, read: (id: string) => Promise<boolean> = deviceActive): Promise<boolean> {
  const hit = liveCache.get(deviceId)
  if (hit && hit.until > Date.now()) return hit.live
  const generation = revokeGeneration
  const live = await read(deviceId)
  if (generation === revokeGeneration) liveCache.set(deviceId, { live, until: Date.now() + LIVE_CACHE_MS })
  return live
}
