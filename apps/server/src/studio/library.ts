import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, studioDesigns, studioEntitlements, studioRevisions } from '../db/schema.js'
import { glbStats } from '../catalog/glb-stats.js'
import { createStorage, type StorageProvider } from '../storage/index.js'
import { getStudioStore, jobFileKey } from './store.js'

/**
 * A paid scene piece (a building, furniture or decor) goes into its designer's asset library: each GLB copied to public
 * storage as a private row, measured from the file itself, with the finalize thumbnail and any dcl-sittables seats.
 * Paid pieces don't count against the upload storage quota. A row per revision: a scene already using an earlier one
 * keeps it.
 */

let override: StorageProvider | null = null
let made: StorageProvider | null = null
/** Tests swap in a fake; null goes back to the configured storage. */
export function setLibraryStorage(s: StorageProvider | null) { override = s }
const storage = () => override ?? (made ??= createStorage())

/**
 * The new rows' ids, or the ones added before (it never adds twice). [] for anything but a scene piece. The entitlement
 * row stays locked while the files copy, so the finalize result and the sweep can't both add the same piece.
 */
export async function addToLibrary(entitlementId: string, now: Date): Promise<string[]> {
  return db.transaction(async (tx) => {
    const [ent] = await tx.select().from(studioEntitlements).where(eq(studioEntitlements.id, entitlementId)).for('update')
    if (!ent || ent.status !== 'ready') return []
    if (ent.assetItemIds) return ent.assetItemIds
    const [design] = await tx.select().from(studioDesigns).where(eq(studioDesigns.id, ent.designId))
    const [rev] = await tx.select().from(studioRevisions).where(eq(studioRevisions.id, ent.revisionId))
    if (design?.kind !== 'scene' || !rev) return []
    const meta = (rev.meta ?? {}) as { name?: unknown; description?: unknown; kind?: unknown; type?: unknown }
    const base = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim().slice(0, 190) : ent.category
    const name = rev.number > 1 ? `${base} (revision ${rev.number})` : base
    const prefix = `pieces/${ent.category}/`
    const glbs = rev.files.filter((f) => f.startsWith(prefix) && f.toLowerCase().endsWith('.glb'))
    const seatsFile = rev.files.find((f) => f.startsWith(prefix) && f.endsWith('.sittables.json'))
    const studio = getStudioStore()
    let sittables: unknown = null
    if (seatsFile) {
      const obj = await studio.get(jobFileKey(design.id, rev.jobId, seatsFile))
      try { sittables = obj ? JSON.parse(obj.body.toString('utf8')) : null } catch { sittables = null }
    }
    let thumbnailUrl: string | null = null
    const thumb = ent.jobId ? await studio.get(jobFileKey(design.id, ent.jobId, `final/${ent.category}/thumbnail.png`)) : null
    if (thumb) thumbnailUrl = await storage().upload(`assets/${design.ownerId}/${randomUUID()}.png`, thumb.body, 'image/png')
    const ids: string[] = []
    for (const file of glbs) {
      const sourceRef = `studio:${ent.id}:${file.slice(prefix.length)}`
      const [had] = await tx.select({ id: assetLibraryItems.id }).from(assetLibraryItems)
        .where(and(eq(assetLibraryItems.sourceRef, sourceRef), isNull(assetLibraryItems.packId)))
      if (had) { ids.push(had.id); continue }
      const obj = await studio.get(jobFileKey(design.id, rev.jobId, file))
      if (!obj) throw new Error(`${file} is missing from the studio store`)
      const stats = await glbStats(obj.body, { visibleOnly: true })
      const storageKey = `assets/${design.ownerId}/${randomUUID()}.glb`
      const cdnUrl = await storage().upload(storageKey, obj.body, 'model/gltf-binary')
      const [row] = await tx.insert(assetLibraryItems).values({
        name, description: typeof meta.description === 'string' ? meta.description.slice(0, 1000) : null,
        category: meta.kind === 'building' ? 'building' : 'furniture',
        tags: typeof meta.type === 'string' && meta.type ? [meta.type.slice(0, 40)] : null,
        storageKey, cdnUrl, thumbnailUrl, fileSizeBytes: obj.body.length, triangleCount: stats.triangles, dimensions: stats.bbox,
        isPublic: false, uploadedBy: design.ownerId, sourceRef, sittables, createdAt: now,
      }).returning({ id: assetLibraryItems.id })
      ids.push(row.id)
    }
    await tx.update(studioEntitlements).set({ assetItemIds: ids }).where(eq(studioEntitlements.id, ent.id))
    return ids
  })
}

/** The sweep's retry: paid scene pieces whose library rows never got added. Returns how many were added now. */
export async function addMissingLibraryRows(now: Date): Promise<number> {
  const missing = await db.select({ id: studioEntitlements.id }).from(studioEntitlements)
    .innerJoin(studioDesigns, eq(studioDesigns.id, studioEntitlements.designId))
    .where(and(eq(studioEntitlements.status, 'ready'), isNull(studioEntitlements.assetItemIds), eq(studioDesigns.kind, 'scene')))
  let n = 0
  for (const { id } of missing) {
    try {
      if ((await addToLibrary(id, now)).length) n++
    } catch (err) {
      console.error('[studio] library add failed:', err instanceof Error ? err.message : err)
    }
  }
  return n
}
