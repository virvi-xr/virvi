/**
 * The edit protocol a HUD speaks, sent with every API request so the server can refuse edits from a HUD
 * too old to make them safely (LIV-23). A request without the header counts as protocol 0: every
 * Decentraland HUD deployed before this header existed.
 */
export const HUD_PROTOCOL_HEADER = 'x-virvi-hud-protocol'

/** The Decentraland HUD's edit protocol. Raise it when a HUD change must reach the server with its edits. */
export const DCL_HUD_PROTOCOL = 1

/** The error code of the server's 426 for a HUD below the minimum: the scene needs a redeploy. */
export const REDEPLOY_REQUIRED = 'redeploy_required'

/**
 * The HUD's release, sent as x-virvi-hud-version with every API request, so the server can tell a scene running an old
 * HUD to redeploy (LIV-33, LIV-13). Kept equal to @virvixr/dcl's version: raise both together at each release (a
 * test checks they match). A request without the header is from a HUD released before 2.14.0.
 */
export const HUD_VERSION_HEADER = 'x-virvi-hud-version'
export const DCL_HUD_VERSION = '2.15.0'

/** "2.13.0" → [2, 13, 0]; null for anything that isn't three whole numbers. */
export function parseHudVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Negative when a is older than b, 0 when equal, positive when newer. Unparseable versions count as oldest. */
export function compareHudVersions(a: string | null | undefined, b: string | null | undefined): number {
  const x = parseHudVersion(a) ?? [-1, -1, -1]
  const y = parseHudVersion(b) ?? [-1, -1, -1]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
