/** The Collection page (LIV-160): what /api/collection returns, filters and labels. */

export type CollectionKind = 'wearable' | 'emote' | 'ens' | 'parcel' | 'estate'
export interface CollectionItem {
  id: string; kind: CollectionKind; name: string; image: string | null; rarity: string | null; slot: string | null
  network: 'ETHEREUM' | 'MATIC'; contractAddress: string; tokenId: string; wallet: string; url: string
}
export interface Collection { wallets: string[]; items: CollectionItem[]; unavailable: string[]; truncated: string[] }

export type KindFilter = 'all' | 'wearable' | 'emote' | 'ens' | 'land'
export const KIND_FILTERS: [KindFilter, string][] = [['all', 'Everything'], ['wearable', 'Wearables'], ['emote', 'Emotes'], ['ens', 'Names'], ['land', 'Land']]
export const KIND_LABEL: Record<CollectionKind, string> = { wearable: 'Wearable', emote: 'Emote', ens: 'Name', parcel: 'Parcel', estate: 'Estate' }

const RARITY_ORDER = ['unique', 'mythic', 'exotic', 'legendary', 'epic', 'rare', 'uncommon', 'common', 'base']
const rank = (r: string | null) => { const i = r ? RARITY_ORDER.indexOf(r) : -1; return i < 0 ? RARITY_ORDER.length : i }

export const shortWallet = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`

const matchesKind = (i: CollectionItem, k: KindFilter) => k === 'all' || (k === 'land' ? i.kind === 'parcel' || i.kind === 'estate' : i.kind === k)

/** Items for the filters, rarest first, then by name; and how many of each kind there are, for the filter labels. */
export function filterCollection(items: CollectionItem[], f: { kind: KindFilter; wallet: string | 'all'; query: string }): CollectionItem[] {
  const q = f.query.trim().toLowerCase()
  return items
    .filter((i) => matchesKind(i, f.kind) && (f.wallet === 'all' || i.wallet === f.wallet) && (!q || i.name.toLowerCase().includes(q)))
    .sort((a, b) => rank(a.rarity) - rank(b.rarity) || a.name.localeCompare(b.name))
}

export function kindCounts(items: CollectionItem[]): Record<KindFilter, number> {
  const out: Record<KindFilter, number> = { all: items.length, wearable: 0, emote: 0, ens: 0, land: 0 }
  for (const i of items) out[i.kind === 'parcel' || i.kind === 'estate' ? 'land' : (i.kind as KindFilter)]++
  return out
}

/** "Earring · Common", "Name", "Estate". */
export function itemSubtitle(i: CollectionItem): string {
  const slot = i.slot ? i.slot.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : KIND_LABEL[i.kind]
  return i.rarity ? `${slot}, ${i.rarity.replace(/^\w/, (c) => c.toUpperCase())}` : slot
}
