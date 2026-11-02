import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { dclWorldDestinations, sceneImports } from '../../db/schema.js'
import { getBuildRunner } from './build-runner.js'

/**
 * Fails builds that never reported back (a box that died, hung or was cut off) and removes their machines. The box has
 * no output or memory caps of its own (Ruling R11), so this is what bounds a build. A build's `updated_at` is set when
 * it starts and not touched while it runs. The transition is one conditional UPDATE, so concurrent sweeps on several
 * servers fail each build once; its token goes with it, so a late result or failure report is refused. An `uploaded` row
 * this old never got a machine (machine_id is null), so there is nothing to stop.
 *
 * It also puts back an import the automatic deploy claimed (Ruling R24: `deploying`, no deployment linked) and then lost,
 * when the server stopped between the claim and the deployment: after CLAIM_TIMEOUT_MS it is `built` again, so the World
 * isn't held and the creator can press Deploy.
 */

export const BUILD_SWEEP_MS = 60_000
export const BUILD_TIMEOUT_MS = 15 * 60_000
export const BUILD_TIMEOUT_MESSAGE = 'The build took longer than 15 minutes and was stopped.'
/** A claim links its deployment within seconds; one this old was lost. */
export const CLAIM_TIMEOUT_MS = 5 * 60_000
export const CLAIM_LOST_MESSAGE = 'Virvi was interrupted before the deploy started. Press Deploy to try again.'

export async function sweepBuilds(now: Date): Promise<number> {
  const timedOut = await db.update(sceneImports).set({
    status: 'failed',
    errorCode: 'build_timeout',
    errorMessage: BUILD_TIMEOUT_MESSAGE,
    buildTokenHash: null,
    finishedAt: now,
    updatedAt: now,
  }).where(and(
    // An upload whose build never started (the server stopped between storing and starting it) holds its World too
    inArray(sceneImports.status, ['building', 'uploaded']),
    lt(sceneImports.updatedAt, new Date(now.getTime() - BUILD_TIMEOUT_MS)),
  )).returning({ id: sceneImports.id, machineId: sceneImports.machineId })

  const runner = getBuildRunner()
  for (const { id, machineId } of timedOut) {
    if (!machineId || !runner) continue
    await runner.stop(machineId)
      .catch((err) => console.error(`[build-sweep] stopping the machine of import ${id} failed:`, err instanceof Error ? err.message : err))
  }

  // Conditional on the row still being claimed and unlinked, so a deployment linked meanwhile keeps it
  const lost = await db.update(sceneImports).set({
    status: 'built', errorCode: 'deploy_interrupted', errorMessage: CLAIM_LOST_MESSAGE, updatedAt: now,
  }).where(and(
    eq(sceneImports.status, 'deploying'),
    isNull(sceneImports.deploymentId),
    lt(sceneImports.updatedAt, new Date(now.getTime() - CLAIM_TIMEOUT_MS)),
  )).returning({ id: sceneImports.id })
  // The claim may have pointed the World at it before the server stopped
  if (lost.length) {
    await db.update(dclWorldDestinations).set({ pendingImportId: null, updatedAt: now })
      .where(inArray(dclWorldDestinations.pendingImportId, lost.map((l) => l.id)))
  }
  return timedOut.length + lost.length
}

let timer: ReturnType<typeof setInterval> | null = null

export function startBuildSweep(ms = BUILD_SWEEP_MS): void {
  if (timer) return
  let running = false
  timer = setInterval(() => {
    if (running) return
    running = true
    sweepBuilds(new Date())
      .catch((err) => console.error('[build-sweep] failed:', err))
      .finally(() => { running = false })
  }, ms)
  timer.unref?.()
}
