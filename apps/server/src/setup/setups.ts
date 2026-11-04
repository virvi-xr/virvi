import { randomBytes } from 'node:crypto'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { locationKeyFor, type ImportLocation } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { analyticsScenes, locationSetups, sceneRoles, scenes } from '../db/schema.js'
import { insertSceneWithDefaultPreset } from '../scenes/create.js'
import { getDclDirectory, type DclDirectory } from '../analytics/dcl-directory.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { resolveVerifiedWalletUser } from '../auth/wallet-users.js'
import type { AnalyticsSceneRow } from '../analytics/registry.js'

export type LocationSetupRow = typeof locationSetups.$inferSelect

export class SetupError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
  }
}

export async function getActiveSetup(analyticsSceneId: string): Promise<LocationSetupRow | null> {
  return (await db.query.locationSetups.findFirst({ where: and(eq(locationSetups.analyticsSceneId, analyticsSceneId), isNull(locationSetups.endedAt)) })) ?? null
}

/** Host's verified wallets plus active co-hosts' wallets (lowercased). */
export async function teamWallets(virviSceneId: string): Promise<string[]> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, virviSceneId) })
  const host = scene ? await verifiedWalletsOf(scene.ownerId) : []
  const co = await db
    .select({ w: sceneRoles.walletAddress })
    .from(sceneRoles)
    .where(and(eq(sceneRoles.sceneId, virviSceneId), eq(sceneRoles.role, 'cohost'), isNull(sceneRoles.revokedAt)))
  return [...new Set([...host, ...co.map((r) => r.w)].map((w) => w.toLowerCase()))]
}

const entityFromUrn = (urn: string | undefined) => urn?.match(/^urn:decentraland:entity:([^?]+)/)?.[1] ?? null

/** What is deployed at the location right now. Worlds don't expose the deployer (null). */
export async function currentDeployment(scene: AnalyticsSceneRow, dir: DclDirectory = getDclDirectory()) {
  if (scene.kind === 'world') {
    const w = await dir.getWorldScene(scene.worldName!)
    return { entityId: entityFromUrn(w?.sceneUrns?.[0]), deployer: null as string | null }
  }
  const base = scene.baseParcel ?? scene.parcels[0]
  if (!base) return { entityId: null, deployer: null }
  const active = await dir.getActiveSceneAt(base)
  if (!active) return { entityId: null, deployer: null }
  return { entityId: active.entityId, deployer: await dir.getActiveDeployer(base, active.entityId) }
}

/**
 * Host is final, but a new deployment by someone outside the host + co-hosts releases the location.
 * Returns the (possibly updated) active setup, or null if it ended. Unknown current deployment = keep.
 */
export async function releaseIfRedeployed(
  setup: LocationSetupRow,
  scene: AnalyticsSceneRow,
  dir: DclDirectory = getDclDirectory(),
  now = new Date(),
): Promise<LocationSetupRow | null> {
  const current = await currentDeployment(scene, dir)
  if (!current.entityId || current.entityId === setup.deploymentEntityId) return setup
  const team = await teamWallets(setup.virviSceneId)
  if (scene.kind === 'world') {
    // The Worlds API doesn't expose the actual deployer, so keep when any team wallet could have deployed.
    const allowed = new Set([(await dir.getWorldOwner(scene.worldName!)) ?? '', ...(await dir.getWorldDeployers(scene.worldName!))])
    if (!team.some((w) => allowed.has(w))) return release(setup, scene, now)
  } else {
    // Unknown deployer: keep the setup unchanged (entity not recorded) so it is rechecked next time.
    if (!current.deployer) return setup
    if (!team.includes(current.deployer.toLowerCase())) return release(setup, scene, now)
  }
  const [row] = await db
    .update(locationSetups)
    .set({ deploymentEntityId: current.entityId })
    .where(and(eq(locationSetups.id, setup.id), isNull(locationSetups.endedAt)))
    .returning()
  return row ?? null
}

async function release(setup: LocationSetupRow, scene: AnalyticsSceneRow, now: Date): Promise<null> {
  await db.transaction(async (tx) => {
    const ended = await tx
      .update(locationSetups)
      .set({ endedAt: now, endReason: 'redeployed' })
      .where(and(eq(locationSetups.id, setup.id), isNull(locationSetups.endedAt)))
      .returning({ id: locationSetups.id })
    if (!ended.length) return
    // The next host starts with wallet visibility off.
    await tx.update(analyticsScenes).set({ walletVisibility: false, updatedAt: now }).where(eq(analyticsScenes.id, scene.id))
    await tx
      .update(analyticsScenes)
      .set({ virviSceneId: null, updatedAt: now })
      .where(and(eq(analyticsScenes.id, scene.id), eq(analyticsScenes.virviSceneId, setup.virviSceneId)))
  })
  return null
}

/**
 * Links a location Virvi just deployed to its Virvi scene: the location row (as the registry would write it
 * for a World or Genesis City ref) and the active setup, so the in-world editor works with no "Set up Virvi here" step.
 * Another scene's setup there is ended as 'replaced'; the same scene's only gets the new entity id.
 * A parcels location is keyed `gc:<base>`; its footprint comes from the location (`parcels` overrides it). The same
 * scene's setup at another Genesis City location overlapping these parcels (its base moved) ends as 'replaced'.
 */
