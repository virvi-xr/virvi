import { createHmac } from 'node:crypto'
import type { RaffleMode } from '@virvixr/shared'

/**
 * The raffle draw, algorithm v1 (LIV-55). Pure and replayable: the same pool, seed and draw id always give the same
 * winners, so anyone can check a draw after the seed is revealed. Published at /docs/raffles; do not change it,
 * add a v2 instead.
 */
export type PoolEntry = { entryId: string; tickets: number }

/** Tickets per entry: one each, or one per snapshot the entry was present in. Sorted by entry id; zero tickets dropped. */
export function buildPool(mode: RaffleMode, snapshots: { entryIds: string[] }[], exclude: Set<string>): PoolEntry[] {
  const counts = new Map<string, number>()
  for (const snap of snapshots) {
    for (const id of new Set(snap.entryIds)) {
      if (exclude.has(id)) continue
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([entryId, n]) => ({ entryId, tickets: mode === 'weighted' ? n : 1 }))
    .filter((e) => e.tickets > 0)
    .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
}

const TWO_64 = 2n ** 64n

/** Winners' entry ids in draw order. */
export function drawWinners(pool: PoolEntry[], count: number, seedHex: string, drawId: string): string[] {
  const left = pool.map((e) => ({ ...e }))
  let total = left.reduce((sum, e) => sum + e.tickets, 0)
  const key = Buffer.from(seedHex, 'hex')
  const winners: string[] = []
  for (let k = 0; winners.length < count && left.length > 0; k++) {
    const mac = createHmac('sha256', key).update(`virvi-raffle:${drawId}:${k}`).digest()
    const r = mac.readBigUInt64BE(0)
    const big = BigInt(total)
    if (r >= (TWO_64 / big) * big) continue // rejection sampling: no modulo bias
    let x = Number(r % big)
    const i = left.findIndex((e) => (x < e.tickets ? true : ((x -= e.tickets), false)))
    const [won] = left.splice(i, 1)
    total -= won.tickets
    winners.push(won.entryId)
  }
  return winners
}
