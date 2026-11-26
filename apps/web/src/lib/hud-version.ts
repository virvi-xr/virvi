import { compareHudVersions } from '@virvixr/shared'
import { DCL_CHANGELOG } from './dcl-changelog'

/** LIV-33 / LIV-13: the scene's Decentraland HUD release, as GET /api/scenes/:id gives it (null until a HUD has called). */
export type DclHudStatus = { version: string | null; latest: string; seenAt: string; behind: boolean; virviDeploys?: boolean } | null | undefined

/** The warning on the scene page when its Decentraland HUD is behind; null when it is current or unknown. */
export function hudBehindNote(s: DclHudStatus): string | null {
  if (!s?.behind) return null
  const running = s.version ? `HUD ${s.version}` : 'an older HUD'
  // A scene its creator deploys from their own project (not through Virvi) is updated there (LIV-13)
  if (s.virviDeploys === false) {
    return `This scene runs ${running} in Decentraland; the latest is ${s.latest}. To give visitors the latest fixes and features, run \`npm install @virvixr/dcl@latest\` in your scene's folder, then deploy it the way you usually do.`
  }
  return `This scene runs ${running} in Decentraland; the latest is ${s.latest}. Redeploy it to give visitors the latest fixes and features.`
}

/** Whether the warning offers Redeploy: only when Virvi deploys the scene (older servers don't say, so yes). */
export const hudRedeployHere = (s: DclHudStatus) => s?.virviDeploys !== false

export const DCL_CHANGELOG_URL = '/docs/sdk/decentraland/changelog/'

/**
 * LIV-13: what a scene that's behind is missing, from the changelog: the headlines of every release newer than the
 * scene's HUD, up to the latest, newest first, each named once. Null when the scene isn't behind or its version is
 * unknown (a HUD from before 2.14.0 doesn't say, so the list would be a guess).
 */
export function hudMissing(s: DclHudStatus, max = 5): { highlights: string[]; more: number } | null {
  if (!s?.behind || !s.version) return null
  const all = [...new Set(DCL_CHANGELOG
    .filter((r) => compareHudVersions(r.version, s.version) > 0 && compareHudVersions(r.version, s.latest) <= 0)
    .flatMap((r) => r.highlights))]
  if (!all.length) return null
  return { highlights: all.slice(0, max), more: Math.max(0, all.length - max) }
}

/** "New since 2.19.0: A, B and C." or "…: A, B, C, D, E and 3 more." */
export function hudMissingNote(s: DclHudStatus): string | null {
  const m = hudMissing(s)
  if (!m) return null
  const items = m.more ? [...m.highlights, `${m.more} more`] : m.highlights
  const list = items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0]
  return `New since ${s!.version}: ${list}.`
}
