import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, studioEmoteChecks, studioJobs, studioPieces, studioSetRenders } from '../db/schema.js'
import { publishStudio } from './events.js'
import { signRenderFrame, frameUrlExpiry } from './render-urls.js'
import { BASE_EMOTES, BODY_SHAPES, OWN_EMOTE, RENDER_LIMITS, revisionsKey, setViewKey, startWorker, type Design, type View } from './designs.js'
import type { Exec } from './quota.js'

/**
 * Emote views with every piece of a design worn together. Each belongs to the set of piece revisions it was
 * rendered from, so a change to any piece (or a piece added) leaves it behind and the person sees it as not rendered.
 */

/** What the design page is told of an emote view: its frame urls come from asking for it (requestSetRender). */
export type SetView = { status: string; frames: number; fps: number | null; renderedAt: Date }

/** The set of piece revisions the design's emote views and checks belong to right now. */
export async function currentRevisions(designId: string, exec: Exec = db): Promise<string> {
  return revisionsKey(await exec.select({ latestRevisionId: studioPieces.latestRevisionId }).from(studioPieces)
    .where(eq(studioPieces.designId, designId)))
}

const frameUrls = (designId: string, row: typeof studioSetRenders.$inferSelect, expires: Date) =>
  row.status === 'ready'
    ? Array.from({ length: row.frames }, (_, frame) => signRenderFrame(
      { designId, revisionId: row.id, viewKey: row.viewKey, category: 'set', frame, jobId: row.jobId }, expires))
    : []

/**
 * The design's emote views for its current pieces, keyed by view key, without frame urls: after Finalize there are
 * fourteen of them, and every reload of the design would sign each frame of each.
 */
export async function setViews(designId: string, revisions: string, exec: Exec = db): Promise<Record<string, SetView>> {
  const rows = await exec.select().from(studioSetRenders)
    .where(and(eq(studioSetRenders.designId, designId), eq(studioSetRenders.revisions, revisions)))
  return Object.fromEntries(rows.map((r) => [r.viewKey, { status: r.status, frames: r.frames, fps: r.fps, renderedAt: r.createdAt }]))
}

/**
 * An emote view of every piece worn: ready, or queued now (`queued` says a job was added rather than already
 * waiting). Null when the design has no pieces.
 */
export async function requestSetRender(
  design: Design,
  view: View,
  now: Date,
  opts: { background?: boolean } = {},
): Promise<{ status: 'ready'; frames: number; fps: number | null; urls: string[] } | { status: 'queued'; queued: boolean } | null> {
  const key = setViewKey(design.kind, view)
  const done = await db.transaction(async (tx) => {
    await tx.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.id, design.id)).for('update')
    const revisions = await currentRevisions(design.id, tx)
    if (!revisions) return null
    const [row] = await tx.select().from(studioSetRenders).where(and(
      eq(studioSetRenders.designId, design.id), eq(studioSetRenders.revisions, revisions), eq(studioSetRenders.viewKey, key)))
    if (row?.status === 'ready') return { ready: row }
    if (row?.status === 'queued') return { jobId: null }
    const [job] = await tx.insert(studioJobs).values({
      designId: design.id,
      type: 'render',
      background: !!opts.background,
      payload: {
        type: 'render', kind: design.kind, agent: null, model: null, prompt: null, selectedSlots: null, limits: RENDER_LIMITS,
        render: { set: true, bodyShape: view.bodyShape, outfit: view.outfit, emote: design.kind === 'emote' ? OWN_EMOTE : view.emote },
        revisions, // the pieces it is for: a change before it runs cancels it (results.ts cancelSupersededRenders)
      },
    }).returning({ id: studioJobs.id })
    await tx.insert(studioSetRenders).values({ designId: design.id, revisions, viewKey: key, jobId: job.id, status: 'queued' })
      .onConflictDoUpdate({
        target: [studioSetRenders.designId, studioSetRenders.revisions, studioSetRenders.viewKey],
        set: { jobId: job.id, status: 'queued', frames: 0, fps: null },
      })
    await tx.update(studioDesigns).set({ lastJobAt: now }).where(eq(studioDesigns.id, design.id))
    return { jobId: job.id }
  })
  if (!done) return null
  if ('ready' in done && done.ready) {
    const r = done.ready
    return { status: 'ready', frames: r.frames, fps: r.fps, urls: frameUrls(design.id, r, frameUrlExpiry(now)) }
  }
  if (done.jobId) {
    await publishStudio(design.id, { type: 'job', jobId: done.jobId, status: 'queued' })
    await startWorker(design.id, done.jobId, now)
  }
  return { status: 'queued', queued: !!done.jobId }
}

