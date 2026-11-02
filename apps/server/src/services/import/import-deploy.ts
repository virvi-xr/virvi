import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { dclWorldDestinations, sceneImports } from '../../db/schema.js'
import { getImportStore } from '../../storage/private-store.js'
import { ownerFor, RouteError } from '../../routes/dcl-destinations.js'
import { virviSigner } from '../dcl/entity.js'
import {
  DeployerError, markFailed, prepareSignedDeploy, startVirviDeploy, worldChanged, type Deployment, type Destination,
} from '../dcl/world-deployer.js'
import { OWNER_ERROR_MESSAGES, type SceneImportRow } from './imports.js'
import { ImportError, worldNameOf } from './scene-zip.js'

/**
 * Deploying an import's build to the World its scene.json names (Ruling R1). When the build finishes, only a World
 * where Virvi holds the grant deploys on its own (`deployImport`); any other import stays `built` until the creator
 * starts it (`startImportDeploy`, from POST /api/imports/:id/deploy) and signs. The World's destination is set up (or
 * taken over) at the moment a deploy starts: adopted, since the code is the owner's, and pointing at the import with
 * `pending_import_id`, which world-deployer.ts deploys from and clears once the deployment ends.
 */

export const NOT_DEPLOYABLE = 'This import has nothing to deploy right now.'
const FILES_GONE = "The built scene's files are gone. Upload it again."
const WORLD_IN_USE = "This World is connected to a Virvi scene you can't manage."
const GENERIC = 'Something went wrong on our side while deploying. Try again in a few minutes.'

export type StartedImportDeploy =
  | { mode: 'virvi'; deployment: Deployment }
  | { mode: 'sign'; deployment: Deployment; payload: string; expiresAt: string }

const granted = (d: Pick<Destination, 'mode' | 'grantedAt'>) => d.mode === 'virvi' && !!d.grantedAt

/** Errors a retry can't fix: the stored build itself is unusable, so the import fails. Any other start error leaves it `built`. */
const PERMANENT = new Set(['import_files_missing', 'world_changed', 'bad_scene_json'])

/** The base and parcels of the built scene.json, which must name the import's World (a stored build is never trusted). */
async function builtPlot(row: SceneImportRow): Promise<{ base: string; parcels: string[] }> {
  const obj = row.builtKeyPrefix ? await getImportStore().get(`${row.builtKeyPrefix}scene.json`) : null
  if (!obj) throw new ImportError(409, 'import_files_missing', FILES_GONE)
  let json: { scene?: { parcels?: unknown; base?: unknown }; worldConfiguration?: { name?: unknown } } | undefined
  try {
    json = JSON.parse(obj.body.toString('utf8')) as typeof json
  } catch { /* checked below */ }
  const named = worldNameOf(json?.worldConfiguration?.name)
  if (named !== row.worldName) throw new ImportError(422, 'world_changed', worldChanged(named, row.worldName))
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
 * (PERMANENT) fails it. The built files stay.
 */
async function startFailed(importId: string, err: unknown): Promise<void> {
  const known = err instanceof ImportError || err instanceof DeployerError
  const code = known ? err.code : 'deploy_failed'
  const message = known ? err.message : GENERIC
  const now = new Date()
  const set = PERMANENT.has(code)
    ? { status: 'failed' as const, errorCode: code, errorMessage: message, finishedAt: now, updatedAt: now }
    : { status: 'built' as const, errorCode: code, errorMessage: message, updatedAt: now }
  await db.update(sceneImports).set(set).where(notYetDeploying(importId))
}

/**
 * Starts the deploy of a `built` import, or one whose signature window passed: Virvi-signed on a granted Virvi-mode
 * World (import `deploying`), otherwise prepared for the owner to sign (import `awaiting_signature`). The import must
 * still be its World's newest with its status unchanged, checked under the lock uploads take, or this is 409
 * not_deployable. `by` must own the World. A deploy that fails to start goes back to `built` with the error (see
 * startFailed). With `virviOnly`, an import Virvi can't deploy itself (it would need a signature) is left alone and
 * null is returned.
 */
export async function startImportDeploy(row: SceneImportRow, by: string, opts: { virviOnly?: boolean; claimed?: boolean } = {}): Promise<StartedImportDeploy | null> {
  const from = row.status
  const startable = from === 'built' || from === 'awaiting_signature' || (opts.claimed && from === 'deploying' && !row.deploymentId)
  if (!startable) throw new ImportError(409, 'not_deployable', NOT_DEPLOYABLE)
  const existing = await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.worldName, row.worldName) })
  const virvi = !!existing && granted(existing)
  if (opts.virviOnly && !(virvi && virviSigner())) return null
  try {
    return await begin(row, by, virvi, opts)
  } catch (err) {
    // Not ours to touch when the import moved on meanwhile
    if (!(err instanceof ImportError && err.code === 'not_deployable')) await startFailed(row.id, err)
    throw err
  }
}

