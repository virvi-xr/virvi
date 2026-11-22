import { z } from 'zod'
import { config } from '../../config.js'
import { redact } from '../redact.js'
import { TOOLS } from './index.js'
import { inject, routeError } from './http.js'
import { ToolError, type Before, type Call, type ToolCtx } from './types.js'

export { inject, routeError }

export type ToolResult =
  | { ok: true; status: number; summary: unknown; undo: Call | null; after: unknown; orgName: string | null; label: string }
  /** orgName is set when the write's `before` ran (the target was the user's) and the route then refused. */
  | { ok: false; status: number; error: string; label: string; orgName?: string | null }

function enabled(name: string) {
  const def = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined
  return def && !config.assistantDisabledTools.includes(name) ? def : undefined
}

export async function runTool(ctx: ToolCtx, name: string, rawArgs: unknown): Promise<ToolResult> {
  // Error text reaches the model too: a route may echo input or name someone else
  const safe = (text: string) => redact(text, ctx.self) as string
  const def = enabled(name)
  if (!def) return { ok: false, status: 404, error: 'unknown_tool', label: name }

  const parsed = def.input.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    const error = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ')
    return { ok: false, status: 400, error: safe(error), label: name }
  }
  const args = parsed.data
  const label = def.label(args)
  let before: Before | null = null

  try {
    if (def.local) {
      const out = await def.local(args, ctx)
      return { ok: true, status: 200, summary: redact(def.summarize(out, args), ctx.self, def.redactKeys), undo: null, after: null, orgName: null, label }
    }
    if (def.effect === 'write' && !def.before) throw new Error(`assistant tool ${name} is a write without before()`)
    if (def.effect === 'paid' && !def.before) throw new Error(`assistant tool ${name} is paid without before()`)
    before = def.before ? await def.before(args, ctx) : null

    const planned = await def.call(args, ctx)
    const calls = Array.isArray(planned) ? planned : [planned]
    const results: unknown[] = []
    let status = 200
    for (const call of calls) {
      const res = await inject(ctx, call)
      if (res.status >= 400) return { ok: false, status: res.status, error: safe(routeError(res.status, res.json, def.refusals)), label, orgName: before?.orgName ?? null }
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
    if (err instanceof ToolError) return { ok: false, status: err.status, error: safe(err.message), label, ...(before ? { orgName: before.orgName } : {}) }
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