/** The emotes a design's pieces are checked in: the base emotes, or an emote design's own. */
export const emotesFor = (kind: string): string[] => kind === 'emote' ? [OWN_EMOTE] : [...BASE_EMOTES]

/** Free clipping fixes per design and emote, counted since the person's last prompt of their own. */
export const FREE_CLIPPING_FIXES = 2

/** Fixes left for an emote: only fixes that ended `ok` (changed a piece) use one up. */
export async function freeFixesLeft(designId: string, emote: string, exec: Exec = db): Promise<number> {
  const [own] = await exec.select({ at: studioJobs.createdAt }).from(studioJobs)
    .where(and(eq(studioJobs.designId, designId), eq(studioJobs.type, 'prompt'), eq(studioJobs.counted, true)))
    .orderBy(desc(studioJobs.createdAt)).limit(1)
  const [{ n }] = await exec.select({ n: sql<number>`count(*)::int` }).from(studioJobs).where(and(
    eq(studioJobs.designId, designId), eq(studioJobs.type, 'prompt'),
    sql`${studioJobs.payload}->'fixClipping'->>'emote' = ${emote}`,
    sql`${studioJobs.result}->>'outcome' = 'ok'`,
    ...(own ? [gt(studioJobs.createdAt, own.at)] : []),
  ))
  return Math.max(0, FREE_CLIPPING_FIXES - n)
}

/** What the person said about an emote on a body shape, for the pieces as they are now. */
export async function recordCheck(
  designId: string, revisions: string, emote: string, bodyShape: string, state: 'fine' | 'clipping', exec: Exec = db,
): Promise<void> {
  await exec.insert(studioEmoteChecks).values({ designId, revisions, emote, bodyShape, state })
    .onConflictDoUpdate({
      target: [studioEmoteChecks.designId, studioEmoteChecks.revisions, studioEmoteChecks.emote, studioEmoteChecks.bodyShape],
      set: { state, createdAt: new Date() },
    })
}

/**
 * Opening Finalize renders every emote on both bodies with the default outfit, in the background, so a view the
 * person clicks still goes first. Returns how many were queued.
 */
export async function queueFinalizeRenders(design: Design, now: Date): Promise<number> {
  let n = 0
  for (const emote of emotesFor(design.kind)) {
    for (const bodyShape of BODY_SHAPES) {
      const view = { bodyShape, outfit: 'default', emote: design.kind === 'emote' ? null : emote } as View
      const r = await requestSetRender(design, view, now, { background: true })
      if (r?.status === 'queued' && r.queued) n++
    }
  }
  return n
}

/** What the design page shows of the emote step. */
export async function setDetail(design: Design, now: Date, exec: Exec = db) {
  const revisions = await currentRevisions(design.id, exec)
  const checks = revisions
    ? await exec.select({ emote: studioEmoteChecks.emote, bodyShape: studioEmoteChecks.bodyShape, state: studioEmoteChecks.state })
      .from(studioEmoteChecks)
      .where(and(eq(studioEmoteChecks.designId, design.id), eq(studioEmoteChecks.revisions, revisions)))
      .orderBy(studioEmoteChecks.emote, studioEmoteChecks.bodyShape)
    : []
  const freeFixes: Record<string, number> = {}
  for (const emote of emotesFor(design.kind)) freeFixes[emote] = await freeFixesLeft(design.id, emote, exec)
  return {
    revisions,
    views: revisions ? await setViews(design.id, revisions, exec) : {},
    checks,
    freeFixesLeft: freeFixes,
  }
}
