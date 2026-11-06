import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getAddress } from 'ethers'
import { db } from '../db/connection.js'
import { studioDesigns, studioEntitlements, userAuthMethods } from '../db/schema.js'
import { getDclDirectory } from '../analytics/dcl-directory.js'
import { frameUrlExpiry, signRenderFrame } from './render-urls.js'
import { ORBIT_RING, viewKey, type Design } from './designs.js'
import { SCENE_ORBIT_KEY } from './scene.js'

/**
 * The wall of fame: finalized designs whose owners chose to show them, read publicly by the studio scene. An entry
 * carries a name, a creator label, an optional Marketplace link and twelve signed preview frames; never an account id or email.
 */

export type WallState = { shown: boolean; hidden: boolean; marketplaceUrl: string | null }
export type WallEntry = {
  designId: string
  name: string
  kind: 'wearable' | 'emote' | 'scene'
  creator: string
  marketplaceUrl: string | null
  shownAt: string
  frames: string[]
}

export const WALL_FRAMES = 12
const MARKETPLACE_URL = /^https:\/\/(market\.)?decentraland\.org\/[^\s]{1,280}$/
const MARKETPLACE_URL_MAX = 300

export const wallState = (d: Pick<Design, 'wallShownAt' | 'wallHiddenAt' | 'wallMarketplaceUrl'>): WallState =>
  ({ shown: !!d.wallShownAt, hidden: !!d.wallHiddenAt, marketplaceUrl: d.wallMarketplaceUrl })

export async function setWallChoice(
  design: Design,
  choice: { shown: boolean; marketplaceUrl?: string | null },
  now: Date,
): Promise<{ ok: true; wall: WallState } | { ok: false; status: 400 | 409; code: 'not_finalized' | 'bad_marketplace_url' }> {
  const url = choice.marketplaceUrl
  if (typeof url === 'string' && (url.length > MARKETPLACE_URL_MAX || !MARKETPLACE_URL.test(url))) {
    return { ok: false, status: 400, code: 'bad_marketplace_url' }
  }
  if (choice.shown) {
    const [ready] = await db.select({ id: studioEntitlements.id }).from(studioEntitlements)
      .where(and(eq(studioEntitlements.designId, design.id), eq(studioEntitlements.status, 'ready'))).limit(1)
    if (!ready) return { ok: false, status: 409, code: 'not_finalized' }
  }
  const [updated] = await db.update(studioDesigns).set({
    // already shown keeps its place on the wall
    wallShownAt: choice.shown ? design.wallShownAt ?? now : null,
    ...(url !== undefined ? { wallMarketplaceUrl: url } : {}),
  }).where(eq(studioDesigns.id, design.id)).returning()
  return { ok: true, wall: wallState(updated) }
}

const NAMES_TTL_MS = 3600_000
const names = new Map<string, { label: string | null; at: number }>()

/** For tests: forget every cached DCL name. */
export const _resetWallNamesCache = () => names.clear()

/** The wallet's first DCL name without `.dcl.eth`, cached an hour per wallet; null when it has none or the directory fails. */
async function dclName(wallet: string): Promise<string | null> {
  const hit = names.get(wallet)
  if (hit && Date.now() - hit.at < NAMES_TTL_MS) return hit.label
  try {
    const [first] = await getDclDirectory().getOwnedNames(wallet)
    const label = first ? first.replace(/\.dcl\.eth$/i, '') : null
    names.set(wallet, { label, at: Date.now() })
    return label
  } catch {
    return null // not cached: the next read tries again
  }
}

const shortWallet = (wallet: string) => {
  let w = wallet
  try { w = getAddress(wallet) } catch { /* not an address: show as stored */ }
  return `${w.slice(0, 6)}…${w.slice(-4)}`
}

/** What the wall calls a creator: a DCL name, else a short wallet, else a plain label. Never an email or display name. */
export async function creatorLabel(_user: { id: string }, wallets: string[]): Promise<string> {
  for (const w of wallets) {
    const name = await dclName(w)
    if (name) return name
  }
  return wallets.length ? shortWallet(wallets[0]) : 'A Virvi creator'
}

/** The view a design's wall tile spins: its own kind's default, from the paid revision. */
const wallView = (kind: string) =>
  kind === 'scene' ? SCENE_ORBIT_KEY : viewKey(kind, { bodyShape: 'male', outfit: 'default', emote: null })

type Row = {
  id: string; name: string; kind: string; owner_id: string; wall_shown_at: Date | string; wall_marketplace_url: string | null
  revision_id: string; category: string; job_id: string; frames: number
}

export async function listWall(page: { limit: number; offset: number }, now: Date): Promise<WallEntry[]> {
  // Per design: its newest ready entitlement (by paid date), that revision's wall view, which must be ready
  const rows = (await db.execute(sql`
    SELECT d.id, d.name, d.kind, d.owner_id, d.wall_shown_at, d.wall_marketplace_url,
           n.revision_id, n.category, r.job_id, r.frames
    FROM studio_designs d
    JOIN LATERAL (
      SELECT e.revision_id, e.category
      FROM studio_entitlements e
      LEFT JOIN studio_payments p ON p.id = e.payment_id
      WHERE e.design_id = d.id AND e.status = 'ready'
      ORDER BY COALESCE(p.paid_at, e.created_at) DESC, e.created_at DESC
      LIMIT 1
    ) n ON true
    JOIN studio_renders r ON r.revision_id = n.revision_id AND r.status = 'ready' AND r.frames > 0
      AND r.view_key = CASE d.kind WHEN 'scene' THEN ${wallView('scene')} WHEN 'emote' THEN ${wallView('emote')} ELSE ${wallView('wearable')} END
    WHERE d.wall_shown_at IS NOT NULL AND d.wall_hidden_at IS NULL
    ORDER BY d.wall_shown_at DESC, d.id
    LIMIT ${page.limit} OFFSET ${page.offset}
  `)) as unknown as Row[]
  if (!rows.length) return []

  const owners = [...new Set(rows.map((r) => r.owner_id))]
  const methods = await db.select({ userId: userAuthMethods.userId, wallet: userAuthMethods.identifier }).from(userAuthMethods)
    .where(and(eq(userAuthMethods.type, 'wallet'), inArray(userAuthMethods.userId, owners)))
    .orderBy(asc(userAuthMethods.createdAt))
  const creators = new Map<string, string>()
  for (const o of owners) creators.set(o, await creatorLabel({ id: o }, methods.filter((m) => m.userId === o).map((m) => m.wallet)))

  const expires = frameUrlExpiry(now)
  return rows.map((r) => {
    // A spin view is one turn of `frames`; a scene's orbit starts with its eye-level ring
    const n = r.kind === 'scene' ? ORBIT_RING : r.frames
    return {
      designId: r.id,
      name: r.name,
      kind: r.kind as WallEntry['kind'],
      creator: creators.get(r.owner_id)!,
      marketplaceUrl: r.wall_marketplace_url,
      shownAt: new Date(r.wall_shown_at).toISOString(),
      frames: Array.from({ length: WALL_FRAMES }, (_, i) => signRenderFrame({
        designId: r.id, revisionId: r.revision_id, viewKey: wallView(r.kind), category: r.category, frame: Math.floor(i * n / WALL_FRAMES), jobId: r.job_id,
      }, expires)),
    }
  })
}
