import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import type { ImportLocation, SceneImportView } from '@virvixr/shared'
import { config } from '../../config.js'
import { db } from '../../db/connection.js'
import { dclWorldDestinations, sceneDeployments, sceneImports, scenes, users } from '../../db/schema.js'
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

/**
 * Real (not sandbox) rows of the same location: the World's name, or any shared parcel. A trial's sandbox import is
 * never one of them, so it never holds, supersedes or outranks an account's import there.
 */
export function sameLocation(loc: ImportLocation) {
  return loc.kind === 'world'
    ? and(eq(sceneImports.locationKind, 'world'), eq(sceneImports.worldName, loc.world), eq(sceneImports.sandbox, false))
    : and(eq(sceneImports.locationKind, 'parcels'), sql`${sceneImports.parcels} && ${pgArray(loc.parcels)}`, eq(sceneImports.sandbox, false))
}

const pgArray = (items: string[]) => sql`ARRAY[${sql.join(items.map((p) => sql`${p}`), sql`, `)}]::text[]`

type SceneThumbnail = Pick<typeof scenes.$inferSelect, 'thumbnailUrl' | 'thumbnailSource'>

/**
 * `deployment` is the import's deployment row, needed to tell whether an awaiting signature has expired; `scene` the
 * scene's thumbnail as it is now (LIV-89: the import page shows it, whoever set it since).
 */
export function importView(
  row: SceneImportRow, logTail: string | null, deployment: DeploymentRow | null = null, now = Date.now(), scene: SceneThumbnail | null = null,
): SceneImportView {
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
    thumbnail: {
      outcome: row.thumbnailOutcome ?? null,
      note: row.thumbnailNote,
      url: scene?.thumbnailUrl ?? null,
      // LIV-88's thumbnails from before the source was recorded are uploads
      source: scene?.thumbnailUrl ? (scene.thumbnailSource ?? 'upload') : null,
    },
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

/** The view with its log tail, its scene's thumbnail and, while it waits for a signature, its deployment. */
export async function loadImportView(row: SceneImportRow): Promise<SceneImportView> {
  const [logTail, deployment, scene] = await Promise.all([
    readLogTail(row),
    row.status === 'awaiting_signature' && row.deploymentId
      ? db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, row.deploymentId), columns: { status: true, assetBundle: true, createdAt: true } })
      : Promise.resolve(undefined),
    db.query.scenes.findFirst({ where: eq(scenes.id, row.sceneId), columns: { thumbnailUrl: true, thumbnailSource: true } }),
  ])
  return importView(row, logTail, deployment ?? null, Date.now(), scene ?? null)
}

