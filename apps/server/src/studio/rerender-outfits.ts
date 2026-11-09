import { and, eq, inArray, like, lt, ne } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, studioJobs, studioPieces, studioRenders, studioSetRenders } from '../db/schema.js'
import { BASE_EMOTES, BODY_SHAPES, OUTFITS, requestRender, type View } from './designs.js'

/**
 * LIV-143: until the worker gave each body shape an outfit made for it, the Default outfit dressed the male body in a
 * woman's hair, face and clothes, and Outfit 2 the female body in a bearded man's. Every view with an outfit rendered
 * before then shows that. This drops the emote views (`walk-…` set renders; the Emotes step renders a missing one
 * when it's opened) and queues the outfit views on each piece's latest revision again. Inspect views (`orbit-…`) have
 * no outfit and scenes no avatar, so they stay. Older revisions keep their frames.
 *
 * `before` is when the worker with per-shape outfits went live: only renders whose job was made earlier are touched,
 * so running it twice does nothing more.
 */
export async function rerenderOutfitViews(
  now: Date, opts: { before: Date; dryRun?: boolean },
): Promise<{ setViews: number; views: number }> {
  const sets = await db.select({ id: studioSetRenders.id }).from(studioSetRenders)
    .innerJoin(studioJobs, eq(studioJobs.id, studioSetRenders.jobId))
    .where(and(like(studioSetRenders.viewKey, 'walk-%'), ne(studioSetRenders.status, 'queued'), lt(studioJobs.createdAt, opts.before)))

  const rows = await db.select({ id: studioRenders.id, viewKey: studioRenders.viewKey, category: studioPieces.category, design: studioDesigns })
    .from(studioRenders)
    .innerJoin(studioPieces, eq(studioPieces.latestRevisionId, studioRenders.revisionId))
    .innerJoin(studioDesigns, eq(studioDesigns.id, studioPieces.designId))
    .innerJoin(studioJobs, eq(studioJobs.id, studioRenders.jobId))
    .where(and(ne(studioRenders.status, 'queued'), ne(studioDesigns.kind, 'scene'), lt(studioJobs.createdAt, opts.before)))
  const views = rows.flatMap((r) => {
    const view = outfitView(r.viewKey)
    return view ? [{ ...r, view }] : []
  })
  if (opts.dryRun) return { setViews: sets.length, views: views.length }

  if (sets.length) await db.delete(studioSetRenders).where(inArray(studioSetRenders.id, sets.map((s) => s.id)))
  for (const v of views) {
    await db.delete(studioRenders).where(eq(studioRenders.id, v.id))
    await requestRender(v.design, v.category, v.view, now)
  }
  return { setViews: sets.length, views: views.length }
}

/** The view a `spin-…` or `emote-…` key names (`<mode>-<bodyShape>-<outfit>[-<emote>]`), or null for any other key. */
export function outfitView(key: string): View | null {
  const m = /^(?:spin|emote)-(male|female)-(default|outfit-2|outfit-3)(?:-([a-z]+))?$/.exec(key)
  if (!m) return null
  const [, bodyShape, outfit, emote] = m
  if (!(BODY_SHAPES as readonly string[]).includes(bodyShape) || !(OUTFITS as readonly string[]).includes(outfit)) return null
  if (emote !== undefined && !(BASE_EMOTES as readonly string[]).includes(emote)) return null
  return { bodyShape, outfit, emote: emote ?? null } as View
}