async function begin(row: SceneImportRow, by: string, virvi: boolean, opts: { virviOnly?: boolean }): Promise<StartedImportDeploy | null> {
  const from = row.status
  const plot = await builtPlot(row)
  const owner = await worldOwner(by, row.worldName)
  if (virvi && !virviSigner()) throw new DeployerError(503, 'virvi_deploys_unavailable', 'Virvi deploys are not available right now')
  // A signature that came too late must not deploy the old preparation
  if (from === 'awaiting_signature' && row.deploymentId) {
    await markFailed(row.deploymentId, new DeployerError(409, 'expired', 'This publish request expired.'), 'awaiting_signature')
  }

  const dest = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scene-import:${row.worldName}`}))`)
    const now = await tx.query.sceneImports.findFirst({ where: eq(sceneImports.id, row.id), columns: { status: true } })
    const newest = await tx.query.sceneImports.findFirst({
      where: eq(sceneImports.worldName, row.worldName), orderBy: [desc(sceneImports.createdAt)], columns: { id: true },
    })
    if (now?.status !== from || newest?.id !== row.id) return null
    const at = new Date()
    const [d] = await tx.insert(dclWorldDestinations).values({
      sceneId: row.sceneId, ownerUserId: by, ownerWallet: owner, worldName: row.worldName, ...plot,
      mode: 'sign', adopted: true, pendingImportId: row.id,
    }).onConflictDoUpdate({
      target: dclWorldDestinations.worldName,
      set: { ...plot, adopted: true, pendingImportId: row.id, ownerWallet: owner, ownerUserId: by, updatedAt: at },
      setWhere: eq(dclWorldDestinations.sceneId, row.sceneId),
    }).returning()
    if (!d) throw new ImportError(409, 'world_in_use', WORLD_IN_USE)
    await tx.update(sceneImports).set({ destinationId: d.id, updatedAt: at }).where(eq(sceneImports.id, row.id))
    return d
  })
  if (!dest) {
    if (opts.virviOnly) return null
    throw new ImportError(409, 'not_deployable', NOT_DEPLOYABLE)
  }

  try {
    if (granted(dest)) return { mode: 'virvi', deployment: await startVirviDeploy(dest.id, by) }
    return { mode: 'sign', ...(await prepareSignedDeploy(dest.id, by)) }
  } catch (err) {
    // Nothing started: the World doesn't wait on this import
    await db.update(dclWorldDestinations).set({ pendingImportId: null, updatedAt: new Date() })
      .where(and(eq(dclWorldDestinations.id, dest.id), eq(dclWorldDestinations.pendingImportId, row.id)))
    throw err
  }
}

/**
 * What runs when an import's build is stored (setOnBuildDone): a granted Virvi-mode World deploys it now; anything
 * else stays `built` for the creator. An error is recorded on the import (startFailed) and rethrown for the caller's log.
 */
export async function deployImport(importId: string): Promise<void> {
  const row = await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, importId) })
  if (row?.status !== 'built') return
  const dest = await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.worldName, row.worldName) })
  if (!dest || !granted(dest) || !virviSigner()) return
  // Ruling R24: claimed before anything slow, so the creator is never offered a Deploy this is already doing
  const [claimed] = await db.update(sceneImports).set({ status: 'deploying', updatedAt: new Date() })
    .where(and(eq(sceneImports.id, importId), eq(sceneImports.status, 'built'), isNull(sceneImports.deploymentId)))
    .returning()
  if (!claimed) return
  const started = await startImportDeploy(claimed, claimed.userId, { virviOnly: true, claimed: true })
  // Nothing started and nothing failed (the grant or the World moved on): the creator deploys it
  if (!started) {
    await db.update(sceneImports).set({ status: 'built', updatedAt: new Date() })
      .where(and(eq(sceneImports.id, importId), eq(sceneImports.status, 'deploying'), isNull(sceneImports.deploymentId)))
  }
}
