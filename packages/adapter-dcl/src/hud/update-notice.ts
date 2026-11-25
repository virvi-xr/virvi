import { compareHudVersions, DCL_HUD_VERSION } from '@virvixr/shared'

/**
 * LIV-13: the line under the HUD's tabs when this scene runs an older @virvixr/dcl than the latest release. The
 * server sends the latest with the member's setup status, so only people who can work on the scene (never visitors)
 * see it, and viewers don't: they can't redeploy. Null when the scene is current, or the server didn't say.
 */
export function hudUpdateNotice(
  status: { role: string; hudLatest?: unknown; virviDeploys?: unknown },
  current: string = DCL_HUD_VERSION,
): string | null {
  if (status.role === 'viewer' || typeof status.hudLatest !== 'string') return null
  if (compareHudVersions(current, status.hudLatest) >= 0) return null
  const lead = `Virvi ${status.hudLatest} is out (this scene runs ${current}).`
  return status.virviDeploys === false
    ? `${lead} Run npm install @virvixr/dcl@latest in the scene's folder and deploy it.`
    : `${lead} Redeploy it from the Virvi dashboard to update.`
}
