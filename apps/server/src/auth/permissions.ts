import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  VENUE_SCOPES,
  type BookingWindow,
  type VenueAccessMessage,
  type VenueRole,
  type VenueRules,
  type VenueScope,
} from '@virvixr/shared'
import { db } from '../db/connection.js'
import { accessGrants, bookings, sceneCollaborators, sceneRoles, scenes, venues } from '../db/schema.js'
import type { Actor } from './actor.js'
import { sceneRoleFor } from './scene-roles.js'

export type SceneScope = VenueScope | 'scene.edit' | 'scene.admin' | 'analytics.view' | 'roles.manage'
export type AccessLevel = 'admin' | 'owner' | 'cohost' | 'editor' | 'viewer' | 'grant' | 'none'

export interface BookingAccess {
  bookingId: string
  grantId: string
  role: VenueRole
  bookingPresetId: string | null
  window: BookingWindow
  validUntil: Date
  rentableElementIds: Set<string>
}

export interface SceneAccess {
  level: AccessLevel
  scopes: Set<SceneScope>
  booking: BookingAccess | null
}

const ALL_SCOPES: SceneScope[] = [...VENUE_SCOPES, 'scene.edit', 'scene.admin', 'analytics.view', 'roles.manage']
const EDITOR_SCOPES: SceneScope[] = [...VENUE_SCOPES.filter((s) => s !== 'crew'), 'scene.edit', 'analytics.view']
const NONE: SceneAccess = { level: 'none', scopes: new Set(), booking: null }

const full = (level: 'admin' | 'owner' | 'cohost'): SceneAccess => ({ level, scopes: new Set(ALL_SCOPES), booking: null })

/** Everything a scene allows, including role management. Co-hosts included; see isHostAccess for host-only actions. */
export function isFullAccess(access: SceneAccess) {
  return access.level === 'admin' || access.level === 'owner' || access.level === 'cohost'
}

/** Host-only actions: transfer host, delete the scene, delete analytics data. */
export function isHostAccess(access: SceneAccess) {
  return access.level === 'admin' || access.level === 'owner'
}

export function hasScope(access: SceneAccess, scope: SceneScope) {
  return access.scopes.has(scope)
}

const SCENE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const minutes = (n: number) => n * 60_000

export function liveWindowStart(b: { startsAt: Date }, rules: VenueRules) {
  return new Date(b.startsAt.getTime() - minutes(rules.setupLeadMinutes))
}

export function liveWindowEnd(b: { endsAt: Date }, rules: VenueRules) {
  return new Date(b.endsAt.getTime() + minutes(rules.graceMinutes))
}

export function bookingWindowAt(b: { startsAt: Date; endsAt: Date }, rules: VenueRules, at: Date): BookingWindow | null {
  if (at < liveWindowStart(b, rules)) return 'setup'
  if (at < liveWindowEnd(b, rules)) return 'live'
  return null
}

/**
 * What `actor` may do in the scene. A deleted scene (LIV-83) gives no access to anyone, admins included: only the
 * delete routes' own check (scenes/deleted.ts mayManageDeletion) reaches it, to restore or purge it.
 */
export async function getSceneAccess(actor: Actor, sceneId: string, at = new Date()): Promise<SceneAccess> {
  // A trial owns its own scenes and nothing else: no admin, collaborator, role or grant paths.
  if (actor.trial) {
    if (!actor.userId) return NONE
    const own = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { ownerId: true, deletedAt: true } })
    return own?.ownerId === actor.userId && !own.deletedAt ? full('owner') : NONE
  }
  if (!actor.userId || !actor.verified) return NONE
  if (actor.role === 'admin') {
    // Not a scene id: as before, the route's own lookup answers (no query on a malformed uuid)
    if (!SCENE_UUID.test(sceneId)) return full('admin')
    const s = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { deletedAt: true } })
    return s?.deletedAt ? NONE : full('admin')
  }

  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
  if (!scene || scene.deletedAt) return NONE
  if (scene.ownerId === actor.userId) return full('owner')

  const collab = await db.query.sceneCollaborators.findFirst({
    where: and(eq(sceneCollaborators.sceneId, sceneId), eq(sceneCollaborators.userId, actor.userId)),
  })
  if (collab?.role === 'editor') return { level: 'editor', scopes: new Set(EDITOR_SCOPES), booking: null }

  const role = await sceneRoleFor(sceneId, actor)
  if (role === 'cohost') return full('cohost')
  if (role === 'editor') return { level: 'editor', scopes: new Set(EDITOR_SCOPES), booking: null }

  const subject = actor.wallet
    ? or(eq(accessGrants.userId, actor.userId), eq(accessGrants.walletAddress, actor.wallet))
    : eq(accessGrants.userId, actor.userId)

  // Prefer a booking that is live, then the soonest one.
  const [row] = await db
    .select({ grant: accessGrants, booking: bookings, venue: venues })
    .from(accessGrants)
    .innerJoin(bookings, eq(accessGrants.bookingId, bookings.id))
    .innerJoin(venues, eq(bookings.venueId, venues.id))
    .where(
      and(
        eq(accessGrants.sceneId, sceneId),
        isNull(accessGrants.revokedAt),
        lte(accessGrants.validFrom, at),
        gt(accessGrants.validUntil, at),
        inArray(bookings.status, ['confirmed', 'live']),
        subject,
      ),
    )
    .orderBy(desc(sql`(${bookings.status} = 'live')`), asc(bookings.startsAt))
    .limit(1)

  if (row) {
    const window = bookingWindowAt(row.booking, row.venue.rules, at)
    if (window) {
      return {
        level: 'grant',
        scopes: new Set(row.grant.scopes),
        booking: {
          bookingId: row.booking.id,
          grantId: row.grant.id,
          role: row.grant.role,
          bookingPresetId: row.booking.bookingPresetId,
          window,
          validUntil: row.grant.validUntil,
          rentableElementIds: new Set(row.venue.rentableElementIds),
        },
      }
    }
  }

  if (collab || role === 'viewer') return { level: 'viewer', scopes: new Set<SceneScope>(['analytics.view']), booking: null }
  return NONE
}

