import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { sceneImports } from '../../db/schema.js'
import { getImportStore } from '../../storage/private-store.js'

/**
 * What the import store keeps, and for how long (Ruling R27). Run once a day.
 *
 * - `imports/<id>/` (source.zip, built/, build.log): deleted 30 days after the import ended (`deployed` or `failed`,
 *   superseded included, by `updated_at`). The row stays, with `files_deleted_at` set, so the page can say so.
 * - `imports/<id>/` whose row is gone (the account or scene was deleted and deleting its files failed, or the server
 *   stopped in between), once its newest object is over an hour old.
 * - `deployed/<hash>`: kept while a destination's live deployment, or any deployment from the last 30 days, lists the
 *   hash in its `assetBundle.content`; the rest go. A download of an older deploy then reads from the Worlds server.
 *   An object written within the last hour is never deleted, so a deploy keeping its files right now is safe.
 */

export const RETENTION_MS = 30 * 24 * 60 * 60_000
export const RETENTION_SWEEP_MS = 24 * 60 * 60_000
/** Objects younger than this are left alone, whatever references them. */
export const MIN_OBJECT_AGE_MS = 60 * 60_000
export const FILES_EXPIRED = "This import's files were deleted after 30 days."
const DELETE_BATCH = 1000

/** Deletes the files of imports that ended more than 30 days before `now`; how many imports. */
export async function sweepImportFiles(now: Date): Promise<number> {
  const store = getImportStore()
  const ended = await db.select({ id: sceneImports.id }).from(sceneImports).where(and(
    inArray(sceneImports.status, ['deployed', 'failed']),
    isNull(sceneImports.filesDeletedAt),
    lt(sceneImports.updatedAt, new Date(now.getTime() - RETENTION_MS)),
  ))
  let n = 0
  for (const { id } of ended) {
    try {
      await store.deletePrefix(`imports/${id}/`)
      await db.update(sceneImports).set({ filesDeletedAt: now }).where(and(eq(sceneImports.id, id), isNull(sceneImports.filesDeletedAt)))
      n++
    } catch (err) {
      console.error(`[retention] deleting the files of import ${id} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return n
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Deletes `imports/<id>/` prefixes with no `scene_imports` row, once nothing under them is newer than an hour; how many. */
export async function sweepOrphanedImports(now: Date): Promise<number> {
  const store = getImportStore()
  const newest = new Map<string, number>()
  for (const o of await store.list('imports/')) {
    const id = o.key.split('/')[1]
    if (!id || !UUID.test(id)) continue
    // Undated objects count as fresh: the prefix stays
    const at = o.modifiedAt?.getTime() ?? Infinity
    newest.set(id, Math.max(newest.get(id) ?? -Infinity, at))
  }
  const old = [...newest].filter(([, at]) => at < now.getTime() - MIN_OBJECT_AGE_MS).map(([id]) => id)
  let n = 0
  for (let i = 0; i < old.length; i += DELETE_BATCH) {
    const batch = old.slice(i, i + DELETE_BATCH)
    const rows = new Set((await db.select({ id: sceneImports.id }).from(sceneImports).where(inArray(sceneImports.id, batch))).map((r) => r.id))
    for (const id of batch) {
      if (rows.has(id)) continue
      await store.deletePrefix(`imports/${id}/`)
      n++
    }
  }
  return n
}

/** Every hash a live deployment or one from the last 30 days lists in its content. */
async function referencedHashes(now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - RETENTION_MS)
  const rows = await db.execute<{ hash: string }>(sql`
    SELECT DISTINCT c->>'hash' AS hash
    FROM scene_deployments d
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(d.asset_bundle->'content') = 'array' THEN d.asset_bundle->'content' ELSE '[]'::jsonb END
    ) AS c
    WHERE d.created_at > ${since.toISOString()}::timestamptz
       OR EXISTS (
         SELECT 1 FROM dcl_world_destinations w
         WHERE w.id = d.destination_id AND w.last_entity_id IS NOT NULL AND w.last_entity_id = d.catalyst_entity_id
       )`)
  return new Set((rows as unknown as Array<{ hash: string | null }>).flatMap((r) => (r.hash ? [r.hash] : [])))
}

/** Deletes `deployed/<hash>` objects nothing keeps (see above); how many. */
export async function sweepDeployedFiles(now: Date): Promise<number> {
  const store = getImportStore()
  const keep = await referencedHashes(now)
  const freshAfter = now.getTime() - MIN_OBJECT_AGE_MS
  const doomed = (await store.list('deployed/')).filter((o) => {
    if (keep.has(o.key.slice('deployed/'.length))) return false
    // A store that can't date its objects deletes nothing: a fresh one may be a deploy keeping files right now
    return !!o.modifiedAt && o.modifiedAt.getTime() < freshAfter
  }).map((o) => o.key)
  for (let i = 0; i < doomed.length; i += DELETE_BATCH) await store.deleteKeys(doomed.slice(i, i + DELETE_BATCH))
  return doomed.length
}

export async function sweepRetention(now: Date): Promise<{ imports: number; deployed: number }> {
  try {
    getImportStore()
  } catch {
    return { imports: 0, deployed: 0 } // no bucket configured: nothing is kept, so nothing to delete
  }
  const imports = (await sweepImportFiles(now)) + (await sweepOrphanedImports(now))
  const deployed = await sweepDeployedFiles(now)
  return { imports, deployed }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startRetentionSweep(ms = RETENTION_SWEEP_MS): void {
  if (timer) return
  let running = false
  timer = setInterval(() => {
    if (running) return
    running = true
    sweepRetention(new Date())
      .then((r) => { if (r.imports || r.deployed) console.log(`[retention] deleted the files of ${r.imports} imports and ${r.deployed} deployed files`) })
      .catch((err) => console.error('[retention] failed:', err))
      .finally(() => { running = false })
  }, ms)
  timer.unref?.()
}
