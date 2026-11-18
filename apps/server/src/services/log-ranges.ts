/**
 * Reading `eth_getLogs` over a block range when providers cap how wide a range may be (Alchemy's free plan allows 10
 * blocks). Shared by the BEAT holdings index and the MANA watcher.
 */

/** Smaller ranges to fall back to, widest first, when a provider refuses a log range. */
export const SMALLER_LOG_RANGES = [500, 100, 10]

/** A provider's refusal of the requested block range, as opposed to any other failure. */
export const RANGE_REFUSED = /block range|range (is )?too (large|wide|big)|eth_getLogs requests with up to|query returned more than|limit exceeded/i

export const isRangeRefused = (err: unknown) => RANGE_REFUSED.test(err instanceof Error ? err.message : String(err))

/** The next range to try after `size` was refused, or null when there is none smaller. */
export const smallerRange = (size: number): number | null => SMALLER_LOG_RANGES.find((n) => n < size) ?? null

/**
 * Reads [from, to] in chunks of at most `size` blocks, shrinking the chunk when the provider refuses it, and stops
 * after `maxChunks` chunks. Returns everything read, in order, and the last block read (from - 1 when nothing was).
 * Any other error is thrown, and nothing read is returned: the caller starts again from `from` next time.
 */
export async function readLogRanges<T>(
  from: number, to: number, size: number, read: (from: number, to: number) => Promise<T[]>, maxChunks = 100,
): Promise<{ items: T[]; lastBlock: number }> {
  const items: T[] = []
  let last = from - 1
  for (let chunk = 0; chunk < maxChunks && last < to; chunk++) {
    for (;;) {
      const end = Math.min(last + size, to)
      try {
        items.push(...(await read(last + 1, end)))
        last = end
        break
      } catch (err) {
        const next = smallerRange(size)
        if (next === null || !isRangeRefused(err)) throw err
        size = next
      }
    }
  }
  return { items, lastBlock: last }
}
