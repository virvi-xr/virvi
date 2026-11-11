import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns } from '../db/schema.js'
import { config } from '../config.js'
import { FlyApi, FlyError } from '../hyperfy/fly.js'
import type { MachineAction } from './timings.js'

/**
 * One Fly worker machine per design (apps/studio-worker), created on its first job and started for later ones. The
 * worker exits when idle and the machine stops; the sweep destroys machines idle for days. Each machine gets a fresh
 * worker token, of which only the SHA-256 is stored.
 */

export class StudioMachineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioMachineError'
  }
}

export type MachineDeps = {
  fly: Pick<FlyApi, 'createWorkerMachine' | 'getMachine' | 'getMachineState' | 'startMachine' | 'deleteMachine'>
  now: () => Date
}

let fly: FlyApi | null = null
let overrides: Partial<MachineDeps> | null = null

export function machineDeps(): MachineDeps {
  return {
    fly: (fly ??= new FlyApi({ token: config.flyApiToken ?? '', org: config.flyWorldsOrg ?? '' })),
    now: () => new Date(),
    ...overrides,
  }
}

/** Tests replace Fly (and the clock) for every caller, routes included. */
export function setMachineDeps(d: Partial<MachineDeps> | null): void {
  overrides = d
}

export const hashWorkerToken = (token: string) => createHash('sha256').update(token).digest('hex')

const CLAIM_STALE_MS = 2 * 60_000
const DEAD = ['destroyed', 'destroying', 'failed']
const IDLE_EXIT_SEC = '600'
/** Fly reports an image with its digest (`repo:tag@sha256:…`); the tag is what STUDIO_WORKER_IMAGE names. */
export const sameImage = (a: string | null, b: string) => (a ?? '').split('@')[0] === b.split('@')[0]

function plain(err: unknown, secret?: string): string {
  let msg = err instanceof Error ? err.message : String(err)
  if (secret) msg = msg.split(secret).join('[redacted]')
  return msg
}

/**
 * Makes sure the design has a machine that is running or about to run, so its queued job gets taken (or, with no job,
 * so it boots and waits for one: POST /designs/:id/warm). Says what it did: `created` a machine (or another request
 * is creating it), `started` a stopped one, found one `running` (or starting), or nothing, the worker being run by
 * hand (`external`).
 */
export async function ensureWorker(designId: string, deps: Partial<MachineDeps> = {}): Promise<MachineAction> {
  if (config.studioMachines === 'external') return 'external' // the worker is run by hand
  const d = { ...machineDeps(), ...deps }
  const app = config.studioFlyApp
  const [design] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId))
  if (!design) throw new StudioMachineError('The design no longer exists.')

  if (design.machineId) {
    let machine: { state: string; image: string | null } | null
    try {
      machine = await d.fly.getMachine(app, design.machineId)
    } catch (err) {
      throw new StudioMachineError(`The studio machine could not be reached: ${plain(err)}`)
    }
    const state = machine?.state ?? null
    // A machine keeps the image it was made with: a stopped one on an older worker is replaced, so a new
    // STUDIO_WORKER_IMAGE reaches every design. A running one finishes its job first.
    const outdated = !!machine && !!config.studioWorkerImage && (state === 'stopped' || state === 'suspended') &&
      !sameImage(machine.image, config.studioWorkerImage)
    if (outdated) {
      try {
        await d.fly.deleteMachine(app, design.machineId)
      } catch (err) {
        throw new StudioMachineError(`The studio machine could not be updated: ${plain(err)}`)
      }
    }
    if (outdated || state === null || DEAD.includes(state)) {
      // Destroyed outside Virvi (Fly reports `destroyed` for a while before 404) or failed: forget it and make a new one
      await db.update(studioDesigns).set({ machineId: null, workerTokenHash: null })
        .where(and(eq(studioDesigns.id, designId), eq(studioDesigns.machineId, design.machineId)))
    } else if (state === 'stopped' || state === 'suspended' || state === 'stopping') {
      try {
        await d.fly.startMachine(app, design.machineId)
      } catch (err) {
        // Mid-stop, Fly refuses a start; the sweep starts it again for a job still waiting a minute later
        if (state === 'stopping') return 'started'
        const raced = err instanceof FlyError && (err.status === 412 || /already/i.test(err.message))
        const now = raced ? await d.fly.getMachineState(app, design.machineId).catch(() => null) : null
        if (now !== 'started' && now !== 'starting') {
          throw new StudioMachineError(`The studio machine could not start: ${plain(err)}`)
        }
      }
      return 'started'
    } else {
      return 'running' // started, starting, created
    }
  }

  if (!config.studioWorkerImage) throw new StudioMachineError('The studio is not configured (STUDIO_WORKER_IMAGE).')
  const now = d.now()
  // The claim stores the new token's hash, so the machine's first call can authenticate however fast it boots
  const token = randomBytes(32).toString('base64url')
  const claimed = await db.update(studioDesigns)
    .set({ machineClaimedAt: now, workerTokenHash: hashWorkerToken(token) })
    .where(and(
      eq(studioDesigns.id, designId),
      isNull(studioDesigns.machineId),
      or(isNull(studioDesigns.machineClaimedAt), lt(studioDesigns.machineClaimedAt, new Date(now.getTime() - CLAIM_STALE_MS))),
    ))
    .returning({ id: studioDesigns.id })
  if (!claimed.length) return 'created' // another request is creating it; that machine takes the job

  const release = () => db.update(studioDesigns).set({ machineClaimedAt: null, workerTokenHash: null })
    .where(and(eq(studioDesigns.id, designId), isNull(studioDesigns.machineId)))
  let id: string
  try {
    ;({ id } = await d.fly.createWorkerMachine(app, {
      name: `design-${designId}`,
      image: config.studioWorkerImage,
      env: {
        VIRVI_API_URL: config.publicUrl,
        STUDIO_WORKER_TOKEN: token,
        STUDIO_DESIGN_ID: designId,
        STUDIO_IDLE_EXIT_SEC: IDLE_EXIT_SEC,
      },
    }))
  } catch (err) {
    await release()
    throw new StudioMachineError(`The studio machine could not be created: ${plain(err, token)}`)
  }
  await db.update(studioDesigns).set({ machineId: id, machineClaimedAt: null }).where(eq(studioDesigns.id, designId))
  return 'created'
}

/** Deletes the design's machine and forgets its token; a later job creates a new one. */
export async function destroyWorker(designId: string, deps: Partial<MachineDeps> = {}): Promise<void> {
  if (config.studioMachines === 'external') return
  const d = { ...machineDeps(), ...deps }
  const [design] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId))
  if (!design?.machineId) return
  await d.fly.deleteMachine(config.studioFlyApp, design.machineId)
  await db.update(studioDesigns).set({ machineId: null, workerTokenHash: null })
    .where(and(eq(studioDesigns.id, designId), eq(studioDesigns.machineId, design.machineId)))
}
