import { and, eq, inArray, isNotNull, isNull, notLike, sql } from 'drizzle-orm'
import {
  DEFAULT_VENUE_RULES,
  VENUE_ROLE_SCOPES,
  isVenueRole,
  isVenueScope,
  type VenueRole,
  type VenueRules,
  type VenueScope,
} from '@virvixr/shared'
import { db } from '../db/connection.js'
import {
  accessGrants,
  bookings,
  roomSets,
  sceneElementInstances,
  sceneElements,
  scenePresets,
  scenes,
  userAuthMethods,
  venues,
} from '../db/schema.js'
import { liveWindowEnd } from '../auth/permissions.js'
import { publishVenueEvent } from '../realtime/bus.js'

export class VenueError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function normalizeWallet(w: unknown): string {
  if (typeof w !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(w)) throw new VenueError(400, 'walletAddress must be 0x followed by 40 hex characters')
  return w.toLowerCase()
}

function parseDate(v: unknown, field: string): Date {
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : new Date(NaN)
  if (Number.isNaN(d.getTime())) throw new VenueError(400, `${field} must be an ISO date`)
  return d
}

function pgCode(err: any): string | undefined {
  return err?.code ?? err?.cause?.code
}

/**
 * The span a booking reserves: its whole live window (setup lead before, grace after) plus the
 * venue buffer on each side, so two bookings' live windows can never overlap.
 */
export function computeBlockedRange(startsAt: Date, endsAt: Date, rules: Pick<VenueRules, 'setupLeadMinutes' | 'graceMinutes' | 'bufferMinutes'>) {
  const from = startsAt.getTime() - (rules.setupLeadMinutes + rules.bufferMinutes) * 60_000
  const to = endsAt.getTime() + (rules.graceMinutes + rules.bufferMinutes) * 60_000
  return `[${new Date(from).toISOString()},${new Date(to).toISOString()})`
}

function assertValidRules(r: VenueRules) {
  for (const k of ['minHours', 'maxHours', 'setupLeadMinutes', 'graceMinutes', 'bufferMinutes'] as const) {
    const v = (r as any)[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new VenueError(400, `rules.${k} must be a number >= 0`)
  }
  for (const k of ['setupLeadMinutes', 'graceMinutes', 'bufferMinutes'] as const) {
    if (!Number.isInteger(r[k])) throw new VenueError(400, `rules.${k} must be a whole number`)
  }
  if (r.minHours > r.maxHours) throw new VenueError(400, 'rules.minHours must not exceed rules.maxHours')
}

// ── Venues ───────────────────────────────────────────────────────────────

export interface CreateVenueInput {
  sceneId: string
  name: string
  slug: string
  description?: string
  kind?: 'permanent' | 'popup'
  timezone?: string
  rules?: Partial<VenueRules>
  rentableElementIds?: string[]
  isListed?: boolean
}

async function assertRentableInPreset(presetId: string, ids: string[]) {
  if (!ids.length) return
  const rows = await db
    .select({ id: sceneElements.id })
    .from(sceneElements)
    .where(and(eq(sceneElements.presetId, presetId), inArray(sceneElements.id, ids)))
  if (rows.length !== new Set(ids).size) throw new VenueError(400, 'rentableElementIds must all belong to the venue default preset')
}

export async function createVenue(input: CreateVenueInput) {
  if (!input.name || !input.slug) throw new VenueError(400, 'name and slug are required')
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, input.sceneId) })
  if (!scene) throw new VenueError(404, 'Scene not found')
  if (!scene.activePresetId) throw new VenueError(400, 'Scene has no active preset to use as the venue default')
  const rules = { ...DEFAULT_VENUE_RULES, ...input.rules }
  assertValidRules(rules)
  const rentable = input.rentableElementIds ?? []
  await assertRentableInPreset(scene.activePresetId, rentable)
  try {
    const [venue] = await db
      .insert(venues)
      .values({
        sceneId: scene.id,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        kind: input.kind ?? 'permanent',
        defaultPresetId: scene.activePresetId,
        timezone: input.timezone ?? 'UTC',
        rules,
        rentableElementIds: rentable,
        isListed: input.isListed ?? false,
      })
      .returning()
    return venue
  } catch (err) {
    if (pgCode(err) === '23505') throw new VenueError(409, 'That scene is already a venue, or the slug is taken')
    throw err
  }
}

