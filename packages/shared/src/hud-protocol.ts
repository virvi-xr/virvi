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
