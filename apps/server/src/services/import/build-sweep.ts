import { and, eq, lt } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { sceneImports } from '../../db/schema.js'
import { getBuildRunner } from './build-runner.js'

/**
 * Fails builds that never reported back (a box that died, hung or was cut off) and removes their machines. The box has
 * no output or memory caps of its own (Ruling R11), so this is what bounds a build. A build's `updated_at` is set when
 * it starts and not touched while it runs. The transition is one conditional UPDATE, so concurrent sweeps on several
 * servers fail each build once; its token goes with it, so a late result or failure report is refused.
 */

export const BUILD_SWEEP_MS = 60_000
export const BUILD_TIMEOUT_MS = 15 * 60_000
export const BUILD_TIMEOUT_MESSAGE = 'The build took longer than 15 minutes and was stopped.'

export async function sweepBuilds(now: Date): Promise<number> {
  const timedOut = await db.update(sceneImports).set({
    status: 'failed',
    errorCode: 'build_timeout',
    errorMessage: BUILD_TIMEOUT_MESSAGE,
    buildTokenHash: null,
    finishedAt: now,
    updatedAt: now,
  }).where(and(
    eq(sceneImports.status, 'building'),
    lt(sceneImports.updatedAt, new Date(now.getTime() - BUILD_TIMEOUT_MS)),
  )).returning({ id: sceneImports.id, machineId: sceneImports.machineId })

  const runner = getBuildRunner()
  for (const { id, machineId } of timedOut) {
    if (!machineId || !runner) continue
    await runner.stop(machineId)
      .catch((err) => console.error(`[build-sweep] stopping the machine of import ${id} failed:`, err instanceof Error ? err.message : err))
  }
  return timedOut.length
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