export async function updateVenue(
  id: string,
  patch: Partial<Pick<CreateVenueInput, 'name' | 'description' | 'timezone' | 'rules' | 'rentableElementIds' | 'isListed'>>,
) {
  const venue = await db.query.venues.findFirst({ where: eq(venues.id, id) })
  if (!venue) throw new VenueError(404, 'Venue not found')
  if (patch.rules !== undefined) assertValidRules({ ...venue.rules, ...patch.rules })
  if (patch.rentableElementIds) await assertRentableInPreset(venue.defaultPresetId, patch.rentableElementIds)
  const [updated] = await db
    .update(venues)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.timezone !== undefined && { timezone: patch.timezone }),
      ...(patch.rules !== undefined && { rules: { ...venue.rules, ...patch.rules } }),
      ...(patch.rentableElementIds !== undefined && { rentableElementIds: patch.rentableElementIds }),
      ...(patch.isListed !== undefined && { isListed: patch.isListed }),
      updatedAt: new Date(),
    })
    .where(eq(venues.id, id))
    .returning()
  return updated
}

// ── Preset cloning ───────────────────────────────────────────────────────

/** The copy of a room set model gets its own room set row (same GLB, which stays until nothing uses it). */
async function copyRoomSetLink(tx: Tx, fromElementId: string, toElementId: string) {
  const [row] = await tx.select().from(roomSets).where(eq(roomSets.sceneElementId, fromElementId))
  if (!row) return
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = row
  await tx.insert(roomSets).values({ ...rest, sceneElementId: toElementId, assetItemId: null })
}

/**
 * Copy a preset with all its elements and instances. A booking copy marks each element with the original it came
 * from (ads and rentable screens follow it); an `independent` copy (a host's own duplicate) doesn't, and also links
 * each copied room set model to its own room set row, sharing the GLB.
 */
export async function clonePreset(tx: Tx, presetId: string, name: string, opts: { independent?: boolean } = {}): Promise<string> {
  const source = await tx.query.scenePresets.findFirst({
    where: eq(scenePresets.id, presetId),
    with: { elements: { with: { instances: true } } },
  })
  if (!source) throw new VenueError(400, 'Venue default preset is missing')
  const [copy] = await tx.insert(scenePresets).values({ sceneId: source.sceneId, name, locale: source.locale }).returning()

  const instanceIdMap = new Map<string, string>()
  const pendingParents: { newId: string; oldParent: string }[] = []
  for (const el of source.elements) {
    const [newEl] = await tx
      .insert(sceneElements)
      .values({
        presetId: copy.id,
        type: el.type,
        name: el.name,
        enabled: el.enabled,
        customId: el.customId,
        customRendering: el.customRendering,
        clickEvent: el.clickEvent,
        properties: el.properties,
        clonedFromId: opts.independent ? null : el.id,
      })
      .returning()
    if (opts.independent && el.type === 'model') await copyRoomSetLink(tx, el.id, newEl.id)
    for (const inst of el.instances) {
      const [newInst] = await tx
        .insert(sceneElementInstances)
        .values({
          elementId: newEl.id,
          enabled: inst.enabled,
          customId: inst.customId,
          customRendering: inst.customRendering,
          position: inst.position,
          rotation: inst.rotation,
          scale: inst.scale,
          clickEvent: inst.clickEvent,
          withCollisions: inst.withCollisions,
          properties: inst.properties,
        })
        .returning()
      instanceIdMap.set(inst.id, newInst.id)
      if (inst.parentInstanceId) pendingParents.push({ newId: newInst.id, oldParent: inst.parentInstanceId })
    }
  }
  for (const p of pendingParents) {
    const parent = instanceIdMap.get(p.oldParent)
    if (parent) await tx.update(sceneElementInstances).set({ parentInstanceId: parent }).where(eq(sceneElementInstances.id, p.newId))
  }
  return copy.id
}

// ── Bookings ─────────────────────────────────────────────────────────────

export interface CreateBookingInput {
  venueId: string
  renterUserId?: string
  renterWallet?: string
  title: string
  startsAt: unknown
  endsAt: unknown
  createdByUserId: string
}

/** Only wallets proven by a verified signed fetch count; legacy and preview rows are ignored. */
const verifiedWalletMethod = and(
  eq(userAuthMethods.type, 'wallet'),
  sql`${userAuthMethods.metadata}->>'verified' = 'true'`,
  notLike(userAuthMethods.identifier, 'preview:%'),
)

async function walletForUser(userId: string): Promise<string | null> {
  const m = await db.query.userAuthMethods.findFirst({
    where: and(eq(userAuthMethods.userId, userId), verifiedWalletMethod),
  })
  return m && /^0x[0-9a-f]{40}$/.test(m.identifier) ? m.identifier : null
}