/** The newest real (not sandbox) import of a World whose Virvi scene the caller may reuse (checked by the caller). */
export async function latestImportFor(location: ImportLocation | string): Promise<SceneImportRow | null> {
  const loc = asLocation(location)
  const where = loc.kind === 'world'
    ? and(eq(sceneImports.locationKind, 'world'), eq(sceneImports.worldName, loc.world), eq(sceneImports.sandbox, false))
    : and(eq(sceneImports.locationKind, 'parcels'), eq(sceneImports.base, loc.base), eq(sceneImports.sandbox, false))
  return (await db.query.sceneImports.findFirst({ where, orderBy: [desc(sceneImports.createdAt)] })) ?? null
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Superseded = Array<{ id: string; deploymentId: string | null }>

/**
 * Takes `loc` for a new import, inside `tx` and its location lock: an import that is uploaded, building or deploying
 * refuses it (409 import_in_progress); those that are built or awaiting a signature (other than `except`) are failed as
 * superseded, and no destination waits on them any more. Their prepared deployments are failed by `failSuperseded` once
 * the transaction is over.
 */
async function takePlace(tx: Tx, loc: ImportLocation, except?: string): Promise<Superseded> {
  await lockLocation(tx, loc)
  const busy = await tx.query.sceneImports.findFirst({
    where: and(sameLocation(loc), inArray(sceneImports.status, [...BLOCKING])),
    columns: { id: true },
  })
  if (busy) throw new ImportError(409, 'import_in_progress', loc.kind === 'world' ? 'This World already has an import under way. Wait for it to finish, then upload again.' : 'These parcels already have an import under way. Wait for it to finish, then upload again.')
  const now = new Date()
  const superseded = await tx.update(sceneImports).set({
    status: 'failed', errorCode: 'superseded', errorMessage: SUPERSEDED_MESSAGE, buildTokenHash: null, finishedAt: now, updatedAt: now,
  }).where(and(sameLocation(loc), inArray(sceneImports.status, [...SUPERSEDED]), except ? ne(sceneImports.id, except) : undefined))
    .returning({ id: sceneImports.id, deploymentId: sceneImports.deploymentId })
  // Ruling R16: the World never waits on a superseded import
  if (superseded.length) {
    await tx.update(dclWorldDestinations).set({ pendingImportId: null, updatedAt: now })
      .where(inArray(dclWorldDestinations.pendingImportId, superseded.map((s) => s.id)))
  }
  return superseded
}

/** A superseded import's prepared deploy can no longer be signed (the signed submit also checks the import). */
async function failSuperseded(superseded: Superseded): Promise<void> {
  for (const s of superseded) {
    if (s.deploymentId) await markFailed(s.deploymentId, new DeployerError(409, 'superseded', SUPERSEDED_MESSAGE), 'awaiting_signature')
  }
}

/**
 * Records a new upload for `world`, serialised per World with an advisory lock: an import that is uploaded, building or
 * deploying refuses it (409 import_in_progress); one that is built or awaiting a signature is failed as superseded, and
 * its prepared deployment with it.
 * `scene` is an existing Virvi scene's id, or the name of a new one (with a Default preset) for the importer.
 * `sandbox` (a trial's upload) takes none of that: no lock, no busy check, nothing superseded, always a new scene; the
 * row is invisible to its place until an account claims it (claimSandboxImport).
 */
export async function createImport(input: {
  userId: string
  /** Where it deploys. A World-only caller may pass `world` (its name) instead. */
  location?: ImportLocation
  world?: string
  kind: 'creator-hub' | 'sdk7'
  scene: { id: string } | { newName: string }
  virviAlreadyPresent?: boolean
  sandbox?: boolean
}): Promise<SceneImportRow> {
  const id = randomUUID()
  const loc = input.location ?? (input.world ? asLocation(input.world) : null)
  if (!loc) throw new Error('createImport needs a location or a world')
  const sandbox = input.sandbox ?? false
  if (sandbox && 'id' in input.scene) throw new Error('a sandbox import always gets a new scene')
  const { row, superseded } = await db.transaction(async (tx) => {
    const superseded = sandbox ? [] : await takePlace(tx, loc)
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
      sandbox,
    }).returning()
    return { row, superseded }
  })
  await failSuperseded(superseded)
  return row
}

/**
 * Brings a sandbox import into its place, as an upload would have (createImport): under the location's lock, 409
 * import_in_progress while another import runs there, 409 world_in_use / parcels_in_use when the place is connected to
 * another Virvi scene, then the place's built and awaiting imports are superseded and this one becomes a real import,
 * dated now so it is the place's newest. The caller has checked that its account may deploy there. A no-op for a real
 * import.
 */
export async function claimSandboxImport(row: SceneImportRow): Promise<SceneImportRow> {
  if (!row.sandbox) return row
  const loc = locationOf(row)
  const { claimed, superseded } = await db.transaction(async (tx) => {
    await lockLocation(tx, loc)
    const fresh = await tx.query.sceneImports.findFirst({ where: eq(sceneImports.id, row.id) })
    if (!fresh?.sandbox) return { claimed: fresh ?? row, superseded: [] as Superseded }
    const elsewhere = await tx.query.dclWorldDestinations.findFirst({
      where: and(
        loc.kind === 'world'
          ? eq(dclWorldDestinations.worldName, loc.world)
          : and(eq(dclWorldDestinations.kind, 'parcels'), sql`${dclWorldDestinations.parcels} && ${pgArray(loc.parcels)}`),
        ne(dclWorldDestinations.sceneId, row.sceneId),
      ),
      columns: { id: true },
    })
    if (elsewhere) {
      throw loc.kind === 'world'
        ? new ImportError(409, 'world_in_use', "This World is connected to a Virvi scene you can't manage.")
        : new ImportError(409, 'parcels_in_use', "These parcels are connected to a Virvi scene you can't manage.")
    }
    const superseded = await takePlace(tx, loc, row.id)
    const now = new Date()
    const [claimed] = await tx.update(sceneImports).set({ sandbox: false, createdAt: now, updatedAt: now })
      .where(and(eq(sceneImports.id, row.id), eq(sceneImports.sandbox, true))).returning()
    return { claimed, superseded }
  })
  await failSuperseded(superseded)
  return claimed
}

/**
 * Counts one more import for a trial, atomically: false once it has started TRIAL_IMPORTS (or it isn't a trial), so
 * two uploads at once with one left can't both pass.
 */
export async function reserveTrialImport(userId: string): Promise<boolean> {
  const rows = await db.update(users).set({ trialImports: sql`${users.trialImports} + 1` })
    .where(and(eq(users.id, userId), eq(users.isTrial, true), sql`${users.trialImports} < ${config.trialImports}`))
    .returning({ id: users.id })
  return rows.length > 0
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
