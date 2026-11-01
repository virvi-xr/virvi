import { db } from '../../src/db/connection.js'
import { studioDesigns, studioJobs } from '../../src/db/schema.js'
import type { WorkerMachineSpec } from '../../src/hyperfy/fly.js'
import type { TestUser } from './factories.js'

/** A Fly that keeps machines in memory and records what it was asked to do. */
export function fakeFly() {
  const machines = new Map<string, { state: string; spec: WorkerMachineSpec }>()
  const calls = { create: [] as WorkerMachineSpec[], start: [] as string[], del: [] as string[] }
  let n = 0
  const fly = {
    calls,
    machines,
    failCreate: null as null | ((spec: WorkerMachineSpec) => Error),
    async createWorkerMachine(_app: string, spec: WorkerMachineSpec) {
      calls.create.push(spec)
      if (fly.failCreate) throw fly.failCreate(spec)
      await new Promise((r) => setTimeout(r, 5))
      const id = `m${++n}`
      machines.set(id, { state: 'started', spec })
      return { id }
    },
    async getMachineState(_app: string, id: string) {
      return machines.get(id)?.state ?? null
    },
    async getMachine(_app: string, id: string) {
      const m = machines.get(id)
      return m ? { state: m.state, image: m.spec.image } : null
    },
    async startMachine(_app: string, id: string) {
      calls.start.push(id)
      const m = machines.get(id)
      if (m) m.state = 'started'
    },
    async deleteMachine(_app: string, id: string) {
      calls.del.push(id)
      machines.delete(id)
    },
  }
  return fly
}

export async function createDesign(
  user: TestUser,
  opts: Partial<typeof studioDesigns.$inferInsert> = {},
) {
  const [d] = await db.insert(studioDesigns)
    .values({ ownerId: user.id, name: 'Neon cap', kind: 'wearable', agent: 'claude', ...opts })
    .returning()
  return d
}

/** Gives the design a worker token, as ensureWorker would, and returns it. */
export async function issueWorker(design: { id: string }, machineId = 'm-test') {
  const { randomBytes } = await import('node:crypto')
  const { hashWorkerToken } = await import('../../src/studio/machines.js')
  const { eq } = await import('drizzle-orm')
  const token = randomBytes(32).toString('base64url')
  await db.update(studioDesigns).set({ machineId, workerTokenHash: hashWorkerToken(token) }).where(eq(studioDesigns.id, design.id))
  return token
}

export const PROMPT_PAYLOAD = {
  type: 'prompt',
  kind: 'wearable',
  agent: 'claude',
  model: 'claude-opus-5-5',
  prompt: 'a neon cap with a glowing visor',
  selectedSlots: ['hat'],
  limits: { timeoutSec: 1500, maxTurns: 80, costCeilingUsd: 3 },
  render: null,
}

export async function queueJob(
  design: { id: string },
  payload: Record<string, unknown> = PROMPT_PAYLOAD,
  opts: Partial<typeof studioJobs.$inferInsert> = {},
) {
  const [j] = await db.insert(studioJobs)
    .values({ designId: design.id, type: String(payload.type), payload, ...opts })
    .returning()
  return j
}

/** The CONTRACT.md Result example, for a job. */
export function okResult(jobId: string, over: Record<string, unknown> = {}) {
  return {
    jobId,
    outcome: 'ok',
    agent: 'claude',
    model: 'claude-opus-5-5',
    skillsSha: '3430ce2ef5b7f9d388fcb7c923f50e0dcb505420',
    wallSec: 412.3,
    tokens: { input: 2100, cachedInput: 820000, cacheWrite: 61000, output: 18000 },
    costUsd: 0.74,
    reply: 'I built a rounded cap with a neon visor strip...',
    proposal: null,
    pieces: [{
      category: 'hat',
      changed: true,
      changeKind: 'new',
      meta: { name: 'Neon Cap', description: '...', category: 'hat', hides: [], replaces: [], tags: ['cyberpunk'], changeKind: 'new' },
      checker: { pass: true, failures: 0, warnings: 1 },
      files: ['pieces/hat/neon_cap_male.glb', 'pieces/hat/neon_cap_female.glb', 'pieces/hat/piece.json', 'checks/hat.txt'],
      renders: { 'spin-male-default': 36 },
    }],
    error: null,
    ...over,
  }
}