export async function createBooking(input: CreateBookingInput, now = new Date()) {
  const venue = await db.query.venues.findFirst({ where: eq(venues.id, input.venueId) })
  if (!venue) throw new VenueError(404, 'Venue not found')
  if (!input.title) throw new VenueError(400, 'title is required')
  const startsAt = parseDate(input.startsAt, 'startsAt')
  const endsAt = parseDate(input.endsAt, 'endsAt')
  if (endsAt <= startsAt) throw new VenueError(400, 'endsAt must be after startsAt')
  if (endsAt <= now) throw new VenueError(400, 'Booking has already ended')
  const hours = (endsAt.getTime() - startsAt.getTime()) / 3_600_000
  if (hours < venue.rules.minHours || hours > venue.rules.maxHours) {
    throw new VenueError(400, `Bookings at this venue must be ${venue.rules.minHours}–${venue.rules.maxHours} hours`)
  }
  if (!input.renterUserId && !input.renterWallet) throw new VenueError(400, 'renterUserId or renterWallet is required')
  const renterWallet = input.renterWallet
    ? normalizeWallet(input.renterWallet)
    : await walletForUser(input.renterUserId!)

  try {
    const result = await db.transaction(async (tx) => {
      const [booking] = await tx
        .insert(bookings)
        .values({
          venueId: venue.id,
          renterUserId: input.renterUserId ?? null,
          renterWallet,
          title: input.title,
          startsAt,
          endsAt,
          status: 'confirmed',
          blockedRange: computeBlockedRange(startsAt, endsAt, venue.rules),
        })
        .returning()
      const bookingPresetId = await clonePreset(tx, venue.defaultPresetId, `booking:${booking.id}`)
      const [withPreset] = await tx
        .update(bookings)
        .set({ bookingPresetId })
        .where(eq(bookings.id, booking.id))
        .returning()
      const [hostGrant] = await tx
        .insert(accessGrants)
        .values({
          bookingId: booking.id,
          sceneId: venue.sceneId,
          walletAddress: renterWallet,
          userId: input.renterUserId ?? null,
          role: 'host',
          scopes: [...VENUE_ROLE_SCOPES.host],
          validFrom: now,
          validUntil: liveWindowEnd({ endsAt }, venue.rules),
          grantedByUserId: input.createdByUserId,
        })
        .returning()
      return { booking: withPreset, hostGrant }
    })
    await publishVenueEvent({ type: 'grants_changed', sceneId: venue.sceneId })
    return result
  } catch (err) {
    if (pgCode(err) === '23P01') throw new VenueError(409, 'That time overlaps another booking at this venue')
    throw err
  }
}

export async function getBookingWithVenue(bookingId: string) {
  const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId), with: { venue: true } })
  if (!booking) throw new VenueError(404, 'Booking not found')
  return booking
}

export async function cancelBooking(bookingId: string) {
  const booking = await getBookingWithVenue(bookingId)
  const [updated] = await db
    .update(bookings)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(and(eq(bookings.id, bookingId), inArray(bookings.status, ['pending', 'confirmed', 'live'])))
    .returning()
  if (!updated) throw new VenueError(409, `Booking is already ${booking.status}`)
  await db
    .update(accessGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(accessGrants.bookingId, bookingId), isNull(accessGrants.revokedAt)))
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, booking.venue.sceneId) })
  if (scene && booking.bookingPresetId && scene.activePresetId === booking.bookingPresetId) {
    await db.update(scenes).set({ activePresetId: booking.venue.defaultPresetId, updatedAt: new Date() }).where(eq(scenes.id, scene.id))
    await publishVenueEvent({ type: 'preset_changed', sceneId: scene.id, presetId: booking.venue.defaultPresetId })
  }
  await publishVenueEvent({ type: 'booking_ended', sceneId: booking.venue.sceneId, bookingId, reason: 'canceled' })
  return updated
}

// ── Grants ───────────────────────────────────────────────────────────────

function resolveScopes(role: VenueRole, scopes: unknown): VenueScope[] {
  if (scopes === undefined) return [...VENUE_ROLE_SCOPES[role]]
  if (!Array.isArray(scopes) || !scopes.every(isVenueScope)) throw new VenueError(400, 'scopes must be venue scopes')
  return [...new Set(scopes)]
}

async function hostGrantFor(bookingId: string) {
  const host = await db.query.accessGrants.findFirst({
    where: and(eq(accessGrants.bookingId, bookingId), eq(accessGrants.role, 'host')),
  })
  if (!host) throw new VenueError(500, 'Booking has no host grant')
  return host
}

export interface AddGrantInput {
  bookingId: string
  walletAddress: unknown
  role: unknown
  scopes?: unknown
  validFrom?: unknown
  validUntil?: unknown
  grantedByUserId: string
}

