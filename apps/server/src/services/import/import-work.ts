import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * How many big import jobs this process runs at once. Each holds a few hundred MB and some synchronous zip work, so past
 * this a request is refused with 503 imports_busy before its body is read, rather than stalling the API or running it
 * out of memory. Uploads and build results have separate pools, so uploads can never starve the results of builds that
 * already ran.
 *
 * A slot is taken only once the request is authenticated (the gate runs after the route's auth hook) and its body must
 * arrive within the route's limit, or the connection is closed and the slot freed: a slow or trickled body can't hold
 * one. Fastify has no per-route request timeout and the server sets none globally (studio uploads stream for longer),
 * so the limit is a timer here. The slot is given back when the handler finishes, or when the client goes away while
 * its body is still being read; never while the handler still holds the bytes.
 */
export const IMPORT_CONCURRENCY = 2
export const IMPORTS_BUSY = 'Virvi is busy with other imports. Try again in a minute.'
/** How long a body may take to arrive (an upload's is its floor, see uploadDeadlineMs); tests shorten them. */
export const importLimits = { uploadBodyMs: 120_000, resultBodyMs: 300_000 }
/** Ruling R29: an upload may arrive as slowly as 128 KiB/s (about 1 Mbit/s), for at most 15 minutes. */
const UPLOAD_MIN_BYTES_PER_S = 128 * 1024
const UPLOAD_MAX_MS = 15 * 60_000
export const UPLOAD_TOO_SLOW = 'The upload took too long. Try again on a faster connection, or remove large unused files from the scene.'

/**
 * An upload's body deadline from its declared Content-Length: max(the floor, length at 128 KiB/s), at most 15 minutes.
 * No length (or a chunked body) gets the floor; the route's byte limit still applies.
 */
export function uploadDeadlineMs(contentLength: string | undefined): number {
  const n = contentLength !== undefined && /^\d+$/.test(contentLength.trim()) ? Number(contentLength) : 0
  return Math.min(UPLOAD_MAX_MS, Math.max(importLimits.uploadBodyMs, Math.ceil((n / UPLOAD_MIN_BYTES_PER_S) * 1000)))
}

/** A counting semaphore that never waits: `tryTake` gives a release function (safe to call twice), or null when full. */
export function slots(max: number) {
  let used = 0
  return {
    tryTake(): (() => void) | null {
      if (used >= max) return null
      used++
      let held = true
      return () => {
        if (!held) return
        held = false
        used--
      }
    },
    inUse: () => used,
  }
}

export const uploadWork = slots(IMPORT_CONCURRENCY)
export const resultWork = slots(IMPORT_CONCURRENCY)

interface ImportSlot {
  release: () => void
  /** Set once the body is in: from then on only the handler's end gives the slot back. */
  bodyRead: boolean
  timer: ReturnType<typeof setTimeout>
}

declare module 'fastify' {
  interface FastifyRequest {
    importSlot?: ImportSlot
  }
}

/**
 * An onRequest hook (after auth) taking a slot from `pool` or answering 503 imports_busy, with a body deadline of
 * `limit()` ms. Register `importSlotHooks` on the same scope and call `releaseImportSlot` when the handler ends.
 */
export function importSlotGate(pool: ReturnType<typeof slots>, limit: (request: FastifyRequest) => number, tooSlow?: { error: string; message: string }) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const release = pool.tryTake()
    if (!release) return reply.status(503).send({ error: 'imports_busy', message: IMPORTS_BUSY })
    const timer = setTimeout(() => {
      if (request.importSlot?.bodyRead) return
      release()
      // Say why while the socket can still take an answer (408), then close it; otherwise just close it
      if (tooSlow && !reply.sent && !reply.raw.headersSent && reply.raw.writable) {
        reply.raw.once('finish', () => request.raw.destroy())
        reply.code(408).header('connection', 'close').send(tooSlow)
      } else {
        request.raw.destroy()
      }
    }, limit(request))
    timer.unref?.()
    request.importSlot = { release, bodyRead: false, timer }
  }
}

function bodyIn(request: FastifyRequest) {
  const s = request.importSlot
  if (!s) return
  s.bodyRead = true
  clearTimeout(s.timer)
}

/** Gives the request's slot back (idempotent). */
export function releaseImportSlot(request: FastifyRequest) {
  const s = request.importSlot
  if (!s) return
  clearTimeout(s.timer)
  s.release()
}

/** The hooks a gated scope needs: the body deadline ends with the body, and a body never finished frees its slot. */
export const importSlotHooks = {
  async preHandler(request: FastifyRequest) { bodyIn(request) },
  // The handler has returned by now; and a refused body (too large, wrong type) answers without reaching it
  async onResponse(request: FastifyRequest) { releaseImportSlot(request) },
  async onRequestAbort(request: FastifyRequest) { if (!request.importSlot?.bodyRead) releaseImportSlot(request) },
}
