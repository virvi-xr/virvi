// Virvi Assistant (LIV-155): a hijacked reply streamed as server-sent events.
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AssistantStreamEvent } from '@virvixr/shared'

export const PING_MS = 15_000

export interface Sse {
  send(e: AssistantStreamEvent): void
  close(): void
  signal: AbortSignal
}

/**
 * Takes the response over from Fastify. A hijacked reply skips Fastify's own header writing, so the headers already
 * set on it (CORS from @fastify/cors's onRequest hook, the request id) are copied onto the raw response; if CORS
 * hasn't run, the origin is allowed the way app.ts allows every origin (`origin: true`, no credentials).
 */
export function openSse(request: FastifyRequest, reply: FastifyReply): Sse {
  const headers: Record<string, string | number | string[]> = {}
  for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v as string | number | string[]
  const origin = request.headers.origin
  if (origin && headers['access-control-allow-origin'] === undefined) {
    headers['access-control-allow-origin'] = origin
    headers.vary = 'Origin'
  }
  headers['content-type'] = 'text/event-stream'
  headers['cache-control'] = 'no-cache'
  headers['x-accel-buffering'] = 'no'
  delete headers['content-length']

  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, headers)

  const controller = new AbortController()
  const open = () => !raw.writableEnded && !raw.destroyed
  const write = (chunk: string) => {
    if (open()) raw.write(chunk)
  }
  const ping = setInterval(() => write(': ping\n\n'), PING_MS)
  ping.unref?.()
  // The response closes when the browser goes away (or when we end it): either way nothing more is wanted
  raw.on('close', () => {
    clearInterval(ping)
    controller.abort()
  })
  request.raw.on('aborted', () => controller.abort())

  return {
    send: (e) => write(`data: ${JSON.stringify(e)}\n\n`),
    close: () => {
      clearInterval(ping)
      if (open()) raw.end()
    },
    signal: controller.signal,
  }
}
