// The in-process HTTP call every tool makes, kept apart from the runner so write tools can use it without an import cycle.
import type { Call, ToolCtx } from './types.js'

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
