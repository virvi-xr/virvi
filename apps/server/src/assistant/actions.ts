// Virvi Assistant (LIV-155): the action log. Every tool call is a row; a single write runs straight away and offers
// Undo; two or more writes are a plan the user approves once, with a signed single-use token bound to the stored args.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import type { AssistantActionView, AssistantPlanView } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assistantActions } from '../db/schema.js'
import { config } from '../config.js'
import { recordJobFailure } from '../errors/record.js'
import { redact, redactText } from './redact.js'
import { TOOLS } from './tools/index.js'
import { inject, runTool, type ToolResult } from './tools/run.js'
import { ToolError, type Call, type ToolCtx } from './tools/types.js'

export const PLAN_TTL_MS = 10 * 60 * 1000
export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const MIN_STEPS = 2
const MAX_STEPS = 10

type Row = typeof assistantActions.$inferSelect
type UndoError = 'not_found' | 'not_undoable' | 'changed' | 'expired'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** JSON with object keys sorted at every level, so equal values hash and compare equal (jsonb reorders keys). */
function canonical(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}
export const argsHash = (args: unknown) => sha256(canonical(args))

const enabled = (name: string) => (Object.hasOwn(TOOLS, name) && !config.assistantDisabledTools.includes(name) ? TOOLS[name] : undefined)
/** The args as the tool parses them (trimmed, defaults): what runs, is stored and is hashed. */
function parseArgs(name: string, args: unknown): unknown {
  const parsed = enabled(name)?.input.safeParse(args ?? {})
  return parsed?.success ? parsed.data : args
}

const doneAt = (r: Row) => (r.finishedAt ?? r.createdAt).getTime()

export function actionView(row: Row): AssistantActionView {
  return {
    id: row.id,
    tool: row.tool,
    label: row.label,
    orgName: row.orgName,
    status: row.status,
    canUndo: row.status === 'done' && row.undo != null && Date.now() - doneAt(row) < UNDO_WINDOW_MS,
    error: row.error,
    planId: row.planId,
    step: row.step,
    detail: row.detail,
  }
}

/** The columns a finished run sets. `undo` and `after` hold the user's exact values: they never leave the server. */
function finished(r: ToolResult) {
  return r.ok
    ? { status: 'done' as const, resultSummary: JSON.stringify(r.summary ?? null), error: null, undo: r.undo, after: r.after ?? null, orgName: r.orgName, finishedAt: new Date() }
    : { status: 'failed' as const, error: r.error, finishedAt: new Date(), ...(r.orgName != null ? { orgName: r.orgName } : {}) }
}

/** Runs a tool, logs it, and gives back the run's result as well (Task 7 hands its summary to the model). */
export async function runAndRecord(ctx: ToolCtx, conversationId: string | null, name: string, args: unknown): Promise<{ action: AssistantActionView; result: ToolResult }> {
  const def = enabled(name)
  const exact = parseArgs(name, args)
  const write = def?.effect === 'write'
  let result: ToolResult
  try {
    result = await runTool(ctx, name, args)
  } catch (err) {
    recordJobFailure('assistant', err, { orgId: ctx.user.orgId })
    result = { ok: false, status: 500, error: 'The action failed. Try again.', label: def ? safeLabel(def, exact, name) : name }
  }
  const [row] = await db
    .insert(assistantActions)
    .values({
      conversationId,
      userId: ctx.user.id,
      orgId: ctx.user.orgId,
      tool: name,
      effect: write ? 'write' : 'read',
      argsRedacted: redact(exact ?? {}, ctx.self) as object,
      args: write ? (exact as object) : null,
      argsHash: argsHash(exact),
      label: result.label,
      ...finished(result),
    })
    .returning()
  return { action: actionView(row), result }
}

function safeLabel(def: (typeof TOOLS)[string], args: unknown, name: string): string {
  try {
    return def.label(args)
  } catch {
    return name
  }
}

export async function recordDirect(ctx: ToolCtx, conversationId: string | null, name: string, args: unknown): Promise<AssistantActionView> {
  return (await runAndRecord(ctx, conversationId, name, args)).action
}

function sign(planId: string, userId: string, stepHashes: string[], expiresAtMs: number): string {
  return createHmac('sha256', config.jwtSecret).update(`${planId}.${userId}.${sha256(stepHashes.join(','))}.${expiresAtMs}`).digest('base64url')
}

