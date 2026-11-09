import { and, desc, eq, inArray, isNull, like, lt, ne, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, studioJobs, studioPieces, studioRenders, studioSetRenders } from '../db/schema.js'
import { config } from '../config.js'
import { publishStudio } from './events.js'
import { BASE_EMOTES, BODY_SHAPES, OUTFITS, renderPayload, type View } from './designs.js'
import { ensureWorker, machineDeps, sameImage } from './machines.js'
import { currentRevisions } from './sets.js'

/**
 * LIV-143: until the worker gave each body shape an outfit made for it, the Default outfit dressed the male body in a
 * woman's hair, face and clothes, and Outfit 2 the female body in a bearded man's. Every view with an outfit rendered
 * before then shows that.
 *
 * Per design (unarchived, not a scene), most recently active first, one at a time:
 * - the `ready` `spin-…`/`emote-…` views on each piece's latest revision are queued again in place, as background
 *   render jobs (each row and its job in one transaction);
 * - the `ready` emote views (`walk-…` set renders) for the design's current pieces are dropped: the Emotes step
 *   renders a missing one when it's opened.
 * Inspect views (`orbit-…`) have no outfit and scenes no avatar; older revisions and older sets of pieces keep their
 * frames; failed views are retried when someone picks them.
 *
 * Renders don't record the worker image that made them, so `before` stands in for it: only renders whose job was made
 * earlier are touched. Pass when the last machine on the old image stopped (or when the new image went live, if no
 * old machine ran after that). A design whose machine is still running an older image than STUDIO_WORKER_IMAGE is
 * skipped and reported, since that machine would take the new jobs; run again once it has stopped. After queuing a
 * design's views the run starts its worker and waits for those jobs to finish (up to `drainTimeoutMs`) before the
 * next design. If Fly refuses a start, the run stops there: that design's jobs stay queued for the sweep to retry.
 */
