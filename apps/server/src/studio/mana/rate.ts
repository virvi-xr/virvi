/**
 * The MANA/USD rate MANA quotes are priced at. It's fetched on the server (never taken from the browser), cached for a
 * minute, and a quote is refused once the last good rate is more than 5 minutes old.
 */

export type ManaRate = { usdPerMana: number; source: string; at: Date }

const CACHE_MS = 60_000
const STALE_MS = 5 * 60_000
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=decentraland&vs_currencies=usd'

async function coingecko(): Promise<number> {
  const res = await fetch(COINGECKO, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`CoinGecko answered ${res.status}`)
  const body = await res.json() as { decentraland?: { usd?: unknown } }
  return Number(body.decentraland?.usd)
}

let source: { fn: () => Promise<number>; name: string } = { fn: coingecko, name: 'coingecko' }
let cached: ManaRate | null = null

/** Tests replace the rate source (and drop the cached rate); null puts CoinGecko back. */
export function setManaRateSource(fn: (() => Promise<number>) | null): void {
  source = fn ? { fn, name: 'test' } : { fn: coingecko, name: 'coingecko' }
  cached = null
}

/** The current rate: the cached one when under a minute old, else a fresh one; null with no good rate in 5 minutes. */
export async function getManaRate(now: Date): Promise<ManaRate | null> {
  const age = (r: ManaRate) => now.getTime() - r.at.getTime()
  if (cached && age(cached) < CACHE_MS) return cached
  try {
    const usdPerMana = await source.fn()
    if (!Number.isFinite(usdPerMana) || usdPerMana <= 0) throw new Error(`not a rate: ${usdPerMana}`)
    cached = { usdPerMana, source: source.name, at: now }
    return cached
  } catch (err) {
    console.error('[studio] MANA rate refresh failed:', err instanceof Error ? err.message : err)
    return cached && age(cached) <= STALE_MS ? cached : null
  }
}
