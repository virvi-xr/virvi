import { sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import type { Thresholds } from './settings.js'

const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR

/**
 * A spike: an hour's count at spikeFactor (3x) or more of the usual for that hour of the week. Usual is the mean of the
 * same hour in the past weeks the signature existed (up to spikeHistoryWeeks), never taken as less than
 * spikeMinBaseline, and a spike needs at least spikeMinCount. With no past week there is no usual, so a new signature
 * is never a spike (it shows as new instead).
 */
export function spikeCheck(current: number, pastWeeks: number[], t: Pick<Thresholds, 'spikeFactor' | 'spikeMinBaseline' | 'spikeMinCount'>) {
  const usual = pastWeeks.length ? pastWeeks.reduce((a, b) => a + b, 0) / pastWeeks.length : 0
  const spiking = pastWeeks.length > 0 && current >= t.spikeMinCount && current >= t.spikeFactor * Math.max(usual, t.spikeMinBaseline)
  return { spiking, usual }
}

export interface Spike { signatureId: string; hour: Date; count: number; usual: number }

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`
const rowsOf = <T>(r: unknown) => r as unknown as T[]

/** Signatures spiking in the current or the last full hour. */
export async function findSpikes(now: Date, t: Thresholds): Promise<Spike[]> {
  const h0 = new Date(Math.floor(now.getTime() / HOUR) * HOUR)
  const hours = [h0, new Date(h0.getTime() - HOUR)]
  const out = new Map<string, Spike>()
  for (const hour of hours) {
    const rows = rowsOf<{ signature_id: string; count: number; first_seen_at: string }>(await db.execute(sql`
      SELECT h.signature_id, h.count, s.first_seen_at FROM error_hourly h JOIN error_signatures s ON s.id = h.signature_id
      WHERE h.hour = ${ts(hour)} AND h.count >= ${t.spikeMinCount}`))
    if (!rows.length) continue
    const past = Array.from({ length: t.spikeHistoryWeeks }, (_, i) => new Date(hour.getTime() - (i + 1) * WEEK))
    const history = rowsOf<{ signature_id: string; hour: string; count: number }>(await db.execute(sql`
      SELECT signature_id, hour, count FROM error_hourly
      WHERE signature_id IN (${sql.join(rows.map((r) => sql`${r.signature_id}::uuid`), sql`, `)})
        AND hour IN (${sql.join(past.map(ts), sql`, `)})`))
    for (const r of rows) {
      const firstHour = Math.floor(new Date(r.first_seen_at).getTime() / HOUR) * HOUR
      // Only the weeks the signature already existed count, and an hour with no row is a zero
      const weeks = past.filter((p) => p.getTime() >= firstHour).map((p) => {
        const h = history.find((x) => x.signature_id === r.signature_id && new Date(x.hour).getTime() === p.getTime())
        return h ? Number(h.count) : 0
      })
      const c = spikeCheck(Number(r.count), weeks, t)
      if (c.spiking && !out.has(r.signature_id)) out.set(r.signature_id, { signatureId: r.signature_id, hour, count: Number(r.count), usual: c.usual })
    }
  }
  return [...out.values()]
}
