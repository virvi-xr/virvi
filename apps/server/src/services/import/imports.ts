import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import type { ImportLocation, SceneImportView } from '@virvixr/shared'
import { db } from '../../db/connection.js'
import { dclWorldDestinations, sceneDeployments, sceneImports, scenes } from '../../db/schema.js'
import { insertSceneWithDefaultPreset } from '../../scenes/create.js'
import { getImportStore } from '../../storage/private-store.js'
import { DEPLOY_WINDOW_MS, DeployerError, markFailed } from '../dcl/world-deployer.js'
import { ImportError } from './scene-zip.js'

/**
 * Scene import rows: the view the web polls, and the per-World rules for a new upload (one import at a time, and a
 * newer upload replaces one that only waits for the creator).
 */

export type SceneImportRow = typeof sceneImports.$inferSelect
type DeploymentRow = Pick<typeof sceneDeployments.$inferSelect, 'status' | 'assetBundle' | 'createdAt'>

/** Statuses that hold the World: a second upload is 409 import_in_progress. */
const BLOCKING = ['uploaded', 'building', 'deploying'] as const
/** Statuses a new upload replaces (Ruling R2): nothing runs, the creator just hasn't deployed or signed. */
const SUPERSEDED = ['built', 'awaiting_signature'] as const
export const SUPERSEDED_MESSAGE = 'A newer upload replaced this one.'
/** Sentences for ownerFor's codes, which carry none. */
export const OWNER_ERROR_MESSAGES: Record<string, string> = {
  not_world_owner: 'None of your verified wallets owns this World.',
  world_unreachable: "Decentraland's Worlds server didn't answer. Try again in a few minutes.",
}
/** How much of the build log the view carries; the log route has the whole of it. */
const LOG_TAIL_BYTES = 4096

export const sourceKey = (importId: string) => `imports/${importId}/source.zip`
/** The upload as sent, kept for the Virvi-free backup (Ruling R7). */
export const originalKey = (importId: string) => `imports/${importId}/original.zip`

/** Whether a signed deploy's window has passed (or it ended): the creator can start the deploy again. */
function signingOver(dep: DeploymentRow | null, now: number): boolean {
  if (!dep || dep.status === 'failed') return true
  if (dep.status !== 'awaiting_signature') return false
  const ts = (dep.assetBundle as { timestamp?: unknown } | null)?.timestamp
  const started = typeof ts === 'number' ? ts : dep.createdAt.getTime()
  return now - started > DEPLOY_WINDOW_MS
}

/** The import row's location: a World by name, or Genesis City parcels by base and footprint. */
export function locationOf(row: Pick<SceneImportRow, 'locationKind' | 'worldName' | 'base' | 'parcels'>): ImportLocation {
  return row.locationKind === 'parcels'
    ? { kind: 'parcels', base: row.base ?? '', parcels: row.parcels }
    : { kind: 'world', world: row.worldName ?? '' }
}

/** `world:<name>` or `gc:<base>`. */
export function locationKeyOf(loc: ImportLocation): string {
  return loc.kind === 'world' ? `world:${loc.world}` : `gc:${loc.base}`
}

const asLocation = (loc: ImportLocation | string): ImportLocation => (typeof loc === 'string' ? { kind: 'world', world: loc } : loc)

/**
 * The lock uploads and deploy starts take for a location, held to the end of `tx`: the World's, or one per parcel in
 * sorted order, so overlapping footprints serialise without deadlocking.
 */
export async function lockLocation(tx: Pick<typeof db, 'execute'>, loc: ImportLocation): Promise<void> {
  if (loc.kind === 'world') {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scene-import:${locationKeyOf(loc)}`}))`)
    return
  }
  for (const p of [...new Set(loc.parcels)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scene-import:gc:${p}`}))`)
  }
}