export async function proposePlan(ctx: ToolCtx, conversationId: string | null, steps: Array<{ tool: string; args: unknown }>): Promise<AssistantPlanView | { error: string }> {
  if (!Array.isArray(steps) || steps.length < MIN_STEPS || steps.length > MAX_STEPS) {
    return { error: `A plan needs ${MIN_STEPS} to ${MAX_STEPS} changes. Run a single change on its own.` }
  }
  const safe = (text: string) => redact(text, ctx.self) as string
  const prepared: Array<{ tool: string; args: unknown; label: string; orgName: string | null }> = []
  for (const [i, s] of steps.entries()) {
    const n = `Step ${i + 1}`
    const def = typeof s?.tool === 'string' ? enabled(s.tool) : undefined
    if (!def) return { error: `${n}: there's no tool called ${safe(String(s?.tool))}.` }
    if (def.effect === 'paid') return { error: `${n}: ${def.name} needs its own confirmation, so it can't be in a plan. Call it on its own.` }
    if (def.effect !== 'write' || !def.before) return { error: `${n}: ${def.name} only reads, so it doesn't belong in a plan. Call it directly.` }
    const parsed = def.input.safeParse(s.args ?? {})
    if (!parsed.success) {
      return { error: safe(`${n}: ${parsed.error.issues.map((x) => (x.path.length ? `${x.path.join('.')}: ${x.message}` : x.message)).join('; ')}`) }
    }
    // Read-only: names the organization, and refuses now (the route's 403/404) a target that isn't the user's
    let orgName: string | null
    try {
      orgName = (await def.before(parsed.data, ctx)).orgName
    } catch (err) {
      if (err instanceof ToolError) return { error: safe(`${n}: ${err.message}`) }
      throw err
    }
    prepared.push({ tool: def.name, args: parsed.data, label: def.label(parsed.data), orgName })
  }

  const planId = randomUUID()
  const expiresAtMs = Date.now() + PLAN_TTL_MS
  const hashes = prepared.map((p) => argsHash(p.args))
  const token = `${sign(planId, ctx.user.id, hashes, expiresAtMs)}.${expiresAtMs}`
  const rows = await db
    .insert(assistantActions)
    .values(
      prepared.map((p, i) => ({
        conversationId,
        userId: ctx.user.id,
        orgId: ctx.user.orgId,
        planId,
        step: i + 1,
        tool: p.tool,
        effect: 'write' as const,
        argsRedacted: redact(p.args, ctx.self) as object,
        args: p.args as object,
        argsHash: hashes[i],
        label: p.label,
        orgName: p.orgName,
        status: 'awaiting_confirmation' as const,
        confirmationTokenHash: sha256(token),
        expiresAt: new Date(expiresAtMs),
      })),
    )
    .returning()
  rows.sort((a, b) => a.step! - b.step!)
  return { planId, kind: 'plan', detail: null, steps: rows.map(actionView), token, expiresAt: new Date(expiresAtMs).toISOString() }
}

/**
 * A card: a one-row plan for one paid tool call, with its own token and a server-written cost line. A blocked preview
 * (nothing left to spend) writes no row. approvePlan and cancelPlan work on it unchanged.
 */
