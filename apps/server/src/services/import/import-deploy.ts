import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { ImportLocation } from '@virvixr/shared'
import { db } from '../../db/connection.js'
import { dclWorldDestinations, sceneImports } from '../../db/schema.js'
import { getImportStore } from '../../storage/private-store.js'
import { ownerFor, RouteError } from '../../routes/dcl-destinations.js'
import { verifiedWalletsOf } from '../../analytics/claims.js'
import { DirectoryUnavailableError } from '../../analytics/dcl-directory.js'
import { virviSignerFor } from '../dcl/entity.js'
import { parcelControl } from '../dcl/parcel-control.js'
import {
  assertBuiltPlace, DeployerError, importAfterFailure, markFailed, prepareSignedDeploy, startVirviDeploy, type DeployOptions, type Deployment,
  type Destination,
} from '../dcl/world-deployer.js'
import { lockLocation, locationOf, OWNER_ERROR_MESSAGES, sameLocation, type SceneImportRow } from './imports.js'
import { ImportError } from './scene-zip.js'

/**
 * Deploying an import's build to the World its scene.json names (Ruling R1), or to its Genesis City parcels. When the
 * build finishes, only a destination where Virvi holds the grant deploys on its own (`deployImport`); any other import
 * stays `built` until the creator starts it (`startImportDeploy`, from POST /api/imports/:id/deploy) and signs. The
 * destination is set up (or taken over) at the moment a deploy starts: adopted, since the code is the owner's, and
 * pointing at the import with `pending_import_id`, which world-deployer.ts deploys from and clears once the deployment
 * ends. A parcels destination is keyed by its base and owned by the importer's wallet that controls every parcel.
 */

export const NOT_DEPLOYABLE = 'This import has nothing to deploy right now.'
const FILES_GONE = "The built scene's files are gone. Upload it again."
const WORLD_IN_USE = "This World is connected to a Virvi scene you can't manage."
const PARCELS_IN_USE = "These parcels are connected to a Virvi scene you can't manage."
const GENERIC = 'Something went wrong on our side while deploying. Try again in a few minutes.'

export type StartedImportDeploy =
  | { mode: 'virvi'; deployment: Deployment }
  | { mode: 'sign'; deployment: Deployment; payload: string; expiresAt: string }

const granted = (d: Pick<Destination, 'mode' | 'grantedAt'>) => d.mode === 'virvi' && !!d.grantedAt

/**
 * The base and parcels of the built scene.json, which must still deploy where the import was uploaded for: its World,
 * or its very parcels (assertBuiltPlace). A stored build is never trusted.
 */
async function builtPlot(row: SceneImportRow, loc: ImportLocation): Promise<{ base: string; parcels: string[] }> {
  const obj = row.builtKeyPrefix ? await getImportStore().get(`${row.builtKeyPrefix}scene.json`) : null
  if (!obj) throw new ImportError(409, 'import_files_missing', FILES_GONE)
  let json: { scene?: { parcels?: unknown; base?: unknown }; worldConfiguration?: { name?: unknown } } | undefined
  try {
    json = JSON.parse(obj.body.toString('utf8')) as typeof json
  } catch { /* checked below */ }
  assertBuiltPlace(loc, json)
  if (loc.kind === 'parcels') return { base: loc.base, parcels: loc.parcels }
  const scene = json?.scene
  const parcels = Array.isArray(scene?.parcels) && scene.parcels.length && scene.parcels.every((p) => typeof p === 'string') ? (scene.parcels as string[]) : null
  if (!parcels) throw new ImportError(422, 'bad_scene_json', "The built scene.json doesn't list its parcels.")
  return { base: typeof scene?.base === 'string' ? scene.base : parcels[0], parcels }
}

/** ownerFor, with the import routes' plain sentences. */
async function worldOwner(userId: string, world: string): Promise<string> {
  try {
    return await ownerFor(userId, world)
  } catch (err) {
    if (err instanceof RouteError) throw new ImportError(err.status, err.code, OWNER_ERROR_MESSAGES[err.code] ?? GENERIC)
    throw err
  }
}

