import { db } from '../db/connection.js'
import { config } from '../config.js'
import { flushErrors, recordServerException, startErrorFlusher } from './record.js'
import { purgeErrors } from './retention.js'
import { runFilingPass } from './filing.js'

type Reserved = ((strings: TemplateStringsArray, ...v: unknown[]) => Promise<Array<Record<string, unknown>>>) & { release(): void }

/**
 * Runs fn only on the instance that wins the named advisory lock (a no-op on the others). The lock is a session lock
 * on a reserved connection, so no transaction stays open while fn waits on Linear.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const client = (db as unknown as { $client: { reserve(): Promise<Reserved> } }).$client
  const conn = await client.reserve()
  try {
    const [row] = await conn`SELECT pg_try_advisory_lock(hashtext(${name})) AS locked`
    if (!row?.locked) return null
    try {
      return await fn()
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtext(${name}))`
    }
  } finally {
    conn.release()
  }
}

export const PURGE_EVERY_MS = 60 * 60_000
export const FILING_EVERY_MS = 5 * 60_000

/**
 * LIV-66 background work: the flusher (every instance writes its own buffer), the retention purge hourly and the Linear
 * filing pass every 5 minutes (one instance at a time, by advisory lock). Their own failures are logged, never reported.
 */
export function startErrorJobs(): () => void {
  startErrorFlusher()
  if (!config.errorJobsEnabled) return () => {}
  const timers: NodeJS.Timeout[] = []
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        await withLock(`errors:${name}`, fn)
      } catch (err) {
        console.error(`[errors] ${name} failed:`, err instanceof Error ? err.message : err)
      } finally {
        running = false
      }
    }
    const t = setInterval(tick, ms)
    t.unref()
    timers.push(t)
    const first = setTimeout(tick, 60_000)
    first.unref()
    timers.push(first)
  }
  every(PURGE_EVERY_MS, 'purge', () => purgeErrors(new Date()))
  every(FILING_EVERY_MS, 'filing', () => runFilingPass(new Date()))
  return () => { for (const t of timers) clearTimeout(t) }
}

/**
 * Records an exception nothing caught, then exits as Node would have (after up to 2 s to write it). Installed by
 * src/index.ts only.
 */
export function installProcessErrorHandlers(): void {
  let exiting = false
  const fatal = (origin: string) => (err: unknown) => {
    console.error(`[virvi-server] ${origin}:`, err)
    if (exiting) return
    exiting = true
    recordServerException(err)
    Promise.race([flushErrors(), new Promise((r) => setTimeout(r, 2000))]).finally(() => process.exit(1))
  }
  process.on('uncaughtException', fatal('uncaughtException'))
  process.on('unhandledRejection', fatal('unhandledRejection'))
}