export async function proposeCard(
  ctx: ToolCtx,
  conversationId: string | null,
  name: string,
  args: unknown,
): Promise<AssistantPlanView | { error: string } | { blocked: string; link: { label: string; href: string } }> {
  const safe = (text: string) => redact(text, ctx.self) as string
  const def = enabled(name)
  if (!def) return { error: `There's no tool called ${safe(String(name))}.` }
  if (def.effect !== 'paid' || !def.before || !def.preview) return { error: `${def.name} isn't a paid tool, so it doesn't need a card. Call it directly.` }
  const parsed = def.input.safeParse(args ?? {})
  if (!parsed.success) return { error: safe(parsed.error.issues.map((x) => (x.path.length ? `${x.path.join('.')}: ${x.message}` : x.message)).join('; ')) }

  let orgName: string | null
  let preview: Awaited<ReturnType<NonNullable<typeof def.preview>>>
  try {
    orgName = (await def.before(parsed.data, ctx)).orgName
    preview = await def.preview(parsed.data, ctx)
  } catch (err) {
    if (err instanceof ToolError) return { error: safe(err.message) }
    throw err
  }
  if ('blocked' in preview) return preview
  // The card shows what will be sent, whole: masked like every shown string, never shortened
  const label = redactText(def.label(parsed.data), ctx.self)
  const detail = redactText(preview.detail, ctx.self)

  const planId = randomUUID()
  const expiresAtMs = Date.now() + PLAN_TTL_MS
  const hash = argsHash(parsed.data)
  const token = `${sign(planId, ctx.user.id, [hash], expiresAtMs)}.${expiresAtMs}`
  const [row] = await db
    .insert(assistantActions)
    .values({
      conversationId,
      userId: ctx.user.id,
      orgId: ctx.user.orgId,
      planId,
      step: 1,
      tool: def.name,
      effect: 'paid',
      argsRedacted: redact(parsed.data, ctx.self) as object,
      args: parsed.data as object,
      argsHash: hash,
      label,
      orgName,
      detail,
      status: 'awaiting_confirmation',
      confirmationTokenHash: sha256(token),
      expiresAt: new Date(expiresAtMs),
    })
    .returning()
  return { planId, kind: 'card', detail, steps: [actionView(row)], token, expiresAt: new Date(expiresAtMs).toISOString() }
}

/** True when `token` is this server's signature over the plan's stored steps for this user. */
function tokenMatches(token: string, planId: string, userId: string, rows: Row[]): boolean {
  const m = /^([A-Za-z0-9_-]{43})\.(\d{13})$/.exec(token)
  if (!m) return false
  const expected = Buffer.from(sign(planId, userId, rows.map((r) => r.argsHash), Number(m[2])))
  const given = Buffer.from(m[1])
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
  const hash = Buffer.from(sha256(token))
  return rows.every((r) => r.confirmationTokenHash != null && timingSafeEqual(Buffer.from(r.confirmationTokenHash), hash))
}

export async function approvePlan(
  ctx: ToolCtx,
  planId: string,
  token: string,
  onStep: (a: AssistantActionView) => void,
): Promise<{ done: number; failed: AssistantActionView | null } | { error: 'invalid_token' | 'expired' | 'used' }> {
  if (typeof planId !== 'string' || !UUID.test(planId) || typeof token !== 'string') return { error: 'invalid_token' }
  const userId = ctx.user.id
  const rows = await db.select().from(assistantActions).where(and(eq(assistantActions.planId, planId), eq(assistantActions.userId, userId))).orderBy(assistantActions.step)
  if (!rows.length || !tokenMatches(token, planId, userId, rows)) return { error: 'invalid_token' }

  // The claim is the single use: only one approval can move the rows out of awaiting_confirmation
  const claimed = await db
    .update(assistantActions)
    .set({ status: 'running' })
    .where(
      and(
        eq(assistantActions.planId, planId),
        eq(assistantActions.userId, userId),
        eq(assistantActions.confirmationTokenHash, sha256(token)),
        eq(assistantActions.status, 'awaiting_confirmation'),
        gt(assistantActions.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: assistantActions.id })
  if (!claimed.length) {
    // Read again: a concurrent approval may have claimed the rows since the read above
    const now = await db.select({ status: assistantActions.status }).from(assistantActions).where(and(eq(assistantActions.planId, planId), eq(assistantActions.userId, userId)))
    return { error: now.some((r) => r.status === 'awaiting_confirmation') ? 'expired' : 'used' }
  }

  const ids = new Set(claimed.map((c) => c.id))
  const todo = rows.filter((r) => ids.has(r.id))
  let done = 0
  for (const [i, step] of todo.entries()) {
    let result: ToolResult
    if (argsHash(step.args) !== step.argsHash) {
      result = { ok: false, status: 409, error: "This step's details changed after you approved them, so it didn't run.", label: step.label }
    } else {
      try {
        // The args stored when the plan was proposed: nothing from the approval request reaches the tool
        result = await runTool(ctx, step.tool, step.args)
      } catch (err) {
        recordJobFailure('assistant', err, { orgId: ctx.user.orgId })
        result = { ok: false, status: 500, error: 'The step failed. Try again.', label: step.label }
      }
    }
    const [row] = await db.update(assistantActions).set(finished(result)).where(eq(assistantActions.id, step.id)).returning()
    onStep(actionView(row))
    if (!result.ok) {
      const rest = todo.slice(i + 1).map((r) => r.id)
      for (const id of rest) {
        const [c] = await db.update(assistantActions).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(assistantActions.id, id)).returning()
        onStep(actionView(c))
      }
      return { done, failed: actionView(row) }
    }
    done++
  }
  return { done, failed: null }
}