/** The actor's active grant for one specific booking, or null. */
export async function getBookingGrant(actor: Actor, bookingId: string, at = new Date()) {
  if (!actor.userId || !actor.verified) return null
  const subject = actor.wallet
    ? or(eq(accessGrants.userId, actor.userId), eq(accessGrants.walletAddress, actor.wallet))
    : eq(accessGrants.userId, actor.userId)
  const [row] = await db
    .select({ grant: accessGrants })
    .from(accessGrants)
    .innerJoin(bookings, eq(accessGrants.bookingId, bookings.id))
    .where(
      and(
        eq(accessGrants.bookingId, bookingId),
        isNull(accessGrants.revokedAt),
        lte(accessGrants.validFrom, at),
        gt(accessGrants.validUntil, at),
        inArray(bookings.status, ['confirmed', 'live']),
        subject,
      ),
    )
    .limit(1)
  return row?.grant ?? null
}

export async function can(actor: Actor, sceneId: string, scope: SceneScope, at = new Date()) {
  const access = await getSceneAccess(actor, sceneId, at)
  if (!access.scopes.has(scope)) return { ok: false, target: null } as const
  if (access.level !== 'grant') return { ok: true, target: 'live' } as const
  return {
    ok: true,
    target: access.booking!.window === 'live' ? 'live' : 'bookingPreset',
    bookingId: access.booking!.bookingId,
  } as const
}

const PLAYLIST_KEYS = new Set(['playlist', 'playlistIndex'])
const GRANT_FIELD_KEYS = new Set(['enabled'])

/** Scopes a grant holder needs for this change, or null if grant holders may never make it. */
export function scopesForElementChange(type: string, propertyKeys: string[], fieldKeys: string[]): VenueScope[] | null {
  if (fieldKeys.some((k) => !GRANT_FIELD_KEYS.has(k))) return null
  const base: VenueScope | null =
    type === 'video' || type === 'image' || type === 'nft' || type === 'ad_space' ? 'screens' : type === 'sound' ? 'audio' : null
  if (!base) return null
  const needed = new Set<VenueScope>()
  for (const k of propertyKeys) needed.add(type === 'video' && PLAYLIST_KEYS.has(k) ? 'playlist' : base)
  if (fieldKeys.length || needed.size === 0) needed.add(base)
  return [...needed]
}

export function canWriteElement(
  access: SceneAccess,
  element: { id: string; presetId: string; clonedFromId: string | null; type: string },
  change: { propertyKeys: string[]; fieldKeys: string[] },
): boolean {
  if (isFullAccess(access) || access.level === 'editor') return true
  if (access.level !== 'grant' || !access.booking) return false
  if (element.presetId !== access.booking.bookingPresetId) return false
  const rentable = access.booking.rentableElementIds
  if (!rentable.has(element.id) && !(element.clonedFromId && rentable.has(element.clonedFromId))) return false
  const needed = scopesForElementChange(element.type, change.propertyKeys, change.fieldKeys)
  return !!needed && needed.every((s) => access.scopes.has(s))
}

export function diffKeys(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>): string[] {
  const prev = before ?? {}
  const keys = new Set([...Object.keys(prev), ...Object.keys(after)])
  return [...keys].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(after[k]))
}

export function toVenueAccessMessage(access: SceneAccess): VenueAccessMessage {
  if (access.level !== 'grant' || !access.booking) {
    return { bookingId: null, role: null, scopes: [], window: null, validUntil: null }
  }
  return {
    bookingId: access.booking.bookingId,
    role: access.booking.role,
    scopes: [...access.scopes].filter((s): s is VenueScope => !s.startsWith('scene.')),
    window: access.booking.window,
    validUntil: access.booking.validUntil.toISOString(),
  }
}

/** Attach wallet-only grants to the user who just proved that wallet. */
export async function linkWalletGrants(userId: string, wallet: string): Promise<number> {
  const rows = await db
    .update(accessGrants)
    .set({ userId })
    .where(and(eq(accessGrants.walletAddress, wallet.toLowerCase()), isNull(accessGrants.userId)))
    .returning({ id: accessGrants.id })
  const roles = await db
    .update(sceneRoles)
    .set({ userId })
    .where(and(eq(sceneRoles.walletAddress, wallet.toLowerCase()), isNull(sceneRoles.userId), isNull(sceneRoles.revokedAt)))
    .returning({ id: sceneRoles.id })
  return rows.length + roles.length
}
