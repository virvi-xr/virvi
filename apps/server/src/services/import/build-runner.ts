import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { sceneImports } from '../../db/schema.js'
import { config } from '../../config.js'
import { FlyApi } from '../../hyperfy/fly.js'
import { getImportStore } from '../../storage/private-store.js'
import { ImportError } from './scene-zip.js'

/**
 * Starts the build box (apps/scene-builder) for an uploaded scene. Each build gets a fresh 32-byte token, of which only
 * the SHA-256 is stored; the box holds the token and nothing else of Virvi's. routes/import-build.ts is the other end
 * of the wire contract in apps/scene-builder/README.md, and build-sweep.ts fails builds that never report back.
 */

export interface BuildRunner {
  start(importId: string, env: Record<string, string>): Promise<{ machineId: string }>
  stop(machineId: string): Promise<void>
}

export const BUILD_CPUS = 2
export const BUILD_MEMORY_MB = 4096
export const BUILD_FAILED_MESSAGE = "The scene didn't build. The build log says why."

export const hashBuildToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Constant-time check of a presented token against a stored hash; a missing hash never matches. */
export function buildTokenMatches(token: string, hash: string | null): boolean {
  if (!token || !hash) return false
  const a = Buffer.from(hashBuildToken(token), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export const builtKeyPrefix = (importId: string) => `imports/${importId}/built/`
export const buildLogKey = (importId: string) => `imports/${importId}/build.log`

/** One machine per build in the build app; it destroys itself on exit, and stop force-deletes it. */
export function flyBuildRunner(fly: Pick<FlyApi, 'createBuildMachine' | 'deleteMachine'>, app: string, image: string): BuildRunner {
  return {
    async start(importId, env) {
      const { id } = await fly.createBuildMachine(app, { name: `build-${importId}`, image, env, cpus: BUILD_CPUS, memoryMb: BUILD_MEMORY_MB })
      return { machineId: id }
    },
    async stop(machineId) {
      await fly.deleteMachine(app, machineId)
    },
  }
}

const BUILD_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scene-builder/build.mjs')

/**
 * Development only: runs build.mjs on this server, all steps in one process, in a temp dir. Nothing is isolated (the
 * scene's install scripts run as this server's user), so cloud mode never gets one.
 */
function localBuildRunner(): BuildRunner {
  const children = new Map<string, ChildProcess>()
  return {
    async start(_importId, env) {
      const dir = await mkdtemp(join(tmpdir(), 'virvi-build-'))
      // Only what npm needs besides the box's own variables; none of this server's settings
      const child = spawn(process.execPath, [BUILD_SCRIPT], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir, ...env },
        stdio: 'ignore',
        detached: true,
      })
      const machineId = `local-${randomUUID()}`
      children.set(machineId, child)
      const done = () => {
        children.delete(machineId)
        rm(dir, { recursive: true, force: true }).catch(() => {})
      }
      child.once('exit', done)
      child.once('error', (err) => {
        console.error('[scene-build] local build failed to run:', err.message)
        done()
      })
      child.unref()
      return { machineId }
    },
    async stop(machineId) {
      const pid = children.get(machineId)?.pid
      if (!pid) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch { /* already gone */ }
    },
  }
}

let override: BuildRunner | null = null
let fly: { runner: BuildRunner; key: string } | null = null
let local: BuildRunner | null = null

/** The configured runner, or null when builds are off (or the runner isn't usable here). */
export function getBuildRunner(): BuildRunner | null {
  if (override) return override
  switch (config.sceneBuildRunner) {
    case 'fly': {
      if (!config.sceneBuildImage || !config.sceneBuildFlyToken) return null
      const key = `${config.sceneBuildFlyApp}\n${config.sceneBuildImage}`
      if (fly?.key !== key) {
        const api = new FlyApi({ token: config.sceneBuildFlyToken, org: config.flyWorldsOrg ?? '' })
        fly = { runner: flyBuildRunner(api, config.sceneBuildFlyApp, config.sceneBuildImage), key }
      }
      return fly.runner
    }
    case 'local':
      if (config.mode === 'cloud') return null
      return (local ??= localBuildRunner())
    default:
      return null
  }
}

