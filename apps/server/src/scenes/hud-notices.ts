import { and, gte, isNull } from 'drizzle-orm'
import { DCL_HUD_LATEST } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { scenes } from '../db/schema.js'
import { config } from '../config.js'
import { withLock } from '../errors/jobs.js'
import { notifySceneUpdate } from '../notifications/notifications.js'
import { dclHudStatus, virviDeploysDcl } from './hud-version.js'

/**
 * LIV-30 / LIV-13: the owner of a scene whose Decentraland HUD is behind the latest release hears of it in the bell,
 * once per scene per release. Only scenes whose HUD called in the last 30 days: a scene nobody visits isn't news.
 */

export const ACTIVE_DAYS = 30
const EVERY_MS = 60 * 60_000

export async function sweepHudUpdates(now = new Date(), latest = DCL_HUD_LATEST): Promise<number> {
  const rows = await db.select({ id: scenes.id, name: scenes.name, ownerId: scenes.ownerId, dclHudVersion: scenes.dclHudVersion, dclHudSeenAt: scenes.dclHudSeenAt })
    .from(scenes)
    .where(and(isNull(scenes.deletedAt), gte(scenes.dclHudSeenAt, new Date(now.getTime() - ACTIVE_DAYS * 24 * 3600_000))))
  let sent = 0
  for (const s of rows) {
    if (!dclHudStatus(s, latest)?.behind) continue
    try {
      if (await notifySceneUpdate({ ownerId: s.ownerId, sceneId: s.id, sceneName: s.name, version: s.dclHudVersion, latest, virviDeploys: await virviDeploysDcl(s.id) })) sent++
    } catch (err) {
      console.error('[hud-notices] not sent:', s.id, err instanceof Error ? err.message : err)
    }
  }
  return sent
}

/** Hourly on one instance (advisory lock), first a couple of minutes after boot so a release's notices go out soon. */
export function startHudNoticeJobs(): () => void {
  if (!config.hudNoticesEnabled) return () => {}
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const sent = await withLock('hud-notices', () => sweepHudUpdates())
      if (sent) console.log(`[hud-notices] told ${sent} scene owner${sent === 1 ? '' : 's'} about ${DCL_HUD_LATEST}`)
    } catch (err) {
      console.error('[hud-notices] sweep failed:', err instanceof Error ? err.message : err)
    } finally {
      running = false
    }
  }
  const timers = [setInterval(tick, EVERY_MS), setTimeout(tick, 2 * 60_000)]
  for (const t of timers) t.unref()
  return () => { for (const t of timers) clearTimeout(t) }
}