/** Gives the design's `category` piece a new latest revision (from a finished prompt job) and returns it. */
export async function addRevision(
  design: { id: string },
  category: string,
  checker: { pass: boolean; failures: number; warnings: number } = { pass: true, failures: 0, warnings: 0 },
) {
  const { studioPieces, studioRevisions } = await import('../../src/db/schema.js')
  const { eq, max } = await import('drizzle-orm')
  const [job] = await db.insert(studioJobs).values({ designId: design.id, type: 'prompt', status: 'done', payload: {} }).returning()
  const [piece] = await db.insert(studioPieces).values({ designId: design.id, category, name: `Neon ${category}` })
    .onConflictDoUpdate({ target: [studioPieces.designId, studioPieces.category], set: { name: `Neon ${category}` } })
    .returning()
  const [{ n }] = await db.select({ n: max(studioRevisions.number) }).from(studioRevisions).where(eq(studioRevisions.pieceId, piece.id))
  const files = [`pieces/${category}/neon_male.glb`, `pieces/${category}/neon_female.glb`, `pieces/${category}/piece.json`, `checks/${category}.txt`]
  const [rev] = await db.insert(studioRevisions).values({
    pieceId: piece.id, number: (n ?? 0) + 1, jobId: job.id, changeKind: n ? 'design' : 'new',
    meta: { name: `Neon ${category}`, category }, checker, files,
  }).returning()
  await db.update(studioPieces).set({ latestRevisionId: rev.id }).where(eq(studioPieces.id, piece.id))
  return rev
}

/** Marks a revision paid for, as a granted payment would: a paid payment and a ready entitlement. */
export async function entitle(
  design: { id: string; ownerId: string },
  rev: { id: string; pieceId: string },
  opts: { amountCents?: number; paidAt?: Date; paymentIntent?: string } = {},
) {
  const { studioPieces, studioEntitlements, studioPayments, studioDesigns: designs } = await import('../../src/db/schema.js')
  const { and, eq } = await import('drizzle-orm')
  const [piece] = await db.select().from(studioPieces).where(eq(studioPieces.id, rev.pieceId))
  const earlier = await db.select().from(studioEntitlements)
    .where(and(eq(studioEntitlements.designId, design.id), eq(studioEntitlements.category, piece.category)))
  const kind = earlier.length ? 'revision' : 'first'
  const amountCents = opts.amountCents ?? (kind === 'first' ? 2900 : 1500)
  const paidAt = opts.paidAt ?? new Date()
  const [payment] = await db.insert(studioPayments).values({
    userId: design.ownerId, designId: design.id, kind: 'finalize', status: 'paid', amountCents, paidAt,
    stripePaymentIntent: opts.paymentIntent ?? `pi_${rev.id.slice(0, 8)}`,
  }).returning()
  const [ent] = await db.insert(studioEntitlements).values({
    revisionId: rev.id, paymentId: payment.id, userId: design.ownerId, designId: design.id, category: piece.category,
    kind, amountCents, status: 'ready',
  }).returning()
  await db.update(designs).set({ finalizedAt: paidAt }).where(eq(designs.id, design.id))
  return { payment, entitlement: ent }
}

/** A Stripe client for studio payments that records what it was asked and answers like Stripe's test mode. */
export function fakeStripe() {
  let n = 0
  const calls = {
    sessions: [] as any[],
    expired: [] as string[],
    refunds: [] as { params: any; opts: any }[],
    customers: [] as any[],
  }
  const stripe = {
    calls,
    failRefunds: false,
    failSessions: false,
    // Sessions the customer has paid: Stripe refuses to expire them
    completedSessions: new Set<string>(),
    failExpire: false,
    customers: {
      async create(params: any) { calls.customers.push(params); return { id: `cus_${++n}` } },
    },
    checkout: {
      sessions: {
        async create(params: any) {
          if (stripe.failSessions) throw new Error('Stripe is down')
          calls.sessions.push(params)
          const id = ++n
          return { id: `cs_test_${id}`, url: `https://checkout.stripe.test/${id}` }
        },
        async expire(id: string) {
          calls.expired.push(id)
          if (stripe.failExpire) throw new Error('Stripe is down')
          if (stripe.completedSessions.has(id)) throw new Error(`Only Checkout Sessions with a status in [open] can be expired: ${id} is complete`)
          return { id, object: 'checkout.session', status: 'expired' }
        },
      },
    },
    // Refunds Stripe holds, as refunds.list returns them; a test can add one made "earlier"
    made: [] as { id: string; payment_intent: string; amount: number; metadata: Record<string, string> }[],
    hangRefunds: false,
    refunds: {
      async create(params: any, opts: any) {
        calls.refunds.push({ params, opts })
        if (stripe.hangRefunds) await new Promise(() => {})
        if (stripe.failRefunds) throw new Error('refund refused')
        const refund = { id: `re_${++n}`, payment_intent: params.payment_intent, amount: params.amount, metadata: params.metadata ?? {} }
        stripe.made.push(refund)
        return refund
      },
      async list(params: any) {
        return { data: stripe.made.filter((r) => r.payment_intent === params.payment_intent), has_more: false }
      },
    },
    subscriptions: {
      async retrieve(id: string) {
        return { id, items: { data: [{ price: { id: 'price_creator' } }] }, current_period_start: 1, current_period_end: 2, cancel_at_period_end: false }
      },
    },
  }
  return stripe
}
