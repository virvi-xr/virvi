import { and, eq, isNull } from 'drizzle-orm'
import { compareHudVersions, DCL_HUD_LATEST, parseHudVersion } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { sceneDeployments, scenes } from '../db/schema.js'

/**
 * LIV-33: which Decentraland HUD release each scene runs, from the x-virvi-hud-version its HUD sends with every
 * request. A scene runs the HUD it was deployed with, so an older one means the scene needs a redeploy (LIV-13).
 */

/** At most one write per scene per hour while nothing changes: the HUD calls often, and the dashboard needs no more. */
const WRITE_EVERY_MS = 60 * 60_000
const written = new Map<string, { version: string | null; at: number }>()

/** A Decentraland HUD called for this scene, sending `raw` as its version (absent for HUDs before the header). */
export async function noteDclHud(sceneId: string, raw: unknown, now = Date.now()): Promise<void> {
  const version = parseHudVersion(raw) ? String(raw).trim() : null
  const last = written.get(sceneId)
  if (last && last.version === version && now - last.at < WRITE_EVERY_MS) return
  written.set(sceneId, { version, at: now })
  try {
    // The newest seen wins: during a redeploy an old copy can still be running for a while, and it mustn't flip the
    // scene back to "behind". A scene that only ever sent no version keeps null
    const [row] = await db.select({ v: scenes.dclHudVersion }).from(scenes).where(eq(scenes.id, sceneId))
    if (!row) return
    const keep = row.v && compareHudVersions(row.v, version) > 0 ? row.v : version ?? row.v
    await db.update(scenes).set({ dclHudVersion: keep, dclHudSeenAt: new Date(now) }).where(eq(scenes.id, sceneId))
  } catch (err) {
    console.error('[hud-version] not recorded:', err instanceof Error ? err.message : err)
  }
}

/** Tests: forget the throttle. */
export function clearHudVersionThrottle() { written.clear() }

/** The first release that sends its version. A HUD that sends none is older than this one. */
export const FIRST_VERSIONED_HUD = '2.14.0'

/**
 * What the dashboard shows: the scene's HUD release, the latest, whether it is behind, and whether Virvi deploys it
 * (LIV-13: a Redeploy button helps only then; a scene its creator deploys from their own project needs its
 * @virvixr/dcl updated there). Null: no HUD seen yet.
 * A HUD that sent no version is behind only once the latest release sends one: before that, redeploying wouldn't
 * change anything.
 */
export function dclHudStatus(s: { dclHudVersion: string | null; dclHudSeenAt: Date | null }, latest: string = DCL_HUD_LATEST, virviDeploys = true) {
  if (!s.dclHudSeenAt) return null
  const behind = s.dclHudVersion
    ? compareHudVersions(s.dclHudVersion, latest) < 0
    : compareHudVersions(latest, FIRST_VERSIONED_HUD) >= 0
  return { version: s.dclHudVersion, latest, seenAt: s.dclHudSeenAt, behind, virviDeploys }
}

/** Whether Virvi has a live Decentraland deployment of the scene (a World, or parcels), which its Redeploy can replace. */
export async function virviDeploysDcl(sceneId: string): Promise<boolean> {
  const [row] = await db.select({ id: sceneDeployments.id }).from(sceneDeployments).where(and(
    eq(sceneDeployments.sceneId, sceneId), eq(sceneDeployments.platform, 'decentraland'),
    eq(sceneDeployments.status, 'deployed'), isNull(sceneDeployments.removedAt),
  )).limit(1)
  return !!row
}