/** Tests replace the runner for every caller; null goes back to the configured one. */
export function setBuildRunner(r: BuildRunner | null): void {
  override = r
}

/** False when an upload can't be built here; POST /api/imports answers 503 `builds_unavailable`. */
export function buildsAvailable(): boolean {
  return getBuildRunner() !== null
}

let onBuildDone: (importId: string) => Promise<void> = async () => {}

/** What runs once a build's files are stored (Task 7 deploys from here). */
export function getOnBuildDone(): (importId: string) => Promise<void> {
  return onBuildDone
}

export function setOnBuildDone(fn: ((importId: string) => Promise<void>) | null): void {
  onBuildDone = fn ?? (async () => {})
}

/**
 * Fails a building import with `build_failed`, storing `log` as its build log, and forgets the token. Conditional on
 * the import still building with the token `hash` (when given), so it happens once; false when it no longer was.
 */
export async function failBuild(importId: string, log: Buffer, hash?: string): Promise<boolean> {
  const conds = [eq(sceneImports.id, importId), eq(sceneImports.status, 'building')]
  if (hash) conds.push(eq(sceneImports.buildTokenHash, hash))
  const now = new Date()
  const failed = await db.update(sceneImports).set({
    status: 'failed',
    errorCode: 'build_failed',
    errorMessage: BUILD_FAILED_MESSAGE,
    logKey: buildLogKey(importId),
    buildTokenHash: null,
    finishedAt: now,
    updatedAt: now,
  }).where(and(...conds)).returning({ id: sceneImports.id })
  if (!failed.length) return false
  // The transition is what counts: a log that can't be stored leaves the import failed without one
  await getImportStore().put(buildLogKey(importId), log, 'text/plain; charset=utf-8')
    .catch((err) => console.error(`[scene-build] storing the build log of import ${importId} failed:`, err instanceof Error ? err.message : err))
  return true
}

const plain = (err: unknown, secret: string) => (err instanceof Error ? err.message : String(err)).split(secret).join('[redacted]')

/** Starts the build of an uploaded import: status `building`, then its machine. A machine that won't start fails it. */
export async function startBuild(importId: string): Promise<void> {
  const runner = getBuildRunner()
  if (!runner) throw new ImportError(503, 'builds_unavailable', 'Scene builds are not available right now.')
  const token = randomBytes(32).toString('base64url')
  const hash = hashBuildToken(token)
  const now = new Date()
  const claimed = await db.update(sceneImports)
    .set({ status: 'building', buildTokenHash: hash, machineId: null, updatedAt: now })
    .where(and(eq(sceneImports.id, importId), eq(sceneImports.status, 'uploaded')))
    .returning({ id: sceneImports.id })
  if (!claimed.length) throw new ImportError(409, 'not_uploaded', 'This import is not waiting for a build.')

  const base = `${config.publicUrl.replace(/\/+$/, '')}/api/imports/build/${importId}`
  const env = {
    BUILD_SOURCE_URL: `${base}/source`,
    BUILD_RESULT_URL: `${base}/result`,
    BUILD_FAILED_URL: `${base}/failed`,
    BUILD_TOKEN: token,
    VIRVI_API_HOST: new URL(config.publicUrl).hostname,
  }
  let machineId: string
  try {
    ;({ machineId } = await runner.start(importId, env))
  } catch (err) {
    const msg = plain(err, token)
    console.error(`[scene-build] the build machine for import ${importId} could not start: ${msg}`)
    await failBuild(importId, Buffer.from('[virvi] The build machine could not start. Try the upload again in a few minutes.\n'), hash)
    return
  }
  // A fast build may already have reported; only a build still holding this token takes the machine id
  await db.update(sceneImports).set({ machineId })
    .where(and(eq(sceneImports.id, importId), eq(sceneImports.buildTokenHash, hash)))
}
