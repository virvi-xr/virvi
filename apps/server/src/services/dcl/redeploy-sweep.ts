/**
 * Redeploys a World when models were added in-world that it doesn't hold yet.
 *
 * Mode A (`virvi`): the first sweep that sees a pending model stamps `pendingSince`; once a minute has
 * passed (so a burst of additions makes one deploy) Virvi redeploys. Mode B (`sign`): only `pendingSince`
 * is kept, which the HUD and dashboard show as "ready to publish". Either way a scene past Decentraland's
 * limits shows over_budget, and models the last deployment refused are not retried on their own: the
 * destination shows needs_review naming them until the scene's models change.
 *
 * Only a destination that has been deployed (or adopted) is redeployed here: a first deploy is always
 * started by the owner, after the wizard showed them what it replaces.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { dclWorldDestinations, sceneDeployments } from '../../db/schema.js'
import { frameEntitiesInScene, modelsInScene, pendingModels, type Assembled } from './assemble.js'
import {
  DeployerError, liveBaseFor, reconcileStaleDeployments, refusedLine, REFUSED_PREFIX, sceneLimitProblem, startVirviDeploy,
  type Destination, type DeployOptions,
} from './world-deployer.js'

export { pendingModels }

/** How long a model waits after it is first seen, so a burst of additions makes one deployment. */
export const BATCH_WINDOW_MS = 60_000
/** After a failed deploy, wait this long (from the failed row's createdAt) before trying again. */
export const RETRY_BACKOFF_MS = 5 * 60_000
/** This many failed deploys in a row stop the automatic redeploys until someone looks. */
export const MAX_FAILED_IN_A_ROW = 3

async function setStatus(id: string, status: Destination['status'], statusDetail: string | null) {
  await db.update(dclWorldDestinations).set({ status, statusDetail, updatedAt: new Date() }).where(eq(dclWorldDestinations.id, id))
}

const heldByRefusal = (dest: Destination) => dest.status === 'needs_review' && !!dest.statusDetail?.startsWith(REFUSED_PREFIX)

/** What the destination's latest deployment (or publish request) left out, by lowercased path. */
async function lastRefused(destinationId: string): Promise<Map<string, Assembled['refused'][number]>> {
  const last = await db.query.sceneDeployments.findFirst({
    where: eq(sceneDeployments.destinationId, destinationId),
    orderBy: [desc(sceneDeployments.createdAt)],
    columns: { assetBundle: true },
  })
  const refused = (last?.assetBundle as { refused?: Assembled['refused'] } | null)?.refused ?? []
  return new Map(refused.filter((r) => typeof r.file === 'string').map((r) => [r.file.toLowerCase(), r]))
}

/** One pass over every destination. `marked` counts destinations that newly became pending. */
export async function sweepRedeploys(now: Date = new Date(), opts: DeployOptions = {}): Promise<{ started: number; marked: number }> {
  await reconcileStaleDeployments(now)
  let started = 0
  let marked = 0
  for (const dest of await db.select().from(dclWorldDestinations)) {
    try {
      const pending = await pendingModels(dest)
      if (pending.length === 0) {
        const clear = dest.status === 'over_budget' || heldByRefusal(dest)
        if (dest.pendingSince || clear) {
          await db.update(dclWorldDestinations)
            .set({ pendingSince: null, ...(clear ? { status: 'ok' as const, statusDetail: null } : {}), updatedAt: new Date() })
            .where(eq(dclWorldDestinations.id, dest.id))
        }
        continue
      }
      let since = dest.pendingSince
      if (!since) {
        since = now
        marked++
        await db.update(dclWorldDestinations).set({ pendingSince: now, updatedAt: new Date() }).where(eq(dclWorldDestinations.id, dest.id))
      }

      // Every pending model was refused last time: retrying would deploy nothing new, so say why and wait.
      const refused = await lastRefused(dest.id)
      const stuck = pending.filter((m) => refused.has(m.file.toLowerCase()))
      if (stuck.length === pending.length && (dest.status === 'ok' || heldByRefusal(dest))) {
        const detail = refusedLine(stuck.map((m) => refused.get(m.file.toLowerCase())!))
        if (dest.status !== 'needs_review' || dest.statusDetail !== detail) await setStatus(dest.id, 'needs_review', detail)
        continue
      }
      if (heldByRefusal(dest)) {
        await setStatus(dest.id, 'ok', null) // the scene's models changed: try again
        dest.status = 'ok'
      }

      const problem = sceneLimitProblem(dest, await modelsInScene(dest.sceneId), await frameEntitiesInScene(dest.sceneId))
      if (problem) {
        // Another needs_review (changed outside Virvi, failures) keeps its own message.
        const mayShow = ['ok', 'unreachable', 'over_budget'].includes(dest.status)
        if (mayShow && (dest.statusDetail !== problem || dest.status !== 'over_budget')) await setStatus(dest.id, 'over_budget', problem)
        continue
      }
      if (dest.mode !== 'virvi' || !dest.grantedAt || !['ok', 'unreachable', 'over_budget'].includes(dest.status)) continue
      if (!dest.lastEntityId && !dest.adopted) continue // first deploys are owner-started
      if (now.getTime() - since.getTime() < BATCH_WINDOW_MS) continue
      const busy = await db.query.sceneDeployments.findFirst({
        where: and(eq(sceneDeployments.destinationId, dest.id), inArray(sceneDeployments.status, ['building', 'deploying'])),
        columns: { id: true },
      })
      if (busy) continue

      const recent = await db
        .select({ status: sceneDeployments.status, errorMessage: sceneDeployments.errorMessage, createdAt: sceneDeployments.createdAt })
        .from(sceneDeployments)
        // A deploy that had nothing new to send (a Redeploy now with no changes) isn't a failure.
        .where(and(eq(sceneDeployments.destinationId, dest.id), sql`coalesce(${sceneDeployments.assetBundle}->>'noop', '') <> 'true'`))
        .orderBy(desc(sceneDeployments.createdAt))
        .limit(MAX_FAILED_IN_A_ROW)
      if (recent.length === MAX_FAILED_IN_A_ROW && recent.every((r) => r.status === 'failed')) {
        await setStatus(dest.id, 'needs_review', `Virvi couldn't update your World ${MAX_FAILED_IN_A_ROW} times in a row (${recent[0].errorMessage ?? 'no reason given'}). Check it on the deploy page and press Redeploy now.`)
        continue
      }
      if (recent[0]?.status === 'failed' && now.getTime() - recent[0].createdAt.getTime() < RETRY_BACKOFF_MS) continue

      try {
        await liveBaseFor(dest) // sets needs_review / unreachable itself and throws
        await startVirviDeploy(dest.id, null, opts) // checks storage too: over_budget is set and thrown
      } catch (err) {
        if (err instanceof DeployerError) continue
        throw err
      }
      started++
    } catch (err) {
      console.error('[redeploy-sweep] destination failed:', dest.id, err instanceof Error ? err.message : err)
    }
  }
  return { started, marked }
}

export function startDclRedeploySweep(ms: number): () => void {
  if (ms <= 0) return () => {}
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await sweepRedeploys()
    } catch (err) {
      console.error('[virvi-server] Redeploy sweep failed:', err)
    } finally {
      running = false
    }
  }, ms)
  return () => clearInterval(timer)
}