/**
 * The importer's verified wallet that may deploy to every parcel (403 not_parcel_controller otherwise, 503 when
 * Decentraland can't say): the parcels destination's owner wallet.
 */
async function parcelOwner(userId: string, parcels: string[]): Promise<string> {
  let wallet: string | null
  let missing: string | null
  try {
    ;({ wallet, missing } = await parcelControl(await verifiedWalletsOf(userId), parcels))
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) throw new ImportError(503, 'catalyst_unreachable', "Decentraland didn't answer just now. Try again in a minute.")
    throw err
  }
  if (!wallet) throw new ImportError(403, 'not_parcel_controller', `None of your verified wallets can deploy to parcel ${missing ?? parcels[0]}.`)
  return wallet
}

/** The destination of an import's location: the World's, or the parcels destination at its base. */
function destinationAt(loc: ImportLocation) {
  return db.query.dclWorldDestinations.findFirst({
    where: loc.kind === 'world'
      ? eq(dclWorldDestinations.worldName, loc.world)
      : and(eq(dclWorldDestinations.kind, 'parcels'), eq(dclWorldDestinations.base, loc.base)),
  })
}

/**
 * An import that may still be put back or failed: waiting for the creator, or claimed by the automatic deploy (Ruling
 * R24: `deploying` with no deployment linked yet).
 */
const notYetDeploying = (id: string) => and(
  eq(sceneImports.id, id),
  or(inArray(sceneImports.status, ['built', 'awaiting_signature']), and(eq(sceneImports.status, 'deploying'), isNull(sceneImports.deploymentId))),
)

/**
 * A deploy that didn't start (the World accepted nothing) puts the import back to `built` with the error's sentence, so
 * the creator can try again (Ruling R19), also from the automatic deploy's claim (R24); a stored build that can't work
 * (PERMANENT_IMPORT_ERRORS) fails it. The same rule as a deployment that fails (markFailed). The built files stay.
 */
async function startFailed(importId: string, err: unknown): Promise<void> {
  const known = err instanceof ImportError || err instanceof DeployerError
  await db.update(sceneImports).set(importAfterFailure(known ? err.code : 'deploy_failed', known ? err.message : GENERIC)).where(notYetDeploying(importId))
}

/**
 * Starts the deploy of a `built` import, or one whose signature window passed: Virvi-signed on a granted Virvi-mode
 * World (import `deploying`), otherwise prepared for the owner to sign (import `awaiting_signature`). The import must
 * still be its World's newest with its status unchanged, checked under the lock uploads take, or this is 409
 * not_deployable. `by` must own the World. A deploy that fails to start goes back to `built` with the error (see
 * startFailed). With `virviOnly`, an import Virvi can't deploy itself (it would need a signature) is left alone and
 * null is returned.
 */
export async function startImportDeploy(
  row: SceneImportRow, by: string, opts: { virviOnly?: boolean; claimed?: boolean } & DeployOptions = {},
): Promise<StartedImportDeploy | null> {
  const from = row.status
  const startable = from === 'built' || from === 'awaiting_signature' || (opts.claimed && from === 'deploying' && !row.deploymentId)
  if (!startable) throw new ImportError(409, 'not_deployable', NOT_DEPLOYABLE)
  const existing = await destinationAt(locationOf(row))
  const virvi = !!existing && granted(existing)
  if (opts.virviOnly && !(virvi && virviSignerFor(existing.kind))) return null
  try {
    return await begin(row, by, virvi, opts)
  } catch (err) {
    // Not ours to touch when the import moved on meanwhile
    if (!(err instanceof ImportError && err.code === 'not_deployable')) await startFailed(row.id, err)
    throw err
  }
}

