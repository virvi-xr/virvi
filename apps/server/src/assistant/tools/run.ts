import { z } from 'zod'
import { config } from '../../config.js'
import { redact } from '../redact.js'
import { TOOLS } from './index.js'
import { ToolError, type Call, type ToolCtx } from './types.js'

export type ToolResult =
  | { ok: true; status: number; summary: unknown; undo: Call | null; after: unknown; orgName: string | null; label: string }
  | { ok: false; status: number; error: string; label: string }

/**
 * Runs one route in-process as the caller: their own bearer token, and their own address, so the route's
 * authorization decides and the rate limit counts them (app.inject would otherwise come from 127.0.0.1, one bucket
 * for everyone). A call without a body sends no content-type: Fastify refuses an empty body labelled JSON.
 */
export async function inject(ctx: ToolCtx, call: Call): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {}
  if (ctx.request.headers.authorization) headers.authorization = ctx.request.headers.authorization
  if (call.body !== undefined) headers['content-type'] = 'application/json'
  const res = await ctx.app.inject({
    method: call.method,
    url: call.url,
    payload: call.body === undefined ? undefined : JSON.stringify(call.body),
    headers,
    remoteAddress: ctx.request.ip,
  })
  let json: unknown = null
  if (res.body) {
    try {
      json = JSON.parse(res.body)
    } catch {
      json = { message: res.body.slice(0, 200) }
    }
  }
  return { status: res.statusCode, json }
}

/** The route's own words for a refusal: its message, else its error code. */
export function routeError(status: number, json: unknown): string {
  const o = (json ?? {}) as { message?: unknown; error?: unknown }
  if (typeof o.message === 'string' && o.message) return o.message
  if (typeof o.error === 'string' && o.error) return o.error
  return `The request failed (${status}).`
}

function enabled(name: string) {
  const def = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined
  return def && !config.assistantDisabledTools.includes(name) ? def : undefined
}

export async function runTool(ctx: ToolCtx, name: string, rawArgs: unknown): Promise<ToolResult> {
  const def = enabled(name)
  if (!def) return { ok: false, status: 404, error: 'unknown_tool', label: name }

  const parsed = def.input.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const error = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ')
    return { ok: false, status: 400, error, label: name }
  }
  const args = parsed.data
  const label = def.label(args)

  try {
    if (def.local) {
      const out = await def.local(args, ctx)
      return { ok: true, status: 200, summary: redact(def.summarize(out, args), ctx.self, def.redactKeys), undo: null, after: null, orgName: null, label }
    }
    if (def.effect === 'write' && !def.before) throw new Error(`assistant tool ${name} is a write without before()`)
    const before = def.before ? await def.before(args, ctx) : null

    const planned = await def.call(args, ctx)
    const calls = Array.isArray(planned) ? planned : [planned]
    const results: unknown[] = []
    let status = 200
    for (const call of calls) {
      const res = await inject(ctx, call)
      if (res.status >= 400) return { ok: false, status: res.status, error: routeError(res.status, res.json), label }
      status = res.status
      results.push(res.json)
    }
    const res = Array.isArray(planned) ? results : results[0]

    const undo = before ? (typeof before.undo === 'function' ? before.undo(res) : before.undo) : null
    return {
      ok: true,
      status,
      summary: redact(def.summarize(res, args), ctx.self, def.redactKeys),
      undo,
      after: before ? before.after(res) : null,
      orgName: before?.orgName ?? null,
      label,
    }
  } catch (err) {
    if (err instanceof ToolError) return { ok: false, status: err.status, error: err.message, label }
    throw err
  }
}

/** The enabled tools as the model's tool definitions (zod v4's own JSON Schema). */
export function toolsForModel(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return Object.values(TOOLS)
    .filter((t) => !config.assistantDisabledTools.includes(t.name))
    .map((t) => {
      const { $schema: _drop, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>
      return { name: t.name, description: t.description, input_schema: schema }
    })
}
