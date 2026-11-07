/**
 * LIV-135: did Decentraland build a map snapshot for what Virvi deployed?
 *
 * After a deployment goes live, Decentraland's abgen pipeline may publish an Initial Scene State (ISS) for the entity:
 * the placed models the distant view (and a later map re-capture) draws. Virvi can't trigger or query that job, only
 * look for its output. So every new entity Virvi deploys makes the destination's map `pending` (afterDeploy calls
 * startMapChecks), and this sweep fetches `<entityId>_InitialSceneState.json` on a schedule counted from when the entity
 * went live (MAP_CHECK_OFFSETS_MIN): `ready` (with its model count) on the first 200, `none` once the window is over.
 *
 * All state is in the destination row (mapCheckAt is the next check due), so a restart just picks up the overdue checks:
 * one check, then the next slot still ahead. Every write is conditional on the row still being pending for the same
 * entity, so a newer deploy (or a second server sweeping at the same time) is never overwritten by an older result.
 */
import { and, asc, eq, isNotNull, lte, ne, or, isNull, sql } from 'drizzle-orm'
import { config } from '../../config.js'
import { db } from '../../db/connection.js'
import { dclWorldDestinations } from '../../db/schema.js'

/** Minutes after the deploy went live: 2, 5, 10, 20, 40, then hourly up to 24 hours. */
export const MAP_CHECK_OFFSETS_MIN: readonly number[] = [2, 5, 10, 20, 40, ...Array.from({ length: 24 }, (_, i) => (i + 1) * 60)]
/** Checks in flight at once, across all destinations. */
export const MAP_CHECK_CONCURRENCY = 4
/** Destinations checked per sweep; the rest wait for the next one (oldest due first). */
export const MAP_SWEEP_BATCH = 50
/** Genesis Plaza's is about 200 KB. A bigger one is still published, just not counted. */
export const MAP_MANIFEST_MAX_BYTES = 16 * 1024 * 1024
const MAP_CHECK_TIMEOUT_MS = 15_000

export type MapResult = { published: false } | { published: true; assets: number | null }
/** Looks for the entity's ISS. Throws when it can't tell (unreachable, 5xx, a 200 that isn't a scene state). */
export type MapCheck = (entityId: string) => Promise<MapResult>

/** The first scheduled check after `after`, or null when the window is over. */
export function nextMapCheckAt(since: Date, after: Date): Date | null {
  for (const m of MAP_CHECK_OFFSETS_MIN) {
    const t = new Date(since.getTime() + m * 60_000)
    if (t > after) return t
  }
  return null
}

const ENTITY_ID = /^[A-Za-z0-9]{1,128}$/

export const mapManifestUrl = (entityId: string) => `${config.dclMapManifestUrl}/${entityId}_InitialSceneState.json`

/** Reads at most `max` bytes of the body; null when it is longer. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  return buf
}

/**
 * The real check, against Decentraland's abgen CDN (a fixed public host, from config): a timeout, no redirects, and the
 * body capped while streaming. 404 and 403 (how the CDN answers a file that isn't there) mean not published.
 */
export function abgenMapCheck(fetchImpl: typeof fetch = fetch): MapCheck {
  return async (entityId) => {
    if (!ENTITY_ID.test(entityId)) throw new Error(`not a content hash: ${entityId.slice(0, 80)}`)
    const res = await fetchImpl(mapManifestUrl(entityId), {
      redirect: 'error', signal: AbortSignal.timeout(MAP_CHECK_TIMEOUT_MS), headers: { accept: 'application/json' },
    })
    if (res.status === 404 || res.status === 403) {
      await res.body?.cancel().catch(() => {})
      return { published: false }
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`abgen CDN answered ${res.status}`)
    }
    const declared = Number(res.headers.get('content-length') ?? NaN)
    if (Number.isFinite(declared) && declared > MAP_MANIFEST_MAX_BYTES) {
      await res.body?.cancel().catch(() => {})
      return { published: true, assets: null }
    }
    const body = await readCapped(res, MAP_MANIFEST_MAX_BYTES)
    if (body === null) return { published: true, assets: null }
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      throw new Error('abgen CDN answered 200 with something that is not JSON')
    }
    const assets = (parsed as { assets?: unknown } | null)?.assets
    if (!Array.isArray(assets)) throw new Error('abgen CDN answered 200 without an assets list')
    return { published: true, assets: assets.length }
  }
}

