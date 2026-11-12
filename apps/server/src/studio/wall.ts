import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getAddress } from 'ethers'
import { db } from '../db/connection.js'
import { studioDesigns, studioEntitlements, userAuthMethods, users } from '../db/schema.js'
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

/**
 * The wallet's name in Decentraland: the name on its profile (what people see over the avatar), else its first DCL
 * NAME without `.dcl.eth`. Cached an hour per wallet; null when it has neither or the directory fails.
 */
async function dclName(wallet: string): Promise<string | null> {
  const hit = names.get(wallet)
  if (hit && Date.now() - hit.at < NAMES_TTL_MS) return hit.label
  try {
    const dir = getDclDirectory()
    const profile = await dir.getProfileName(wallet).catch(() => null)
    const [first] = profile ? [] : await dir.getOwnedNames(wallet)
    const label = profile ?? (first ? first.replace(/\.dcl\.eth$/i, '') : null)
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

/**
 * What the wall calls a creator: their Decentraland name (profile, else an owned NAME), else a short wallet, else a plain label. Never an email or display name.
 * With a primary wallet (the verified one last signed in with) only that wallet is named, so the label never names a
 * wallet the owner didn't sign in with. Only with no primary are the other linked wallets tried, oldest first.
 */
export async function creatorLabel(_user: { id: string }, wallets: { primary: string | null; others: string[] }): Promise<string> {
  if (wallets.primary) return (await dclName(wallets.primary)) ?? shortWallet(wallets.primary)
  for (const w of wallets.others) {
    const name = await dclName(w)
    if (name) return name
  }
  return wallets.others.length ? shortWallet(wallets.others[0]) : 'A Virvi creator'
}

type WalletMethod = { userId: string; wallet: string; metadata: unknown; createdAt: Date; updatedAt: Date }

/** An owner's primary wallet (verified, most recently signed in with; updated_at), and the rest oldest first. */
export function ownerWallets(methods: WalletMethod[], userId: string): { primary: string | null; others: string[] } {
  const mine = methods.filter((m) => m.userId === userId && !m.wallet.startsWith('preview:'))
  const verified = mine.filter((m) => (m.metadata as { verified?: unknown } | null)?.verified === true)
  const primary = verified.reduce<WalletMethod | null>((best, m) => (!best || m.updatedAt > best.updatedAt ? m : best), null)
  const others = mine.filter((m) => m !== primary).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((m) => m.wallet)
  return { primary: primary?.wallet ?? null, others }
}

/** The view a design's wall tile spins: its own kind's default, from the paid revision. */
const wallView = (kind: string) =>
  kind === 'scene' ? SCENE_ORBIT_KEY : viewKey(kind, { bodyShape: 'male', outfit: 'default', emote: null })

type Row = {
  id: string; name: string; kind: string; owner_id: string; wall_shown_at: Date | string; wall_hidden_at: Date | string | null; wall_marketplace_url: string | null
  revision_id: string; category: string; job_id: string; frames: number
}

/** Shown designs with a ready wall view, newest first. The public wall leaves out admin-hidden ones; the admin page keeps them. */
async function selectWall(page: { limit: number; offset: number }, now: Date, includeHidden: boolean): Promise<(WallEntry & { hidden: boolean; ownerId: string })[]> {
  // Per design: its newest ready entitlement (by paid date), that revision's wall view, which must be ready
  const rows = (await db.execute(sql`
    SELECT d.id, d.name, d.kind, d.owner_id, d.wall_shown_at, d.wall_hidden_at, d.wall_marketplace_url,
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
    WHERE d.wall_shown_at IS NOT NULL ${includeHidden ? sql`` : sql`AND d.wall_hidden_at IS NULL`}
    ORDER BY d.wall_shown_at DESC, d.id
    LIMIT ${page.limit} OFFSET ${page.offset}
  `)) as unknown as Row[]
  if (!rows.length) return []

  const owners = [...new Set(rows.map((r) => r.owner_id))]
  const methods = await db.select({
    userId: userAuthMethods.userId, wallet: userAuthMethods.identifier, metadata: userAuthMethods.metadata,
    createdAt: userAuthMethods.createdAt, updatedAt: userAuthMethods.updatedAt,
  }).from(userAuthMethods)
    .where(and(eq(userAuthMethods.type, 'wallet'), inArray(userAuthMethods.userId, owners)))
    .orderBy(asc(userAuthMethods.createdAt))
  const creators = new Map<string, string>()
  for (const o of owners) creators.set(o, await creatorLabel({ id: o }, ownerWallets(methods, o)))

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
      hidden: !!r.wall_hidden_at,
      ownerId: r.owner_id,
      frames: Array.from({ length: WALL_FRAMES }, (_, i) => signRenderFrame({
        designId: r.id, revisionId: r.revision_id, viewKey: wallView(r.kind), category: r.category, frame: Math.floor(i * n / WALL_FRAMES), jobId: r.job_id,
      }, expires)),
    }
  })
}

export async function listWall(page: { limit: number; offset: number }, now: Date): Promise<WallEntry[]> {
  return (await selectWall(page, now, false)).map(({ hidden: _h, ownerId: _o, ...entry }) => entry)
}

const ADMIN_WALL_LIMIT = 500

/** Every shown entry for the admin page, hidden ones included, with the owner's email. */
export async function listWallForAdmin(now: Date): Promise<(WallEntry & { hidden: boolean; ownerEmail: string | null })[]> {
  const rows = await selectWall({ limit: ADMIN_WALL_LIMIT, offset: 0 }, now, true)
  if (!rows.length) return []
  const owners = await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.ownerId))]))
  const emails = new Map(owners.map((o) => [o.id, o.email]))
  return rows.map(({ ownerId, ...entry }) => ({ ...entry, ownerEmail: emails.get(ownerId) ?? null }))
}

/** An admin hides or restores a shown design. Separate from the owner's choice, which never clears it. False when there is no such design. */
export async function setWallHidden(designId: string, hidden: boolean, now: Date): Promise<boolean> {
  const updated = await db.update(studioDesigns).set({ wallHiddenAt: hidden ? now : null }).where(eq(studioDesigns.id, designId)).returning({ id: studioDesigns.id })
  return updated.length > 0
}
