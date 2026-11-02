import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { PackDisabledError, inDisabledPack } from '../catalog/visibility.js'
import { assetLibraryItems, bookings, mediaAssets, sceneLibrary, scenes, systemFlags } from '../db/schema.js'
import type { Actor } from '../auth/actor.js'
import { publishLibraryChanged } from '../realtime/bus.js'
import { getSceneAccess, hasScope } from '../auth/permissions.js'
import { createStorage } from '../storage/index.js'

export interface LibraryItem {
  id: string
  kind: 'media' | 'model'
  name: string
  contentType: string | null
  url: string
  sizeBytes: number
  bookingId: string | null
  createdAt: string
  status: 'uploading' | 'processing' | 'ready' | 'failed'
  error: string | null
}

// Booking-linked items show only while the booking is confirmed or live (the venue lifecycle job flips
// bookings to 'ended' after endsAt + grace, so status alone is the codebase's definition of active).
const ACTIVE_BOOKING = sql`(${sceneLibrary.bookingId} IS NULL OR EXISTS (SELECT 1 FROM ${bookings} b WHERE b.id = ${sceneLibrary.bookingId} AND b.status IN ('confirmed','live')))`

/** An upload still 'uploading' this long after it started is treated as abandoned. */
export const STALE_UPLOAD_MS = 15 * 60_000

/**
 * Mark abandoned in-flight uploads (still 'uploading', or 'processing' after a crash mid-store) failed, and tell
 * the scenes they're linked to; returns how many. Runs before every library read and daily.
 */
export async function expireStaleUploads(now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(mediaAssets)
    .set({ status: 'failed', error: "Upload didn't finish" })
    .where(and(inArray(mediaAssets.status, ['uploading', 'processing']), lt(mediaAssets.createdAt, new Date(now.getTime() - STALE_UPLOAD_MS))))
    .returning({ id: mediaAssets.id })
  if (rows.length === 0) return 0
  const links = await db
    .select({ id: sceneLibrary.id, sceneId: sceneLibrary.sceneId })
    .from(sceneLibrary)
    .where(inArray(sceneLibrary.mediaAssetId, rows.map((r) => r.id)))
  for (const l of links) await publishLibraryChanged(l.sceneId, l.id)
  return rows.length
}

type LibraryRow = {
  l: typeof sceneLibrary.$inferSelect
  m: typeof mediaAssets.$inferSelect | null
  a: typeof assetLibraryItems.$inferSelect | null
}

function toLibraryItem({ l, m, a }: LibraryRow): LibraryItem | null {
  // Who added an item stays server-side (the delete route checks it); viewers never see user ids.
  const base = { id: l.id, bookingId: l.bookingId, createdAt: l.createdAt.toISOString() }
  if (m) {
    return {
      ...base, kind: 'media', name: m.filename, contentType: m.contentType, url: m.publicUrl ?? '', sizeBytes: m.sizeBytes,
      status: m.status as LibraryItem['status'], error: m.error,
    }
  }
  if (a) {
    return {
      ...base, kind: 'model', name: a.name, contentType: 'model/gltf-binary', url: a.cdnUrl ?? '', sizeBytes: a.fileSizeBytes,
      status: 'ready', error: null,
    }
  }
  return null
}

function libraryQuery() {
  return db
    .select({ l: sceneLibrary, m: mediaAssets, a: assetLibraryItems })
    .from(sceneLibrary)
    .leftJoin(mediaAssets, eq(mediaAssets.id, sceneLibrary.mediaAssetId))
    .leftJoin(assetLibraryItems, eq(assetLibraryItems.id, sceneLibrary.assetItemId))
}

export async function listSceneLibrary(sceneId: string): Promise<LibraryItem[]> {
  await expireStaleUploads()
  const rows = await libraryQuery()
    .where(and(eq(sceneLibrary.sceneId, sceneId), ACTIVE_BOOKING))
    .orderBy(sql`${sceneLibrary.createdAt} desc`)
  return rows.flatMap((r) => toLibraryItem(r) ?? [])
}