type Tx = Pick<typeof db, 'update'>

/**
 * `entityId` just went live on the destination: its map is pending, first check MAP_CHECK_OFFSETS_MIN[0] from now.
 * Finishing the same entity again (a deploy reconciled after a restart) keeps what was already found.
 */
export async function startMapChecks(tx: Tx, destinationId: string, entityId: string, now: Date): Promise<void> {
  await tx.update(dclWorldDestinations)
    .set({ mapStatus: 'pending', mapEntityId: entityId, mapAssets: null, mapSince: now, mapCheckAt: nextMapCheckAt(now, now), mapCheckedAt: null })
    .where(and(
      eq(dclWorldDestinations.id, destinationId),
      or(isNull(dclWorldDestinations.mapEntityId), ne(dclWorldDestinations.mapEntityId, entityId)),
    ))
}

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** One pass: every pending destination whose check is due, at most MAP_CHECK_CONCURRENCY at a time. */
export async function sweepMapStatus(
  now: Date = new Date(), opts: { check?: MapCheck } = {},
): Promise<{ checked: number; ready: number; gaveUp: number }> {
  const check = opts.check ?? defaultCheck
  const d = dclWorldDestinations
  // The live entity moved on without a Virvi deploy (Use the live version): what's live was never checked.
  await db.update(d)
    .set({ mapStatus: 'unknown', mapCheckAt: null })
    .where(and(eq(d.mapStatus, 'pending'), sql`${d.mapEntityId} is distinct from ${d.lastEntityId}`))

  const due = await db
    .select({ id: d.id, entityId: d.mapEntityId, since: d.mapSince })
    .from(d)
    .where(and(eq(d.mapStatus, 'pending'), isNotNull(d.mapEntityId), isNotNull(d.mapSince), lte(d.mapCheckAt, now)))
    .orderBy(asc(d.mapCheckAt))
    .limit(MAP_SWEEP_BATCH)

  let ready = 0
  let gaveUp = 0
  await runLimited(due, MAP_CHECK_CONCURRENCY, async ({ id, entityId, since }) => {
    let result: MapResult
    try {
      result = await check(entityId!)
    } catch (err) {
      // Can't tell this time: the same as not published yet, so the schedule goes on.
      console.error('[map-status] check failed:', id, entityId, err instanceof Error ? err.message : err)
      result = { published: false }
    }
    const still = and(eq(d.id, id), eq(d.mapStatus, 'pending'), eq(d.mapEntityId, entityId!))
    try {
      if (result.published) {
        const n = await db.update(d).set({ mapStatus: 'ready', mapAssets: result.assets, mapCheckAt: null, mapCheckedAt: now })
          .where(still).returning({ id: d.id })
        ready += n.length
      } else {
        const next = nextMapCheckAt(since!, now)
        const n = await db.update(d).set({ mapStatus: next ? 'pending' : 'none', mapCheckAt: next, mapCheckedAt: now })
          .where(still).returning({ id: d.id })
        if (!next) gaveUp += n.length
      }
    } catch (err) {
      console.error('[map-status] could not record the check:', id, err instanceof Error ? err.message : err)
    }
  })
  return { checked: due.length, ready, gaveUp }
}

const defaultCheck: MapCheck = (entityId) => abgenMapCheck()(entityId)

export function startDclMapSweep(ms: number): () => void {
  if (ms <= 0) return () => {}
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await sweepMapStatus()
    } catch (err) {
      console.error('[virvi-server] Map status sweep failed:', err)
    } finally {
      running = false
    }
  }, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}