export async function rerenderOutfitViews(now: Date, opts: {
  before: Date; dryRun?: boolean; limit?: number; designId?: string; drainTimeoutMs?: number; pollMs?: number
}): Promise<{ designs: number; setViews: number; views: number; done: string[]; skipped: string[]; stopped: string | null }> {
  if (opts.before.getTime() > now.getTime()) throw new Error('--before is later than now')
  if (!opts.dryRun && (config.studioMachines !== 'fly' || !config.studioWorkerImage || !config.flyApiToken)) {
    throw new Error('A real run needs Fly studio machines: STUDIO_MACHINES=fly, STUDIO_WORKER_IMAGE and FLY_API_TOKEN')
  }
  const limit = opts.limit ?? 20

  const live = and(isNull(studioDesigns.archivedAt), ne(studioDesigns.kind, 'scene'),
    opts.designId ? eq(studioDesigns.id, opts.designId) : undefined)
  const rows = await db.select({ id: studioRenders.id, viewKey: studioRenders.viewKey, category: studioPieces.category, design: studioDesigns })
    .from(studioRenders)
    .innerJoin(studioPieces, eq(studioPieces.latestRevisionId, studioRenders.revisionId))
    .innerJoin(studioDesigns, eq(studioDesigns.id, studioPieces.designId))
    .innerJoin(studioJobs, eq(studioJobs.id, studioRenders.jobId))
    .where(and(eq(studioRenders.status, 'ready'), lt(studioJobs.createdAt, opts.before), live))
  const sets = await db.select({ id: studioSetRenders.id, revisions: studioSetRenders.revisions, design: studioDesigns })
    .from(studioSetRenders)
    .innerJoin(studioDesigns, eq(studioDesigns.id, studioSetRenders.designId))
    .innerJoin(studioJobs, eq(studioJobs.id, studioSetRenders.jobId))
    .where(and(like(studioSetRenders.viewKey, 'walk-%'), eq(studioSetRenders.status, 'ready'), lt(studioJobs.createdAt, opts.before), live))

  type Work = { design: typeof studioDesigns.$inferSelect; views: { id: string; category: string; view: View }[]; sets: string[] }
  const work = new Map<string, Work>()
  const of = (design: Work['design']) => work.get(design.id) ?? work.set(design.id, { design, views: [], sets: [] }).get(design.id)!
  for (const r of rows) {
    const view = outfitView(r.viewKey)
    if (view) of(r.design).views.push({ id: r.id, category: r.category, view })
  }
  const current = new Map<string, string>()
  for (const s of sets) {
    if (!current.has(s.design.id)) current.set(s.design.id, await currentRevisions(s.design.id))
    if (s.revisions === current.get(s.design.id)) of(s.design).sets.push(s.id)
  }
  const designs = [...work.values()]
    .sort((a, b) => (b.design.lastJobAt?.getTime() ?? 0) - (a.design.lastJobAt?.getTime() ?? 0))
    .slice(0, limit)
  const result = {
    designs: designs.length,
    setViews: designs.reduce((n, w) => n + w.sets.length, 0),
    views: designs.reduce((n, w) => n + w.views.length, 0),
    done: [] as string[], skipped: [] as string[], stopped: null as string | null,
  }
  if (opts.dryRun) return result

  const { fly } = machineDeps()
  for (const { design, views, sets: setIds } of designs) {
    if (design.machineId) {
      let machine: { state: string; image: string | null } | null
      try {
        machine = await fly.getMachine(config.studioFlyApp, design.machineId)
      } catch (err) {
        result.stopped = `${design.id}: the machine could not be reached: ${err instanceof Error ? err.message : err}`
        break
      }
      const running = !!machine && !['stopped', 'suspended', 'destroyed', 'destroying', 'failed'].includes(machine.state)
      if (running && !sameImage(machine!.image, config.studioWorkerImage!)) {
        result.skipped.push(design.id)
        continue
      }
    }
    const jobIds = await db.transaction(async (tx) => {
      await tx.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.id, design.id)).for('update')
      const ids: string[] = []
      for (const v of views) {
        // still ready and still old (a render since the listing leaves it be)
        const [row] = await tx.select({ id: studioRenders.id }).from(studioRenders)
          .innerJoin(studioJobs, eq(studioJobs.id, studioRenders.jobId))
          .where(and(eq(studioRenders.id, v.id), eq(studioRenders.status, 'ready'), lt(studioJobs.createdAt, opts.before)))
        if (!row) continue
        const [job] = await tx.insert(studioJobs).values({
          designId: design.id, type: 'render', background: true,
          payload: renderPayload(design.kind, { categories: [v.category], ...v.view }),
        }).returning({ id: studioJobs.id })
        await tx.update(studioRenders).set({ jobId: job.id, status: 'queued', frames: 0 }).where(eq(studioRenders.id, v.id))
        ids.push(job.id)
      }
      if (setIds.length) {
        await tx.delete(studioSetRenders).where(and(inArray(studioSetRenders.id, setIds), eq(studioSetRenders.status, 'ready')))
      }
      return ids
    })
    for (const jobId of jobIds) await publishStudio(design.id, { type: 'job', jobId, status: 'queued' })
    if (jobIds.length) {
      try {
        await ensureWorker(design.id)
      } catch (err) {
        // the jobs stay queued: the sweep starts the machine again for a job still waiting
        result.stopped = `${design.id}: the worker could not start: ${err instanceof Error ? err.message : err}`
        break
      }
      await drain(jobIds, opts.drainTimeoutMs ?? 10 * 60_000, opts.pollMs ?? 5000)
    }
    result.done.push(design.id)
  }
  return result
}

/** Waits until none of the jobs is queued or taken, or the timeout passes. */
async function drain(jobIds: string[], timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [{ open }] = await db.select({ open: sql<number>`count(*)::int` }).from(studioJobs)
      .where(and(inArray(studioJobs.id, jobIds), inArray(studioJobs.status, ['queued', 'taken'])))
    if (!open) return
    await new Promise((r) => setTimeout(r, pollMs))
  }
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