export async function linkLocation(input: {
  location: ImportLocation
  virviSceneId: string
  hostUserId: string
  entityId: string
  title: string
  base?: string
  parcels?: string[]
}, now = new Date()): Promise<void> {
  const loc = input.location
  const world = loc.kind === 'world' ? loc.world.toLowerCase() : null
  const base = input.base ?? (loc.kind === 'parcels' ? loc.base : undefined)
  const parcels = input.parcels ?? (loc.kind === 'parcels' ? loc.parcels : undefined)
  const kind = loc.kind === 'world' ? 'world' : 'parcels'
  const realm = world ?? 'main'
  const locationKey = world
    ? locationKeyFor({ realm: world, isWorld: true, isPreview: false, worldName: world }, null)
    : locationKeyFor({ realm, isWorld: false, isPreview: false, baseParcel: base }, null)
  await db.transaction(async (tx) => {
    const [loc] = await tx
      .insert(analyticsScenes)
      .values({
        kind,
        locationKey,
        realm,
        baseParcel: base ?? null,
        parcels: parcels ?? [],
        worldName: world,
        activeEntityId: input.entityId,
        title: input.title,
        salt: randomBytes(32).toString('hex'),
        isPreview: false,
        virviSceneId: input.virviSceneId,
        lastEntityCheckAt: now,
      })
      .onConflictDoUpdate({
        target: analyticsScenes.locationKey,
        set: {
          realm,
          ...(base ? { baseParcel: base } : {}),
          ...(parcels ? { parcels } : {}),
          activeEntityId: input.entityId,
          title: input.title,
          virviSceneId: input.virviSceneId,
          lastEntityCheckAt: now,
          updatedAt: now,
        },
      })
      .returning()
    if (kind === 'parcels' && parcels?.length) {
      // The same scene moved its base: its setup at an overlapping location is replaced by this one
      const overlap = sql`ARRAY[${sql.join(parcels.map((p) => sql`${p}`), sql`, `)}]::text[]`
      const moved = await tx
        .select({ setupId: locationSetups.id, locationId: analyticsScenes.id })
        .from(locationSetups)
        .innerJoin(analyticsScenes, eq(analyticsScenes.id, locationSetups.analyticsSceneId))
        .where(and(
          eq(analyticsScenes.kind, 'parcels'), ne(analyticsScenes.id, loc.id), sql`${analyticsScenes.parcels} && ${overlap}`,
          eq(locationSetups.virviSceneId, input.virviSceneId), isNull(locationSetups.endedAt),
        ))
      if (moved.length) {
        await tx.update(locationSetups).set({ endedAt: now, endReason: 'replaced' }).where(inArray(locationSetups.id, moved.map((m) => m.setupId)))
        await tx.update(analyticsScenes).set({ virviSceneId: null, updatedAt: now })
          .where(and(inArray(analyticsScenes.id, moved.map((m) => m.locationId)), eq(analyticsScenes.virviSceneId, input.virviSceneId)))
      }
    }
    const [active] = await tx
      .select()
      .from(locationSetups)
      .where(and(eq(locationSetups.analyticsSceneId, loc.id), isNull(locationSetups.endedAt)))
      .for('update')
    if (active?.virviSceneId === input.virviSceneId) {
      await tx.update(locationSetups).set({ deploymentEntityId: input.entityId }).where(eq(locationSetups.id, active.id))
      return
    }
    if (active) {
      await tx.update(locationSetups).set({ endedAt: now, endReason: 'replaced' }).where(eq(locationSetups.id, active.id))
    }
    await tx.insert(locationSetups).values({
      analyticsSceneId: loc.id, virviSceneId: input.virviSceneId, hostUserId: input.hostUserId, deploymentEntityId: input.entityId, startedAt: now,
    })
    // A new host starts with wallet visibility off, as in setUpLocation.
    await tx.update(analyticsScenes).set({ walletVisibility: false }).where(eq(analyticsScenes.id, loc.id))
  })
}

/** A World's location: linkLocation for a `world`. */
export function linkWorldLocation(input: Omit<Parameters<typeof linkLocation>[0], 'location'> & { world: string }, now = new Date()): Promise<void> {
  const { world, ...rest } = input
  return linkLocation({ ...rest, location: { kind: 'world', world } }, now)
}

/** Create (or reuse) the wallet's user, a Virvi scene with a default preset, and the active setup. Free: no plan limits. */
export async function setUpLocation(scene: AnalyticsSceneRow, wallet: string, now = new Date()) {
  const w = wallet.toLowerCase()
  if (await getActiveSetup(scene.id)) throw new SetupError(409, 'already_set_up')
  const user = await resolveVerifiedWalletUser(w, `${w.slice(0, 6)}…${w.slice(-4)}`, 'account')
  try {
    return await db.transaction(async (tx) => {
      const { sceneId } = await insertSceneWithDefaultPreset(tx, user.id, scene.title || scene.locationKey)
      const created = { id: sceneId }
      const [setup] = await tx
        .insert(locationSetups)
        .values({ analyticsSceneId: scene.id, virviSceneId: created.id, hostUserId: user.id, deploymentEntityId: scene.activeEntityId ?? null, startedAt: now })
        .returning()
      await tx.update(analyticsScenes).set({ virviSceneId: created.id, walletVisibility: false, updatedAt: now }).where(eq(analyticsScenes.id, scene.id))
      return { setup, virviSceneId: created.id, userId: user.id }
    })
  } catch (err) {
    // The partial unique index (one active setup per location) loses the race for the second presser.
    const e = err as { code?: string; cause?: { code?: string } }
    if (e.code === '23505' || e.cause?.code === '23505') throw new SetupError(409, 'already_set_up')
    throw err
  }
}