async function begin(row: SceneImportRow, by: string, virvi: boolean, opts: { virviOnly?: boolean } & DeployOptions): Promise<StartedImportDeploy | null> {
  const from = row.status
  const loc = locationOf(row)
  const plot = await builtPlot(row, loc)
  const owner = loc.kind === 'world' ? await worldOwner(by, loc.world) : await parcelOwner(by, loc.parcels)
  if (virvi && !virviSignerFor(loc.kind)) throw new DeployerError(503, 'virvi_deploys_unavailable', 'Virvi deploys are not available right now')
  // A signature that came too late must not deploy the old preparation
  if (from === 'awaiting_signature' && row.deploymentId) {
    await markFailed(row.deploymentId, new DeployerError(409, 'expired', 'This publish request expired.'), 'awaiting_signature')
  }

  const dest = await db.transaction(async (tx) => {
    await lockLocation(tx, loc)
    const now = await tx.query.sceneImports.findFirst({ where: eq(sceneImports.id, row.id), columns: { status: true } })
    const newest = await tx.query.sceneImports.findFirst({
      where: sameLocation(loc), orderBy: [desc(sceneImports.createdAt)], columns: { id: true },
    })
    if (now?.status !== from || newest?.id !== row.id) return null
    const at = new Date()
    const values = { sceneId: row.sceneId, ownerUserId: by, ownerWallet: owner, ...plot, mode: 'sign' as const, adopted: true, pendingImportId: row.id }
    const set = { ...plot, adopted: true, pendingImportId: row.id, ownerWallet: owner, ownerUserId: by, updatedAt: at }
    const setWhere = eq(dclWorldDestinations.sceneId, row.sceneId)
    // Ruling R3: a parcels destination is unique on its base (a partial index), and no World query ever matches it
    const [d] = loc.kind === 'world'
      ? await tx.insert(dclWorldDestinations).values({ ...values, worldName: loc.world })
        .onConflictDoUpdate({ target: dclWorldDestinations.worldName, set, setWhere }).returning()
      : await tx.insert(dclWorldDestinations).values({ ...values, kind: 'parcels', worldName: null })
        .onConflictDoUpdate({ target: dclWorldDestinations.base, targetWhere: sql`kind = 'parcels'`, set, setWhere }).returning()
    if (!d) throw loc.kind === 'world' ? new ImportError(409, 'world_in_use', WORLD_IN_USE) : new ImportError(409, 'parcels_in_use', PARCELS_IN_USE)
    await tx.update(sceneImports).set({ destinationId: d.id, updatedAt: at }).where(eq(sceneImports.id, row.id))
    return d
  })
  if (!dest) {
    if (opts.virviOnly) return null
    throw new ImportError(409, 'not_deployable', NOT_DEPLOYABLE)
  }

  try {
    if (granted(dest)) return { mode: 'virvi', deployment: await startVirviDeploy(dest.id, by, { fetch: opts.fetch }) }
    return { mode: 'sign', ...(await prepareSignedDeploy(dest.id, by, { fetch: opts.fetch })) }
  } catch (err) {
    // Nothing started: the destination doesn't wait on this import
    await db.update(dclWorldDestinations).set({ pendingImportId: null, updatedAt: new Date() })
      .where(and(eq(dclWorldDestinations.id, dest.id), eq(dclWorldDestinations.pendingImportId, row.id)))
    throw err
  }
}

/**
 * What runs when an import's build is stored (setOnBuildDone): a granted Virvi-mode World (or parcels) deploys it now; anything
 * else stays `built` for the creator. An error is recorded on the import (startFailed) and rethrown for the caller's log.
 */
export async function deployImport(importId: string, opts: DeployOptions = {}): Promise<void> {
  const row = await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, importId) })
  if (row?.status !== 'built') return
  const dest = await destinationAt(locationOf(row))
  if (!dest || !granted(dest) || !virviSignerFor(dest.kind)) return
  // Ruling R24: claimed before anything slow, so the creator is never offered a Deploy this is already doing
  const [claimed] = await db.update(sceneImports).set({ status: 'deploying', updatedAt: new Date() })
    .where(and(eq(sceneImports.id, importId), eq(sceneImports.status, 'built'), isNull(sceneImports.deploymentId)))
    .returning()
  if (!claimed) return
  const started = await startImportDeploy(claimed, claimed.userId, { virviOnly: true, claimed: true, fetch: opts.fetch })
  // Nothing started and nothing failed (the grant or the World moved on): the creator deploys it
  if (!started) {
    await db.update(sceneImports).set({ status: 'built', updatedAt: new Date() })
      .where(and(eq(sceneImports.id, importId), eq(sceneImports.status, 'deploying'), isNull(sceneImports.deploymentId)))
  }
}