/** One library entry (same shape and visibility as listSceneLibrary), or null. */
export async function getSceneLibraryItem(sceneId: string, linkId: string): Promise<LibraryItem | null> {
  await expireStaleUploads()
  const [row] = await libraryQuery()
    .where(and(eq(sceneLibrary.sceneId, sceneId), eq(sceneLibrary.id, linkId), ACTIVE_BOOKING))
    .limit(1)
  return row ? toLibraryItem(row) : null
}

export async function linkToScene(
  sceneId: string,
  item: { mediaAssetId?: string; assetItemId?: string },
  addedBy: string | null,
  bookingId: string | null = null,
): Promise<string> {
  if (item.assetItemId && (await inDisabledPack(item.assetItemId))) throw new PackDisabledError()
  const values = { sceneId, mediaAssetId: item.mediaAssetId ?? null, assetItemId: item.assetItemId ?? null, addedBy, bookingId }
  const [row] = await db.insert(sceneLibrary).values(values).onConflictDoNothing().returning({ id: sceneLibrary.id })
  if (row) {
    await publishLibraryChanged(sceneId, row.id)
    return row.id
  }
  const existing = await db.query.sceneLibrary.findFirst({
    where: and(
      eq(sceneLibrary.sceneId, sceneId),
      item.mediaAssetId ? eq(sceneLibrary.mediaAssetId, item.mediaAssetId) : eq(sceneLibrary.assetItemId, item.assetItemId!),
    ),
    columns: { id: true },
  })
  return existing!.id
}

/**
 * Link every media file / model already placed in a scene (URL in element or instance properties).
 * Keys are the media-bearing ones in @virvixr/shared element types; `playlist` is an array of video URLs.
 * Only the scene owner's own media, and models the owner uploaded or public catalog models, are linked.
 * Idempotent; returns rows added. Startup goes through runStartupBackfill so it happens once.
 */
const PLACED = sql.raw(`
  SELECT DISTINCT sp.scene_id, u.url FROM (
    SELECT e.preset_id, e.properties AS props FROM scene_elements e
    UNION ALL
    SELECT e.preset_id, i.properties FROM scene_element_instances i JOIN scene_elements e ON e.id = i.element_id
  ) p
  JOIN scene_presets sp ON sp.id = p.preset_id
  CROSS JOIN LATERAL (
    SELECT p.props->>k AS url FROM unnest(ARRAY['textureSrc','modelSrc','audioSrc','offImageSrc','imgSrc','kioskImgSrc']) AS k
    UNION ALL
    SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.props->'playlist') = 'array' THEN p.props->'playlist' ELSE '[]'::jsonb END)
  ) u
  WHERE u.url IS NOT NULL AND u.url <> ''`)

const rowCount = (r: unknown): number => (Array.isArray(r) ? r.length : ((r as { rows?: unknown[] }).rows?.length ?? 0))

export async function backfillSceneLibrary(): Promise<number> {
  const media = await db.execute(sql`
    INSERT INTO scene_library (scene_id, media_asset_id, added_by)
    SELECT pl.scene_id, m.id, s.owner_id FROM (${PLACED}) pl
      JOIN scenes s ON s.id = pl.scene_id
      JOIN media_assets m ON m.public_url = pl.url AND m.owner_id = s.owner_id
    ON CONFLICT DO NOTHING RETURNING id`)
  const models = await db.execute(sql`
    INSERT INTO scene_library (scene_id, asset_item_id, added_by)
    SELECT pl.scene_id, a.id, s.owner_id FROM (${PLACED}) pl
      JOIN scenes s ON s.id = pl.scene_id
      JOIN asset_library_items a ON a.cdn_url = pl.url AND (a.uploaded_by = s.owner_id OR a.is_public)
    ON CONFLICT DO NOTHING RETURNING id`)
  return rowCount(media) + rowCount(models)
}

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[]

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** Storage keys of uploads: media files are `<owner>/<uuid>.<ext>` (fillMedia), models `assets/<owner>/<uuid>.<ext>`. */
const UPLOAD_KEY = new RegExp(`^(?:assets/)?${UUID}/${UUID}\\.[a-z0-9]+$`, 'i')
let storageBase: string | null = null

/**
 * Whether a URL is one of our uploads: under this server's storage and keyed like an upload. Other files in
 * storage (thumbnails, catalog models, room sets) and URLs anywhere else are not.
 */
