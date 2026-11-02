import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * How many big import jobs (reading an upload and storing its source, unpacking a build result) this process runs at
 * once. Each holds a few hundred MB and some synchronous zip work, so past this a request is refused with 503
 * imports_busy before its body is read, rather than stalling the API or running it out of memory.
 */
export const IMPORT_CONCURRENCY = 2
export const IMPORTS_BUSY = 'Virvi is busy with other imports. Try again in a minute.'

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

export const importWork = slots(IMPORT_CONCURRENCY)

declare module 'fastify' {
  interface FastifyRequest {
    importSlot?: () => void
  }
}

/**
 * An onRequest hook: takes a slot for the request or answers 503 imports_busy. The slot is given back when the response
 * is sent or the client goes away (`releaseImportSlot`, registered as onResponse and onRequestAbort on the same scope).
 */
export async function importSlotGate(request: FastifyRequest, reply: FastifyReply) {
  const release = importWork.tryTake()
  if (!release) return reply.status(503).send({ error: 'imports_busy', message: IMPORTS_BUSY })
  request.importSlot = release
}

export async function releaseImportSlot(request: FastifyRequest) {
  request.importSlot?.()
}