export async function addGrant(input: AddGrantInput) {
  if (!isVenueRole(input.role)) throw new VenueError(400, 'role must be a venue role')
  if (input.role === 'host') throw new VenueError(400, 'The host grant is created with the booking')
  const wallet = normalizeWallet(input.walletAddress)
  const booking = await getBookingWithVenue(input.bookingId)
  if (!['confirmed', 'live'].includes(booking.status)) throw new VenueError(409, `Booking is ${booking.status}`)
  const host = await hostGrantFor(booking.id)
  const validFrom = input.validFrom === undefined ? new Date() : parseDate(input.validFrom, 'validFrom')
  const validUntil = input.validUntil === undefined ? host.validUntil : parseDate(input.validUntil, 'validUntil')
  if (validUntil <= validFrom) throw new VenueError(400, 'validUntil must be after validFrom')
  if (validFrom < host.validFrom || validUntil > host.validUntil) {
    throw new VenueError(400, "Crew access must fit inside the host's booking window")
  }
  const linked = await db.query.userAuthMethods.findFirst({
    where: and(verifiedWalletMethod, eq(userAuthMethods.identifier, wallet)),
  })
  const values = {
    role: input.role,
    scopes: resolveScopes(input.role, input.scopes),
    validFrom,
    validUntil,
    grantedByUserId: input.grantedByUserId,
  }
  try {
    // A revoked grant for this wallet still holds the (booking, wallet) unique key: restore it.
    const [restored] = await db
      .update(accessGrants)
      .set({ ...values, revokedAt: null, ...(linked && { userId: linked.userId }) })
      .where(
        and(eq(accessGrants.bookingId, booking.id), eq(accessGrants.walletAddress, wallet), isNotNull(accessGrants.revokedAt)),
      )
      .returning()
    const grant =
      restored ??
      (
        await db
          .insert(accessGrants)
          .values({
            ...values,
            bookingId: booking.id,
            sceneId: booking.venue.sceneId,
            walletAddress: wallet,
            userId: linked?.userId ?? null,
          })
          .returning()
      )[0]
    await publishVenueEvent({ type: 'grants_changed', sceneId: booking.venue.sceneId })
    return grant
  } catch (err) {
    if (pgCode(err) === '23505') throw new VenueError(409, 'That wallet already has access to this booking')
    throw err
  }
}

export async function getGrant(grantId: string) {
  const grant = await db.query.accessGrants.findFirst({ where: eq(accessGrants.id, grantId) })
  if (!grant) throw new VenueError(404, 'Grant not found')
  return grant
}

export async function updateGrant(grantId: string, patch: { role?: unknown; scopes?: unknown }) {
  const grant = await getGrant(grantId)
  let role = grant.role
  if (patch.role !== undefined) {
    if (!isVenueRole(patch.role) || patch.role === 'host') throw new VenueError(400, 'role must be a non-host venue role')
    if (grant.role === 'host') throw new VenueError(400, "The host's role can't be changed")
    role = patch.role
  }
  const scopes =
    patch.scopes !== undefined
      ? resolveScopes(role, patch.scopes)
      : patch.role !== undefined
        ? [...VENUE_ROLE_SCOPES[role]]
        : grant.scopes
  const [updated] = await db.update(accessGrants).set({ role, scopes }).where(eq(accessGrants.id, grantId)).returning()
  await publishVenueEvent({ type: 'grants_changed', sceneId: grant.sceneId })
  return updated
}

export async function revokeGrant(grantId: string) {
  const grant = await getGrant(grantId)
  if (grant.role === 'host') throw new VenueError(400, 'Cancel the booking to remove the host')
  await db.update(accessGrants).set({ revokedAt: new Date() }).where(eq(accessGrants.id, grantId))
  await publishVenueEvent({ type: 'grants_changed', sceneId: grant.sceneId })
}

export async function listGrants(bookingId: string) {
  return db.select().from(accessGrants).where(and(eq(accessGrants.bookingId, bookingId), isNull(accessGrants.revokedAt)))
}

export async function bookingsForActor(userId: string, wallet: string | null, now = new Date()) {
  const rows = await db.query.accessGrants.findMany({
    where: (g, { and, or, eq, isNull, gt }) =>
      and(isNull(g.revokedAt), gt(g.validUntil, now), wallet ? or(eq(g.userId, userId), eq(g.walletAddress, wallet)) : eq(g.userId, userId)),
    with: { booking: { with: { venue: true } } },
  })
  return rows
    .filter((g) => g.booking.status === 'confirmed' || g.booking.status === 'live')
    .map((g) => ({ ...g.booking, role: g.role, scopes: g.scopes, grantId: g.id }))
}
