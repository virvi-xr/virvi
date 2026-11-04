import { and, eq, gt, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { bookings, scenePresets, scenes, venues } from '../db/schema.js'
import { hasScope, type SceneAccess } from '../auth/permissions.js'
import { clonePreset } from '../venues/service.js'
import { describeSchedule, schedulesUsingPreset, specOf } from './preset-schedules.js'
import { publishScenePresetsChanged, publishVenueEvent } from '../realtime/bus.js'

export const PRESET_NAME_MAX = 60

/** Hosts, co-hosts and editors manage presets. Booking crew (grant holders) never do, whatever their scopes. */
export function canManagePresets(access: SceneAccess): boolean {
  return access.level !== 'grant' && hasScope(access, 'scene.edit')
}

/** A preset name: trimmed, 1–60 characters. null when it isn't one. */
export function cleanPresetName(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const name = input.trim()
  return name && name.length <= PRESET_NAME_MAX ? name : null
}

export interface PresetSummary { id: string; name: string; locale: string | null; createdAt: Date; updatedAt: Date }

const summary = (p: typeof scenePresets.$inferSelect): PresetSummary =>
  ({ id: p.id, name: p.name, locale: p.locale, createdAt: p.createdAt, updatedAt: p.updatedAt })

/** A blank preset, or (with `fromPresetId`, which must be this scene's) an independent copy of one. */
export async function createPreset(sceneId: string, name: string, fromPresetId?: string): Promise<PresetSummary> {
  const id = await db.transaction(async (tx) => {
    if (fromPresetId) return clonePreset(tx, fromPresetId, name, { independent: true })
    const [p] = await tx.insert(scenePresets).values({ sceneId, name }).returning()
    return p.id
  })
  const preset = (await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, id) }))!
  await publishScenePresetsChanged({ sceneId, action: 'upsert', preset: summary(preset) })
  return summary(preset)
}

export async function renamePreset(preset: typeof scenePresets.$inferSelect, name: string): Promise<PresetSummary> {
  const [updated] = await db.update(scenePresets).set({ name, updatedAt: new Date() }).where(eq(scenePresets.id, preset.id)).returning()
  await publishScenePresetsChanged({ sceneId: preset.sceneId, action: 'upsert', preset: summary(updated) })
  return summary(updated)
}

export type DeleteRefusal = { error: 'preset_live' | 'preset_only' | 'preset_venue_default' | 'preset_booking' | 'preset_scheduled'; message: string }

/** Why a preset can't be deleted, or null when it can. Ended and canceled bookings don't hold their preset. */
export async function deleteRefusal(preset: typeof scenePresets.$inferSelect, now = new Date()): Promise<DeleteRefusal | null> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, preset.sceneId), columns: { activePresetId: true } })
  if (scene?.activePresetId === preset.id) {
    return { error: 'preset_live', message: 'This preset is live. Make another preset live first.' }
  }
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(scenePresets).where(eq(scenePresets.sceneId, preset.sceneId))
  if (count <= 1) return { error: 'preset_only', message: "This is the scene's only preset." }
  const venue = await db.query.venues.findFirst({ where: eq(venues.defaultPresetId, preset.id), columns: { name: true } })
  if (venue) return { error: 'preset_venue_default', message: `This is the default preset for venue ${venue.name}.` }
  const [booking] = await db
    .select({ title: bookings.title, startsAt: bookings.startsAt })
    .from(bookings)
    .where(and(
      eq(bookings.bookingPresetId, preset.id),
      inArray(bookings.status, ['pending', 'confirmed', 'live']),
      or(gt(bookings.endsAt, now), eq(bookings.status, 'live')),
    ))
    .limit(1)
  if (booking) return { error: 'preset_booking', message: `The booking "${booking.title}" uses this preset.` }
  const [schedule] = await schedulesUsingPreset(preset.id, now)
  if (schedule) {
    const scheduled = await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, schedule.presetId), columns: { name: true } })
    return { error: 'preset_scheduled', message: `The schedule "${describeSchedule(specOf(schedule), scheduled?.name ?? 'a preset')}" uses this preset.` }
  }
  return null
}

export async function deletePreset(preset: typeof scenePresets.$inferSelect): Promise<void> {
  await db.delete(scenePresets).where(eq(scenePresets.id, preset.id))
  await publishScenePresetsChanged({ sceneId: preset.sceneId, action: 'delete', presetId: preset.id })
}

/** Make a preset live: every connected scene and open dashboard switches to it. */
export async function activatePreset(sceneId: string, presetId: string): Promise<void> {
  await db.update(scenes).set({ activePresetId: presetId, updatedAt: new Date() }).where(eq(scenes.id, sceneId))
  try {
    await publishVenueEvent({ type: 'preset_changed', sceneId, presetId })
  } catch (err) {
    console.error('[presets] preset_changed publish failed:', err)
  }
}
