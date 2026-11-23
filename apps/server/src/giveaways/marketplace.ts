import { getAddress } from 'ethers'
import { giveawayMarketplaceApi, type GiveawayChain } from '@virvixr/shared'
import { MARKETPLACE_TIMEOUT_MS, readCapped } from '../assistant/show-wearables.js'
import { GiveawayError } from './errors.js'

/**
 * The items a host can give away (LIV-194): the published wearables and emotes their creator wallets made, from the
 * Decentraland Marketplace API of the giveaway's chain. Cached a minute per (chain, wallet).
 */

export interface CreatorItem {
  contractAddress: string // checksummed
  itemId: string
  name: string
  thumbnail: string | null
  rarity: string | null
  available: number
}

const CATEGORIES = ['wearable', 'emote'] as const
const FIRST = 100
/** Pages read per category and wallet: a creator's first 1000 items of each kind. */
const MAX_ITEMS = 1000
const MAX_BYTES = 4 * 1024 * 1024
const CACHE_MS = 60_000
const NAME_MAX = 80
const CONTRACT = /^0x[0-9a-f]{40}$/
const ITEM_ID = /^\d{1,30}$/

let fetchImpl: typeof fetch = (...a) => fetch(...a)
const cache = new Map<string, { at: number; items: CreatorItem[] }>()

/** Tests serve the Marketplace themselves; null puts the real fetch back. Either way the cache is emptied. */
export function setCreatorItemsFetchForTests(f: typeof fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a))
  cache.clear()
}

const cleanName = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
const httpsUrl = (v: unknown) => (typeof v === 'string' && /^https:\/\//.test(v) ? v : null)

const down = () => new GiveawayError(502, 'marketplace_down', "The Decentraland Marketplace isn't answering. Try again in a minute.")

/** Every page of one category, up to MAX_ITEMS (a full page means there may be more). */
async function fetchCategory(chain: GiveawayChain, wallet: string, category: (typeof CATEGORIES)[number]): Promise<CreatorItem[]> {
  const out: CreatorItem[] = []
  for (let skip = 0; skip < MAX_ITEMS; skip += FIRST) {
    const { items, full } = await fetchPage(chain, wallet, category, skip)
    out.push(...items)
    if (!full) break
  }
  return out
}

async function fetchPage(
  chain: GiveawayChain, wallet: string, category: (typeof CATEGORIES)[number], skip: number,
): Promise<{ items: CreatorItem[]; full: boolean }> {
  const q = new URLSearchParams({ creator: wallet, category, first: String(FIRST), skip: String(skip) })
  let res: Response
  try {
    res = await fetchImpl(`${giveawayMarketplaceApi(chain)}/v1/items?${q}`, {
      redirect: 'error', signal: AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS), headers: { accept: 'application/json' },
    })
  } catch {
    throw down()
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {})
    throw down()
  }
  const text = await readCapped(res, MAX_BYTES)
  let data: unknown
  try {
    data = text === null ? null : (JSON.parse(text) as { data?: unknown })?.data
  } catch {
    data = null
  }
  if (!Array.isArray(data)) throw down()
  const out: CreatorItem[] = []
  for (const raw of data as Array<Record<string, unknown>>) {
    const contract = String(raw?.contractAddress ?? '').toLowerCase()
    const itemId = String(raw?.itemId ?? '')
    // Published only (curation approved it), and on Polygon: issueTokens is a Polygon collection call
    if (!CONTRACT.test(contract) || !ITEM_ID.test(itemId) || raw?.category !== category || !raw?.reviewedAt) continue
    if (raw?.network !== undefined && raw.network !== 'MATIC') continue
    const available = Number(raw?.available)
    out.push({
      contractAddress: getAddress(contract), itemId,
      name: cleanName(String(raw?.name ?? '')) || (category === 'emote' ? 'Unnamed emote' : 'Unnamed wearable'),
      thumbnail: httpsUrl(raw?.thumbnail),
      rarity: typeof raw?.rarity === 'string' ? raw.rarity.slice(0, 20) : null,
      available: Number.isFinite(available) && available > 0 ? Math.floor(available) : 0,
    })
  }
  return { items: out, full: data.length >= FIRST }
}

async function walletItems(chain: GiveawayChain, wallet: string, now: number): Promise<CreatorItem[]> {
  const key = `${chain}:${wallet}`
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return hit.items
  const items = (await Promise.all(CATEGORIES.map((c) => fetchCategory(chain, wallet, c)))).flat()
  // Old entries go once the cache grows, so it stays about as big as a minute of lookups
  if (cache.size >= 1000) for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k)
  cache.set(key, { at: now, items })
  return items
}

/** The published wearables and emotes these wallets created, each once. Throws marketplace_down (502) when it can't answer. */
export async function creatorItems(chain: GiveawayChain, wallets: string[]): Promise<CreatorItem[]> {
  const now = Date.now()
  const lists = await Promise.all([...new Set(wallets.map((w) => w.toLowerCase()))].map((w) => walletItems(chain, w, now)))
  const seen = new Set<string>()
  const out: CreatorItem[] = []
  for (const item of lists.flat()) {
    const key = `${item.contractAddress.toLowerCase()}:${item.itemId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
