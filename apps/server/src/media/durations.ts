import { and, eq, isNotNull, like, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { mediaAssets } from '../db/schema.js'
import { probeDuration, type ProbeResult } from './probe.js'

/** The backfill starts this long after boot, so it never competes with startup. */
export const DURATION_BACKFILL_DELAY_MS = 2 * 60_000

type Opts = {
  probe?: (input: string) => Promise<ProbeResult>
  batch?: number
}

/**
 * Measures the length of every ready video with none recorded (uploaded before lengths were measured on upload),
 * reading each from its public URL. A video ffprobe can't read, or that times out, is marked `durationProbe: 'failed'`
 * and not retried (so one slow file can't hold up the rest on every boot);
 * if ffprobe is unavailable the run stops and leaves the rest for the next boot.
 */
export async function backfillVideoDurations(opts: Opts = {}): Promise<{ measured: number; failed: number; stopped: boolean }> {
  const probe = opts.probe ?? ((u: string) => probeDuration(u))
  const batch = opts.batch ?? 50
  let measured = 0
  let failed = 0
  let lastId: string | null = null
  for (;;) {
    const rows: Array<{ id: string; publicUrl: string | null; metadata: unknown }> = await db
      .select({ id: mediaAssets.id, publicUrl: mediaAssets.publicUrl, metadata: mediaAssets.metadata })
      .from(mediaAssets)
      .where(and(
        eq(mediaAssets.status, 'ready'),
        like(mediaAssets.contentType, 'video/%'),
        isNotNull(mediaAssets.publicUrl),
        sql`${mediaAssets.metadata}->'duration' IS NULL`,
        sql`${mediaAssets.metadata}->'durationProbe' IS NULL`,
        lastId ? sql`${mediaAssets.id} > ${lastId}` : sql`true`,
      ))
      .orderBy(mediaAssets.id)
      .limit(batch)
    if (rows.length === 0) return { measured, failed, stopped: false }
    for (const row of rows) {
      lastId = row.id
      const result = await probe(row.publicUrl!)
      if (!result.ok && result.reason === 'unavailable') return { measured, failed, stopped: true }
      const patch = result.ok ? { duration: result.seconds } : { durationProbe: 'failed' }
      await setMetadata(row.id, patch)
      if (result.ok) measured++
      else failed++
    }
  }
}

/** Merges `patch` into an asset's metadata (null metadata becomes the patch). */
export async function setMetadata(id: string, patch: Record<string, unknown>) {
  await db.update(mediaAssets)
    .set({ metadata: sql`COALESCE(${mediaAssets.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(mediaAssets.id, id))
}

/** One backfill run, a little after boot. New uploads are measured as they arrive, so once per boot is enough. */
export function startDurationBackfill(delayMs = DURATION_BACKFILL_DELAY_MS) {
  const t = setTimeout(() => {
    backfillVideoDurations()
      .then((r) => {
        if (r.measured || r.failed || r.stopped) {
          console.log(`[media] video lengths: ${r.measured} measured, ${r.failed} unreadable${r.stopped ? ', stopped (ffprobe unavailable)' : ''}`)
        }
      })
      .catch((err) => console.error('[media] video length backfill failed:', err instanceof Error ? err.message : err))
  }, delayMs)
  t.unref()
}
