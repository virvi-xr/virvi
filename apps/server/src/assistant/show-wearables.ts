// Shows: watching Decentraland for the show's wearable. A show waiting on a published wearable (its wearable_published
// item has none) is checked against the Marketplace for wearables the user's verified wallets created since the show
// began, and one that clearly is the show's is filled in by itself. The checklist names what was found, and pasting a
// link replaces it. Setting it changes only the user's own checklist: making it a raffle's prize is still a card.
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { ShowItem, ShowWearable } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { config } from '../config.js'
import { assistantShows, studioDesigns } from '../db/schema.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import type { ShowRow } from './shows.js'

/** A published wearable as the Marketplace lists it, trimmed to what the pick needs. */
export interface MarketItem {
  contract: string
  itemId: string
  name: string
  /** When it was created on chain, and when curation approved it (null: not approved). */
  createdAt: Date
  reviewedAt: Date | null
}

/** The wearables these wallets created, newest first. Throws when the Marketplace can't answer. */
export type FindItems = (creators: string[]) => Promise<MarketItem[]>

/** Shows older than this stop being watched: a wearable that hasn't appeared by then is pasted by hand. */
export const WATCH_DAYS = 90
export const SWEEP_SHOWS_MAX = 200
const PAGE = 50
const TIMEOUT_MS = 10_000
const MAX_BYTES = 2 * 1024 * 1024
const NAME_MAX = 80
const CONTRACT = /^0x[0-9a-f]{40}$/
const ITEM_ID = /^\d{1,30}$/

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
/** A name from Decentraland as the checklist shows it: one line, no control characters, capped. */
const cleanName = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)

/**
 * The show's wearable among the user's new ones: approved, created since the show began, and then the one named like
 * the show's Studio design, else the only one. Several and none named like the design: null, the user pastes it.
 */
export function pickWearable(items: MarketItem[], since: Date, designName: string | null): MarketItem | null {
  const fresh = items.filter((i) => i.reviewedAt && i.createdAt.getTime() >= since.getTime())
  if (designName) {
    const named = fresh.filter((i) => norm(i.name) === norm(designName))
    if (named.length === 1) return named[0]
    if (named.length > 1) return null
  }
  return fresh.length === 1 ? fresh[0] : null
}

const seconds = (v: unknown): Date | null => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null
}

/** The real lookup: the Marketplace API (a fixed public host, from config), with a timeout, no redirects, a size cap. */
export function marketplaceFind(fetchImpl: typeof fetch = fetch): FindItems {
  return async (creators) => {
    const q = new URLSearchParams({ first: String(PAGE), sortBy: 'newest', category: 'wearable' })
    for (const c of creators) q.append('creator', c.toLowerCase())
    const res = await fetchImpl(`${config.dclMarketplaceApiUrl}/v1/items?${q}`, {
      redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' },
    })
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`Marketplace answered ${res.status}`)
    }
    const text = await res.text()
    if (text.length > MAX_BYTES) throw new Error('Marketplace answer too large')
    const data = (JSON.parse(text) as { data?: unknown })?.data
    if (!Array.isArray(data)) throw new Error('Marketplace answered without a data list')
    const out: MarketItem[] = []
    for (const raw of data as Array<Record<string, unknown>>) {
      const contract = String(raw?.contractAddress ?? '').toLowerCase()
      const itemId = String(raw?.itemId ?? '')
      const createdAt = seconds(raw?.createdAt)
      if (!CONTRACT.test(contract) || !ITEM_ID.test(itemId) || !createdAt || raw?.category !== 'wearable') continue
      out.push({ contract, itemId, name: cleanName(String(raw?.name ?? '')) || 'Unnamed wearable', createdAt, reviewedAt: seconds(raw?.reviewedAt) })
    }
    return out
  }
}

const waitingItem = (show: ShowRow) => show.items.find((i) => i.kind === 'wearable_published' && !i.wearable)

/** Look once over the open shows waiting on a wearable; returns how many were checked and filled. */
export async function sweepShowWearables(find: FindItems = marketplaceFind(), now = new Date()): Promise<{ checked: number; found: number }> {
  const since = new Date(now.getTime() - WATCH_DAYS * 86_400_000)
  const open = await db.select().from(assistantShows)
    .where(and(isNull(assistantShows.closedAt), gt(assistantShows.createdAt, since)))
    .orderBy(assistantShows.updatedAt).limit(SWEEP_SHOWS_MAX * 5)
  const shows = open.filter((s) => waitingItem(s)).slice(0, SWEEP_SHOWS_MAX)

  // One Marketplace call per user, whatever their number of shows
  const byUser = new Map<string, MarketItem[] | null>()
  let found = 0
  for (const show of shows) {
    if (!byUser.has(show.userId)) {
      const wallets = await verifiedWalletsOf(show.userId)
      let items: MarketItem[] | null = null
      if (wallets.length) {
        try {
          items = await find(wallets)
        } catch (err) {
          console.error('[show-wearables] Marketplace lookup failed:', err instanceof Error ? err.message : err)
        }
      }
      byUser.set(show.userId, items)
    }
    const items = byUser.get(show.userId)
    if (!items?.length) continue

    const designId = show.items.find((i) => i.kind === 'wearable_design')?.ref?.designId
    const [design] = designId
      ? await db.select({ name: studioDesigns.name }).from(studioDesigns).where(and(eq(studioDesigns.id, designId), eq(studioDesigns.ownerId, show.userId)))
      : []
    const pick = pickWearable(items, show.createdAt, design?.name ?? null)
    if (!pick) continue
    if (await fill(show.id, pick)) found++
  }
  return { checked: shows.length, found }
}

/** Under the row's lock: only a show still open whose item still has no wearable (a paste always wins). */
async function fill(showId: string, pick: MarketItem): Promise<boolean> {
  const wearable: ShowWearable = {
    contract: pick.contract,
    itemId: pick.itemId,
    url: `https://decentraland.org/marketplace/contracts/${pick.contract}/items/${pick.itemId}`,
    found: { name: pick.name },
  }
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(assistantShows).where(eq(assistantShows.id, showId)).for('update')
    if (!current || current.closedAt) return false
    const target = waitingItem(current)
    if (!target) return false
    const items = current.items.map((i): ShowItem => (i.id === target.id ? { ...i, wearable } : i))
    await tx.update(assistantShows).set({ items, updatedAt: new Date() }).where(eq(assistantShows.id, showId))
    return true
  })
}

export function startShowWearableSweep(ms: number): () => void {
  if (ms <= 0) return () => {}
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await sweepShowWearables()
    } catch (err) {
      console.error('[virvi-server] Show wearable sweep failed:', err)
    } finally {
      running = false
    }
  }, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}
