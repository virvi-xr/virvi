/** LIV-33 / LIV-13: the scene's Decentraland HUD release, as GET /api/scenes/:id gives it (null until a HUD has called). */
export type DclHudStatus = { version: string | null; latest: string; seenAt: string; behind: boolean } | null | undefined

/** The warning on the scene page when its Decentraland HUD is behind; null when it is current or unknown. */
export function hudBehindNote(s: DclHudStatus): string | null {
  if (!s?.behind) return null
  const running = s.version ? `HUD ${s.version}` : 'an older HUD'
  return `This scene runs ${running} in Decentraland; the latest is ${s.latest}. Redeploy it to give visitors the latest fixes and features.`
}
