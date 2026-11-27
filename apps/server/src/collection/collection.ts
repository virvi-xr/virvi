import { giveawayMarketplaceApi } from '@virvixr/shared'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { MARKETPLACE_TIMEOUT_MS, readCapped } from '../assistant/show-wearables.js'

/**
 * The Collection page (LIV-160, phase 1): the Decentraland wearables, emotes, NAMEs and land held by an account's
 * verified wallets, from the Decentraland Marketplace API (both Ethereum and Polygon). Read-only and cached 5 minutes per
 * wallet; a wallet the Marketplace can't answer for is listed as unavailable, never an error for the whole page.
 */

export const COLLECTION_KINDS = ['wearable', 'emote', 'ens', 'parcel', 'estate'] as const
export type CollectionKind = (typeof COLLECTION_KINDS)[number]

export interface CollectionItem {
  id: string
  kind: CollectionKind
  name: string
  image: string | null
  /** Wearables and emotes: common … unique */
  rarity: string | null
  /** Wearables: hat, upper_body …; emotes: dance, …; null otherwise */
  slot: string | null
  network: 'ETHEREUM' | 'MATIC'
  contractAddress: string
  tokenId: string
  /** Which of the account's wallets holds it (lower-case) */
  wallet: string
  /** The item's page on the Decentraland Marketplace */
  url: string
}

export interface Collection { wallets: string[]; items: CollectionItem[]; unavailable: string[]; truncated: string[] }

const FIRST = 100
/** Items read per wallet: the first 2,000. */
export const MAX_PER_WALLET = 2000
const MAX_BYTES = 4 * 1024 * 1024
const CACHE_MS = 5 * 60_000
const NAME_MAX = 120
const MARKETPLACE_SITE = 'https://decentraland.org/marketplace'
const ADDRESS = /^0x[0-9a-f]{40}$/
const TOKEN = /^\d{1,90}$/

let fetchImpl: typeof fetch = (...a) => fetch(...a)
const cache = new Map<string, { at: number; items: CollectionItem[]; truncated: boolean }>()

/** Tests serve the Marketplace themselves; null puts the real fetch back. Either way the cache is emptied. */
export function setCollectionFetchForTests(f: typeof fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a))
  cache.clear()
}

const clean = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
const httpsUrl = (v: unknown) => (typeof v === 'string' && /^https:\/\//.test(v) ? v : null)

/** One Marketplace row, or null when it isn't a well-formed item of a kind the page shows. */
export function itemFromMarketplace(row: unknown, wallet: string): CollectionItem | null {
  const nft = (row as { nft?: Record<string, unknown> } | null)?.nft
  if (!nft || typeof nft !== 'object') return null
  const kind = nft.category as CollectionKind
  if (!COLLECTION_KINDS.includes(kind)) return null
  const contract = typeof nft.contractAddress === 'string' ? nft.contractAddress.toLowerCase() : ''
  const tokenId = typeof nft.tokenId === 'string' ? nft.tokenId : ''
  if (!ADDRESS.test(contract) || !TOKEN.test(tokenId)) return null
  const network = nft.network === 'ETHEREUM' ? 'ETHEREUM' : nft.network === 'MATIC' ? 'MATIC' : null
  if (!network) return null
  const data = (nft.data && typeof nft.data === 'object' ? nft.data : {}) as Record<string, Record<string, unknown> | undefined>
  const detail = data[kind] ?? {}
  const rarity = typeof detail.rarity === 'string' ? clean(detail.rarity) : null
  const slot = typeof detail.category === 'string' ? clean(detail.category) : null
  const rawName = typeof nft.name === 'string' && nft.name.trim() ? nft.name : kind === 'ens' && typeof detail.subdomain === 'string' ? detail.subdomain : 'Untitled'
  const name = kind === 'ens' ? `${clean(rawName)}.dcl.eth` : clean(rawName)
  return {
    id: `${contract}-${tokenId}`, kind, name, image: httpsUrl(nft.image), rarity, slot, network, contractAddress: contract, tokenId, wallet,
    url: `${MARKETPLACE_SITE}/contracts/${contract}/tokens/${tokenId}`,
  }
}

class MarketplaceDown extends Error {}

async function walletItems(wallet: string): Promise<{ items: CollectionItem[]; truncated: boolean }> {
  const hit = cache.get(wallet)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit
  const base = giveawayMarketplaceApi('polygon')
  const items: CollectionItem[] = []
  let truncated = false
  for (let skip = 0; ; skip += FIRST) {
    if (skip >= MAX_PER_WALLET) { truncated = true; break }
    let res: Response
    try {
      res = await fetchImpl(`${base}/v1/nfts?owner=${wallet}&first=${FIRST}&skip=${skip}&sortBy=newest`, { signal: AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS) })
    } catch {
      throw new MarketplaceDown()
    }
    if (!res.ok) throw new MarketplaceDown()
    const text = await readCapped(res, MAX_BYTES)
    if (text === null) throw new MarketplaceDown()
    let rows: unknown[]
    try {
      const body = JSON.parse(text) as { data?: unknown }
      rows = Array.isArray(body.data) ? body.data : []
    } catch {
      throw new MarketplaceDown()
    }
    for (const r of rows) {
      const item = itemFromMarketplace(r, wallet)
      // The API is asked for this owner; anything else in the answer isn't shown
      if (item && ((r as { nft?: { owner?: unknown } }).nft?.owner as string | undefined)?.toLowerCase() === wallet) items.push(item)
    }
    if (rows.length < FIRST) break
  }
  const entry = { at: Date.now(), items, truncated }
  cache.set(wallet, entry)
  return entry
}

/** Everything the account's verified wallets hold, newest first per wallet. */
export async function collectionFor(userId: string): Promise<Collection> {
  const wallets = (await verifiedWalletsOf(userId)).map((w) => w.toLowerCase())
  const results = await Promise.all(wallets.map(async (w) => {
    try { return { wallet: w, ...(await walletItems(w)) } } catch (err) {
      if (err instanceof MarketplaceDown) return { wallet: w, items: [] as CollectionItem[], truncated: false, down: true }
      throw err
    }
  }))
  // One NFT can't be in two wallets, but the same wallet linked twice must not list it twice
  const seen = new Set<string>()
  const items: CollectionItem[] = []
  for (const r of results) for (const i of r.items) if (!seen.has(i.id)) { seen.add(i.id); items.push(i) }
  return {
    wallets,
    items,
    unavailable: results.filter((r) => 'down' in r && r.down).map((r) => r.wallet),
    truncated: results.filter((r) => r.truncated).map((r) => r.wallet),
  }
}