/** Rows of the same location: the World's name, or any shared parcel. */
export function sameLocation(loc: ImportLocation) {
  return loc.kind === 'world'
    ? and(eq(sceneImports.locationKind, 'world'), eq(sceneImports.worldName, loc.world))
    : and(eq(sceneImports.locationKind, 'parcels'), sql`${sceneImports.parcels} && ${pgArray(loc.parcels)}`)
}

const pgArray = (items: string[]) => sql`ARRAY[${sql.join(items.map((p) => sql`${p}`), sql`, `)}]::text[]`

/** `deployment` is the import's deployment row, needed to tell whether an awaiting signature has expired. */
export function importView(row: SceneImportRow, logTail: string | null, deployment: DeploymentRow | null = null, now = Date.now()): SceneImportView {
  return {
    id: row.id,
    sceneId: row.sceneId,
    worldName: row.worldName,
    location: locationOf(row),
    kind: row.kind as SceneImportView['kind'],
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    deploymentId: row.deploymentId,
    destinationId: row.destinationId,
    canDeploy: row.status === 'built' || (row.status === 'awaiting_signature' && signingOver(deployment, now)),
    logTail,
    filesExpired: row.filesDeletedAt !== null,
    virviAlreadyPresent: row.virviAlreadyPresent,
    createdAt: row.createdAt.toISOString(),
  }
}

/** The last few KB of the stored build log, from a line start when it was cut. */
export async function readLogTail(row: SceneImportRow): Promise<string | null> {
  if (!row.logKey || row.filesDeletedAt) return null
  const obj = await getImportStore().get(row.logKey)
  if (!obj) return null
  if (obj.body.length <= LOG_TAIL_BYTES) return obj.body.toString('utf8')
  const tail = obj.body.subarray(obj.body.length - LOG_TAIL_BYTES)
  const nl = tail.indexOf(10)
  return tail.subarray(nl >= 0 && nl < tail.length - 1 ? nl + 1 : 0).toString('utf8')
}

/** The view with its log tail and, while it waits for a signature, its deployment. */
export async function loadImportView(row: SceneImportRow): Promise<SceneImportView> {
  const [logTail, deployment] = await Promise.all([
    readLogTail(row),
    row.status === 'awaiting_signature' && row.deploymentId
      ? db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, row.deploymentId), columns: { status: true, assetBundle: true, createdAt: true } })
      : Promise.resolve(undefined),
  ])
  return importView(row, logTail, deployment ?? null)
}

/** The newest import of a World whose Virvi scene the caller may reuse (checked by the caller). */
export async function latestImportFor(location: ImportLocation | string): Promise<SceneImportRow | null> {
  const loc = asLocation(location)
  const where = loc.kind === 'world'
    ? and(eq(sceneImports.locationKind, 'world'), eq(sceneImports.worldName, loc.world))
    : and(eq(sceneImports.locationKind, 'parcels'), eq(sceneImports.base, loc.base))
  return (await db.query.sceneImports.findFirst({ where, orderBy: [desc(sceneImports.createdAt)] })) ?? null
}

/**
 * Records a new upload for `world`, serialised per World with an advisory lock: an import that is uploaded, building or
 * deploying refuses it (409 import_in_progress); one that is built or awaiting a signature is failed as superseded, and
 * its prepared deployment with it.
 * `scene` is an existing Virvi scene's id, or the name of a new one (with a Default preset) for the importer.
 */
