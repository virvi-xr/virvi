import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { bookings, scenes, venues } from '../db/schema.js'
import { publishVenueEvent, type VenueEvent } from '../realtime/bus.js'
import { runPresetScheduleSweep } from '../scenes/preset-schedules.js'

// Must match liveWindowStart / liveWindowEnd in src/auth/permissions.ts.
const setupLead = sql`make_interval(mins => (${venues.rules}->>'setupLeadMinutes')::int)`
const grace = sql`make_interval(mins => (${venues.rules}->>'graceMinutes')::int)`

/**
 * Move bookings through confirmed → live → ended. Every transition is a
 * conditional UPDATE … RETURNING, so concurrent sweeps (or servers) can't
 * apply the same transition twice.
 */
export async function runLifecycleSweep(at = new Date()) {
  const wentLive: string[] = []
  const ended: string[] = []

  // ── End: confirmed or live bookings past endsAt + grace ─────────────────
  const due = await db
    .select({ booking: bookings, venue: venues })
    .from(bookings)
    .innerJoin(venues, eq(bookings.venueId, venues.id))
    .where(and(inArray(bookings.status, ['confirmed', 'live']), sql`${bookings.endsAt} + ${grace} <= ${at.toISOString()}::timestamptz`))

  for (const { booking, venue } of due) {
    // Status flip and preset revert commit together, so a failure can't strand the booking.
    const events = await db.transaction(async (tx) => {
      const [won] = await tx
        .update(bookings)
        .set({ status: 'ended', updatedAt: at })
        .where(and(eq(bookings.id, booking.id), inArray(bookings.status, ['confirmed', 'live'])))
        .returning({ id: bookings.id })
      if (!won) return null
      const evs: VenueEvent[] = []
      if (booking.bookingPresetId) {
        const reverted = await tx
          .update(scenes)
          .set({ activePresetId: venue.defaultPresetId, updatedAt: at })
          .where(and(eq(scenes.id, venue.sceneId), eq(scenes.activePresetId, booking.bookingPresetId)))
          .returning({ id: scenes.id })
        if (reverted.length) evs.push({ type: 'preset_changed', sceneId: venue.sceneId, presetId: venue.defaultPresetId })
      }
      evs.push({ type: 'booking_ended', sceneId: venue.sceneId, bookingId: booking.id, reason: 'expired' })
      return evs
    })
    if (!events) continue
    ended.push(booking.id)
    for (const e of events) await publishVenueEvent(e)
  }

  // ── Go live: confirmed bookings inside the live window ─────────────────
  const starting = await db
    .select({ booking: bookings, venue: venues })
    .from(bookings)
    .innerJoin(venues, eq(bookings.venueId, venues.id))
    .where(
      and(
        eq(bookings.status, 'confirmed'),
        sql`${bookings.startsAt} - ${setupLead} <= ${at.toISOString()}::timestamptz`,
        sql`${bookings.endsAt} + ${grace} > ${at.toISOString()}::timestamptz`,
      ),
    )

  for (const { booking, venue } of starting) {
    const events = await db.transaction(async (tx) => {
      const [won] = await tx
        .update(bookings)
        .set({ status: 'live', updatedAt: at })
        .where(and(eq(bookings.id, booking.id), eq(bookings.status, 'confirmed')))
        .returning({ id: bookings.id })
      if (!won) return null
      const evs: VenueEvent[] = []
      if (booking.bookingPresetId) {
        await tx.update(scenes).set({ activePresetId: booking.bookingPresetId, updatedAt: at }).where(eq(scenes.id, venue.sceneId))
        evs.push({ type: 'preset_changed', sceneId: venue.sceneId, presetId: booking.bookingPresetId })
      }
      evs.push({ type: 'grants_changed', sceneId: venue.sceneId })
      return evs
    })
    if (!events) continue
    wentLive.push(booking.id)
    for (const e of events) await publishVenueEvent(e)
  }

  // ── Purge booking presets 30 days after the booking finished ───────────
  const purged = await db.execute(sql`
    DELETE FROM scene_presets
    WHERE id IN (
      SELECT booking_preset_id FROM bookings
      WHERE status IN ('ended', 'canceled')
        AND booking_preset_id IS NOT NULL
        AND ends_at < ${at.toISOString()}::timestamptz - interval '30 days'
    )
    AND id NOT IN (SELECT active_preset_id FROM scenes WHERE active_preset_id IS NOT NULL)
    RETURNING id
  `)
  const purgedPresets = (purged as unknown as unknown[]).length

  return { wentLive, ended, purgedPresets }
}

export function startLifecycleSweep(intervalMs: number): () => void {
  if (intervalMs <= 0) return () => {}
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await runLifecycleSweep()
    } catch (err) {
      console.error('[virvi-server] Lifecycle sweep failed:', err)
    }
    // Scheduled presets run after bookings, so a booking that just ended has handed the scene back first
    try {
      await runPresetScheduleSweep()
    } catch (err) {
      console.error('[virvi-server] Preset schedule sweep failed:', err)
    } finally {
      running = false
    }
  }, intervalMs)
  return () => clearInterval(timer)
}