export function isUploadUrl(url: string): boolean {
  storageBase ??= createStorage().getPublicUrl('')
  if (!url.startsWith(storageBase)) return false
  return UPLOAD_KEY.test(url.slice(storageBase.length).split(/[?#]/)[0])
}

/**
 * The current names of the files behind URLs placed (or about to be placed) in a scene, for its editors.
 * A URL is named when its file is the viewer's own, linked in the scene's library, already placed in the
 * scene, or (models) a public one. `missing`: our upload URLs whose file no longer exists at all.
 * Everything else (pasted links, files the viewer can't see) is left out, and the caller shows the URL.
 */
export async function resolveMediaNames(sceneId: string, userId: string, urls: string[]): Promise<{ names: Record<string, string>; missing: string[] }> {
  const wanted = [...new Set(urls.filter((u) => u))]
  if (wanted.length === 0) return { names: {}, missing: [] }
  const list = sql.join(wanted.map((u) => sql`${u}`), sql`, `)
  const [placedRows, media, models, linked] = await Promise.all([
    db.execute(sql`SELECT DISTINCT pl.url FROM (${PLACED}) pl WHERE pl.scene_id = ${sceneId} AND pl.url IN (${list})`),
    db.select().from(mediaAssets).where(inArray(mediaAssets.publicUrl, wanted)),
    db.select().from(assetLibraryItems).where(inArray(assetLibraryItems.cdnUrl, wanted)),
    db.select({ m: sceneLibrary.mediaAssetId, a: sceneLibrary.assetItemId }).from(sceneLibrary).where(and(eq(sceneLibrary.sceneId, sceneId), ACTIVE_BOOKING)),
  ])
  const placed = new Set(rowsOf<{ url: string }>(placedRows).map((r) => r.url))
  const linkedIds = new Set(linked.flatMap((l) => [l.m, l.a]).filter(Boolean))
  const names: Record<string, string> = {}
  const known = new Set<string>()
  for (const m of media) {
    known.add(m.publicUrl!)
    if (m.status === 'ready' && (m.ownerId === userId || placed.has(m.publicUrl!) || linkedIds.has(m.id))) names[m.publicUrl!] = m.filename
  }
  for (const a of models) {
    known.add(a.cdnUrl!)
    if (names[a.cdnUrl!] === undefined && (a.uploadedBy === userId || a.isPublic || placed.has(a.cdnUrl!) || linkedIds.has(a.id))) names[a.cdnUrl!] = a.name
  }
  return { names, missing: wanted.filter((u) => !known.has(u) && isUploadUrl(u)) }
}

const BACKFILL_FLAG = 'scene_library_backfill_v1'

/** Run the backfill once per database. The marker is claimed atomically first; a failure releases it so the next boot retries. */
export async function runStartupBackfill(): Promise<number | null> {
  const [claimed] = await db.insert(systemFlags).values({ key: BACKFILL_FLAG }).onConflictDoNothing().returning({ key: systemFlags.key })
  if (!claimed) return null
  try {
    return await backfillSceneLibrary()
  } catch (err) {
    await db.delete(systemFlags).where(eq(systemFlags.key, BACKFILL_FLAG))
    throw err
  }
}

/**
 * Where an actor's upload to a scene's library is stored. null = not allowed.
 * - Active booking grant (getSceneAccess only returns level 'grant' while the booking is confirmed/live and
 *   inside its window) holding a media-feeding scope (screens, playlist or audio, the scopes that govern
 *   the rented image/video/sound elements): the renter's own account, linked to the booking.
 * - Otherwise scene.edit (owner, org, co-host, editor, admin): the scene owner's account, no booking.
 */
const MEDIA_SCOPES = ['screens', 'playlist', 'audio'] as const

export async function uploadDestination(actor: Actor, sceneId: string): Promise<{ ownerId: string; bookingId: string | null } | null> {
  const access = await getSceneAccess(actor, sceneId)
  if (access.level === 'grant') {
    if (access.booking && MEDIA_SCOPES.some((s) => hasScope(access, s))) return { ownerId: actor.userId!, bookingId: access.booking.bookingId }
    return null
  }
  if (!hasScope(access, 'scene.edit')) return null
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { ownerId: true } })
  return scene ? { ownerId: scene.ownerId, bookingId: null } : null
}
