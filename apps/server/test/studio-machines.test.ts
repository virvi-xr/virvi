import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { ensureWorker, destroyWorker, hashWorkerToken, StudioMachineError } from '../src/studio/machines.js'
import { FlyError } from '../src/hyperfy/fly.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { createDesign, fakeFly } from './helpers/studio.js'

const row = async (id: string) => (await db.select().from(studioDesigns).where(eq(studioDesigns.id, id)))[0]

describe('studio worker machines', () => {
  const prev = config.studioWorkerImage
  beforeAll(() => { (config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test' })
  afterAll(() => { (config as any).studioWorkerImage = prev })
  beforeEach(resetDb)

  it("creates one machine with the worker's env and a hashed token", async () => {
    const fly = fakeFly()
    const d = await createDesign(await createUser())
    await ensureWorker(d.id, { fly })
    expect(fly.calls.create).toHaveLength(1)
    const spec = fly.calls.create[0]
    expect(spec.name).toBe(`design-${d.id}`)
    expect(spec.image).toBe('registry.fly.io/vlm-studio-worker:test')
    expect(spec.env).toMatchObject({ VIRVI_API_URL: config.publicUrl, STUDIO_DESIGN_ID: d.id, STUDIO_IDLE_EXIT_SEC: '600' })
    expect(spec.env.STUDIO_WORKER_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(spec.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(spec.env).not.toHaveProperty('OPENAI_API_KEY')
    const r = await row(d.id)
    expect(r.machineId).toBe('m1')
    expect(r.workerTokenHash).toBe(hashWorkerToken(spec.env.STUDIO_WORKER_TOKEN))
    expect(r.machineClaimedAt).toBeNull()
  })

  it('concurrent ensureWorker creates once', async () => {
    const fly = fakeFly()
    const d = await createDesign(await createUser())
    await Promise.all(Array.from({ length: 5 }, () => ensureWorker(d.id, { fly })))
    expect(fly.calls.create).toHaveLength(1)
  })

  it('a stopped machine is started, a running one left alone', async () => {
    const fly = fakeFly()
    const d = await createDesign(await createUser())
    expect(await ensureWorker(d.id, { fly })).toBe('created')
    expect(await ensureWorker(d.id, { fly })).toBe('running')
    expect(fly.calls.start).toHaveLength(0)
    fly.machines.get('m1')!.state = 'stopped'
    expect(await ensureWorker(d.id, { fly })).toBe('started')
    expect(fly.calls.start).toEqual(['m1'])
    expect(fly.calls.create).toHaveLength(1)
  })

  it('a machine destroyed outside Virvi is recreated', async () => {
    const fly = fakeFly()
    const d = await createDesign(await createUser())
    await ensureWorker(d.id, { fly })
    const first = (await row(d.id)).workerTokenHash
    fly.machines.clear()
    await ensureWorker(d.id, { fly })
    expect(fly.calls.create).toHaveLength(2)
    const r = await row(d.id)
    expect(r.machineId).toBe('m2')
    expect(r.workerTokenHash).not.toBe(first)
  })

  it('a machine Fly reports destroyed or failed is replaced', async () => {
    for (const state of ['destroyed', 'destroying', 'failed']) {
      const fly = fakeFly()
      const d = await createDesign(await createUser())
      await ensureWorker(d.id, { fly })
      fly.machines.get('m1')!.state = state
      await ensureWorker(d.id, { fly })
      expect(fly.calls.create, state).toHaveLength(2)
      expect((await row(d.id)).machineId).toBe('m2')
    }
  })

  it('a stopped machine on an older worker image is replaced by one on the current image', async () => {
    const fly = fakeFly()
    const d = await createDesign(await createUser())
    await ensureWorker(d.id, { fly })
    fly.machines.get('m1')!.state = 'stopped'
    fly.machines.get('m1')!.spec.image = 'registry.fly.io/vlm-studio-worker:old'
    await ensureWorker(d.id, { fly })
    expect(fly.calls.del).toEqual(['m1'])
    expect(fly.calls.start).toHaveLength(0)
    expect(fly.calls.create).toHaveLength(2)
    expect(fly.calls.create[1].image).toBe('registry.fly.io/vlm-studio-worker:test')
    expect((await row(d.id)).machineId).toBe('m2')
  })

  it('a running machine on an older image is left to finish; it is replaced once stopped', async () => {
    const fly = fakeFly()
    const d = await createDesign(await createUser())
    await ensureWorker(d.id, { fly })
    fly.machines.get('m1')!.spec.image = 'registry.fly.io/vlm-studio-worker:old'
    await ensureWorker(d.id, { fly })
    expect(fly.calls.del).toHaveLength(0)
    expect(fly.calls.create).toHaveLength(1)
  })

  it('the image Fly reports with its digest is the same image', async () => {
    const fly = fakeFly()
    const d = await createDesign(await createUser())
    await ensureWorker(d.id, { fly })
    fly.machines.get('m1')!.state = 'stopped'
    fly.machines.get('m1')!.spec.image = 'registry.fly.io/vlm-studio-worker:test@sha256:f71a81ab'
    await ensureWorker(d.id, { fly })
    expect(fly.calls.del).toHaveLength(0)
    expect(fly.calls.start).toEqual(['m1'])
  })

  it('a stopping machine that refuses to start is left for the sweep, not failed', async () => {
    const fly = fakeFly()
    const d = await createDesign(await createUser())
    await ensureWorker(d.id, { fly })
    fly.machines.get('m1')!.state = 'stopping'
    fly.startMachine = async () => { throw new FlyError('Fly POST start returned 412: machine is stopping', 412, '') }
    await expect(ensureWorker(d.id, { fly })).resolves.toBe('started')
  })

  it('the token hash is stored before the machine can call in', async () => {
    const fly = fakeFly()
    const d = await createDesign(await createUser())
    let hashAtCreate: string | null | undefined
    const create = fly.createWorkerMachine
    fly.createWorkerMachine = async (app, spec) => {
      hashAtCreate = (await row(d.id)).workerTokenHash
      return create(app, spec)
    }
    await ensureWorker(d.id, { fly })
    expect(hashAtCreate).toBe(hashWorkerToken(fly.calls.create[0].env.STUDIO_WORKER_TOKEN))
  })

  it('fly failure is a StudioMachineError with no token in its message', async () => {
    const fly = fakeFly()
    fly.failCreate = (spec) => new Error(`Fly said no to ${JSON.stringify(spec.env)}`)
    const d = await createDesign(await createUser())
    const err = await ensureWorker(d.id, { fly }).catch((e) => e)
    expect(err).toBeInstanceOf(StudioMachineError)
    expect(err.message).not.toContain(fly.calls.create[0].env.STUDIO_WORKER_TOKEN)
    const r = await row(d.id)
    expect(r.machineId).toBeNull()
    expect(r.machineClaimedAt).toBeNull()
    fly.failCreate = null
    await ensureWorker(d.id, { fly })
    expect((await row(d.id)).machineId).toBe('m1')
  })

  it('external machines (a worker started by hand) are never created or started', async () => {
    const fly = fakeFly()
    const d = await createDesign(await createUser(), { machineId: 'local', workerTokenHash: 'h' })
    ;(config as any).studioMachines = 'external'
    try {
      await ensureWorker(d.id, { fly })
      await ensureWorker((await createDesign(await createUser())).id, { fly })
      await destroyWorker(d.id, { fly })
    } finally {
      ;(config as any).studioMachines = 'fly'
    }
    expect(fly.calls.create).toHaveLength(0)
    expect(fly.calls.del).toHaveLength(0)
    expect((await row(d.id)).workerTokenHash).toBe('h')
  })

  it('destroyWorker deletes the machine and forgets the token', async () => {
    const fly = fakeFly()
    const d = await createDesign(await createUser())
    await ensureWorker(d.id, { fly })
    await destroyWorker(d.id, { fly })
    expect(fly.calls.del).toEqual(['m1'])
    const r = await row(d.id)
    expect(r.machineId).toBeNull()
    expect(r.workerTokenHash).toBeNull()
  })
})