export async function createImport(input: {
  userId: string
  /** Where it deploys. A World-only caller may pass `world` (its name) instead. */
  location?: ImportLocation
  world?: string
  kind: 'creator-hub' | 'sdk7'
  scene: { id: string } | { newName: string }
  virviAlreadyPresent?: boolean
}): Promise<SceneImportRow> {
  const id = randomUUID()
  const loc = input.location ?? (input.world ? asLocation(input.world) : null)
  if (!loc) throw new Error('createImport needs a location or a world')
  const { row, superseded } = await db.transaction(async (tx) => {
    await lockLocation(tx, loc)
    const busy = await tx.query.sceneImports.findFirst({
      where: and(sameLocation(loc), inArray(sceneImports.status, [...BLOCKING])),
      columns: { id: true },
    })
    if (busy) throw new ImportError(409, 'import_in_progress', loc.kind === 'world' ? 'This World already has an import under way. Wait for it to finish, then upload again.' : 'These parcels already have an import under way. Wait for it to finish, then upload again.')
    const now = new Date()
    const superseded = await tx.update(sceneImports).set({
      status: 'failed', errorCode: 'superseded', errorMessage: SUPERSEDED_MESSAGE, buildTokenHash: null, finishedAt: now, updatedAt: now,
    }).where(and(sameLocation(loc), inArray(sceneImports.status, [...SUPERSEDED])))
      .returning({ id: sceneImports.id, deploymentId: sceneImports.deploymentId })
    // Ruling R16: the World never waits on a superseded import
    if (superseded.length) {
      await tx.update(dclWorldDestinations).set({ pendingImportId: null, updatedAt: now })
        .where(inArray(dclWorldDestinations.pendingImportId, superseded.map((s) => s.id)))
    }

    let sceneId: string
    if ('id' in input.scene) {
      sceneId = input.scene.id
    } else {
      ;({ sceneId } = await insertSceneWithDefaultPreset(tx, input.userId, input.scene.newName))
    }
    const [row] = await tx.insert(sceneImports).values({
      id, userId: input.userId, sceneId, ...(loc.kind === 'world' ? { worldName: loc.world } : { locationKind: 'parcels' as const, base: loc.base, parcels: loc.parcels }),
      kind: input.kind, sourceKey: sourceKey(id),
      virviAlreadyPresent: input.virviAlreadyPresent ?? false,
    }).returning()
    return { row, superseded }
  })
  // A superseded import's prepared deploy can no longer be signed (the signed submit also checks the import)
  for (const s of superseded) {
    if (s.deploymentId) await markFailed(s.deploymentId, new DeployerError(409, 'superseded', SUPERSEDED_MESSAGE), 'awaiting_signature')
  }
  return row
}

/**
 * The imports whose rows go when an account (its own imports, and every import on its scenes) or a scene is deleted.
 * Read before the delete; their files are removed after it with deleteImportFiles.
 */
export async function importsGoingWith(by: { userId: string } | { sceneId: string }): Promise<string[]> {
  const where = 'sceneId' in by
    ? eq(sceneImports.sceneId, by.sceneId)
    : or(eq(sceneImports.userId, by.userId), inArray(sceneImports.sceneId, db.select({ id: scenes.id }).from(scenes).where(eq(scenes.ownerId, by.userId))))
  return (await db.select({ id: sceneImports.id }).from(sceneImports).where(where)).map((r) => r.id)
}

/**
 * Deletes `imports/<id>/` (source, build, log) of each import: a creator's private code must not outlive their account
 * or scene. Best effort: a failure is logged, and the retention sweep removes what's left once its row is gone.
 */
export async function deleteImportFiles(ids: string[]): Promise<void> {
  if (!ids.length) return
  let store
  try {
    store = getImportStore()
  } catch {
    return // no bucket: nothing was kept
  }
  for (const id of ids) {
    await store.deletePrefix(`imports/${id}/`)
      .catch((err) => console.error(`[scene-import] deleting the files of import ${id} failed:`, err instanceof Error ? err.message : err))
  }
}

/** Fails an import that never got its build going (storing the source or starting the build threw). */
export async function failImport(importId: string, code: string, message: string): Promise<void> {
  const now = new Date()
  await db.update(sceneImports).set({ status: 'failed', errorCode: code, errorMessage: message, buildTokenHash: null, finishedAt: now, updatedAt: now })
    .where(and(eq(sceneImports.id, importId), inArray(sceneImports.status, ['uploaded', 'building'])))
}