/** The plan's steps still waiting for approval are cancelled; returns how many. */
export async function cancelPlan(userId: string, planId: string): Promise<number> {
  if (!UUID.test(planId)) return 0
  const rows = await db
    .update(assistantActions)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(assistantActions.planId, planId), eq(assistantActions.userId, userId), eq(assistantActions.status, 'awaiting_confirmation')))
    .returning({ id: assistantActions.id })
  return rows.length
}

/** True when every field the write set still holds the value it left. */
function unchanged(current: unknown, after: unknown): boolean {
  if (!after || typeof after !== 'object') return true
  const now = (current ?? {}) as Record<string, unknown>
  return Object.entries(after as Record<string, unknown>).every(([k, v]) => canonical(now[k] ?? null) === canonical(v ?? null))
}

export async function undoAction(ctx: ToolCtx, actionId: string): Promise<AssistantActionView | { error: UndoError }> {
  if (typeof actionId !== 'string' || !UUID.test(actionId)) return { error: 'not_found' }
  const [row] = await db.select().from(assistantActions).where(and(eq(assistantActions.id, actionId), eq(assistantActions.userId, ctx.user.id)))
  if (!row) return { error: 'not_found' }
  if (row.status !== 'done' || row.undo == null) return { error: 'not_undoable' }
  if (Date.now() - doneAt(row) >= UNDO_WINDOW_MS) return { error: 'expired' }

  // Read the target again: a newer edit (by hand, or elsewhere) is never overwritten. A target that's gone is changed too.
  const def = Object.hasOwn(TOOLS, row.tool) ? TOOLS[row.tool] : undefined
  if (def && row.args != null) {
    try {
      if (def.currentOf) {
        // A create: the created row, re-read by its id; gone or edited since is changed
        const now = await def.currentOf(row.after, row.args, ctx)
        if (now == null || !unchanged(now, row.after)) return { error: 'changed' }
      } else if (def.before) {
        const now = await def.before(row.args, ctx)
        if (now.current !== undefined && !unchanged(now.current, row.after)) return { error: 'changed' }
      }
    } catch (err) {
      if (err instanceof ToolError) return { error: err.status === 404 ? 'changed' : 'not_undoable' }
      throw err
    }
  }

  // Claim it first, so two Undo clicks can't both run
  const [claimed] = await db
    .update(assistantActions)
    .set({ status: 'undone', finishedAt: new Date() })
    .where(and(eq(assistantActions.id, row.id), eq(assistantActions.status, 'done')))
    .returning()
  if (!claimed) return { error: 'not_undoable' }
  const release = () => db.update(assistantActions).set({ status: 'done', finishedAt: row.finishedAt }).where(eq(assistantActions.id, row.id))
  let res: { status: number }
  try {
    res = await inject(ctx, row.undo as Call)
  } catch (err) {
    await release()
    throw err
  }
  if (res.status >= 400) {
    await release()
    return { error: res.status === 404 ? 'changed' : 'not_undoable' }
  }
  return actionView(claimed)
}

/** Undoes the plan's done steps, last first, stopping at the first refusal. */
export async function undoPlan(
  ctx: ToolCtx,
  planId: string,
): Promise<{ undone: AssistantActionView[]; refused: { action: AssistantActionView; error: UndoError } | null } | { error: 'not_found' }> {
  if (typeof planId !== 'string' || !UUID.test(planId)) return { error: 'not_found' }
  const rows = await db.select().from(assistantActions).where(and(eq(assistantActions.planId, planId), eq(assistantActions.userId, ctx.user.id))).orderBy(desc(assistantActions.step))
  if (!rows.length) return { error: 'not_found' }
  const undone: AssistantActionView[] = []
  for (const row of rows.filter((r) => r.status === 'done')) {
    const r = await undoAction(ctx, row.id)
    // An action view has an `error` field of its own (null): tell the two apart by `id`
    if (!('id' in r)) return { undone, refused: { action: actionView(row), error: r.error } }
    undone.push(r)
  }
  return { undone, refused: null }
}
