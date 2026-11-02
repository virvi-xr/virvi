import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { SceneImportView } from '@virvixr/shared'
import { db } from '../../db/connection.js'
import { sceneDeployments, sceneImports, scenePresets, scenes } from '../../db/schema.js'
import { getImportStore } from '../../storage/private-store.js'
import { DEPLOY_WINDOW_MS } from '../dcl/world-deployer.js'
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
/** How much of the build log the view carries; the log route has the whole of it. */
const LOG_TAIL_BYTES = 4096

export const sourceKey = (importId: string) => `imports/${importId}/source.zip`

/** Whether a signed deploy's window has passed (or it ended): the creator can start the deploy again. */
function signingOver(dep: DeploymentRow | null, now: number): boolean {
  if (!dep || dep.status === 'failed') return true
  if (dep.status !== 'awaiting_signature') return false
  const ts = (dep.assetBundle as { timestamp?: unknown } | null)?.timestamp
  const started = typeof ts === 'number' ? ts : dep.createdAt.getTime()
  return now - started > DEPLOY_WINDOW_MS
}

/** `deployment` is the import's deployment row, needed to tell whether an awaiting signature has expired. */
export function importView(row: SceneImportRow, logTail: string | null, deployment: DeploymentRow | null = null, now = Date.now()): SceneImportView {
  return {
    id: row.id,
    sceneId: row.sceneId,
    worldName: row.worldName,
    kind: row.kind as SceneImportView['kind'],
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    deploymentId: row.deploymentId,
    destinationId: row.destinationId,
    canDeploy: row.status === 'built' || (row.status === 'awaiting_signature' && signingOver(deployment, now)),
    logTail,
    createdAt: row.createdAt.toISOString(),
  }
}

/** The last few KB of the stored build log, from a line start when it was cut. */
export async function readLogTail(row: SceneImportRow): Promise<string | null> {
  if (!row.logKey) return null
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
export async function latestImportFor(world: string): Promise<SceneImportRow | null> {
  return (await db.query.sceneImports.findFirst({ where: eq(sceneImports.worldName, world), orderBy: [desc(sceneImports.createdAt)] })) ?? null
}

/**
 * Records a new upload for `world`, serialised per World with an advisory lock: an import that is uploaded, building or
 * deploying refuses it (409 import_in_progress); one that is built or awaiting a signature is failed as superseded.
 * `scene` is an existing Virvi scene's id, or the name of a new one (with a Default preset) for the importer.
 */
export async function createImport(input: {
  userId: string
  world: string
  kind: 'creator-hub' | 'sdk7'
  scene: { id: string } | { newName: string }
}): Promise<SceneImportRow> {
  const id = randomUUID()
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scene-import:${input.world}`}))`)
    const busy = await tx.query.sceneImports.findFirst({
      where: and(eq(sceneImports.worldName, input.world), inArray(sceneImports.status, [...BLOCKING])),
      columns: { id: true },
    })
    if (busy) throw new ImportError(409, 'import_in_progress', 'This World already has an import under way. Wait for it to finish, then upload again.')
    const now = new Date()
    await tx.update(sceneImports).set({
      status: 'failed', errorCode: 'superseded', errorMessage: SUPERSEDED_MESSAGE, buildTokenHash: null, finishedAt: now, updatedAt: now,
    }).where(and(eq(sceneImports.worldName, input.world), inArray(sceneImports.status, [...SUPERSEDED])))

    let sceneId: string
    if ('id' in input.scene) {
      sceneId = input.scene.id
    } else {
      // As POST /api/wizard/scenes: the scene, its Default preset, the preset made active
      const [scene] = await tx.insert(scenes).values({ ownerId: input.userId, name: input.scene.newName }).returning({ id: scenes.id })
      const [preset] = await tx.insert(scenePresets).values({ sceneId: scene.id, name: 'Default' }).returning({ id: scenePresets.id })
      await tx.update(scenes).set({ activePresetId: preset.id }).where(eq(scenes.id, scene.id))
      sceneId = scene.id
    }
    const [row] = await tx.insert(sceneImports).values({
      id, userId: input.userId, sceneId, worldName: input.world, kind: input.kind, sourceKey: sourceKey(id),
    }).returning()
    return row
  })
}

/** Fails an import that never got its build going (storing the source or starting the build threw). */
export async function failImport(importId: string, code: string, message: string): Promise<void> {
  const now = new Date()
  await db.update(sceneImports).set({ status: 'failed', errorCode: code, errorMessage: message, buildTokenHash: null, finishedAt: now, updatedAt: now })
    .where(and(eq(sceneImports.id, importId), inArray(sceneImports.status, ['uploaded', 'building'])))
}
