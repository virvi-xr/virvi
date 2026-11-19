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
