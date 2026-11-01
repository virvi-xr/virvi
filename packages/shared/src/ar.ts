import type { SerializedScene } from './hyperfy.js'
import type { Vec3 } from './types/math.js'

export type ArMarkerView = {
  id: string
  ringId: number
  code: string
  diameterMm: number
  whereText: string | null
  pose: { x: number; y: number; z: number; headingDeg: number } | null
}

export type ArFloorView = {
  id: string
  name: string
  heightM: number
  sortOrder: number
  markers: ArMarkerView[]
}

export type ArSpaceView = {
  id: string
  sceneId: string
  name: string
  place: string | null
  lat: number | null
  lng: number | null
  published: boolean
  floors: ArFloorView[]
}

export const AR_FEED = { version: 1, holdMs: 25_000 } as const

/** The space as the headset gets it: the scene it belongs to is the feed's business, not the app's. */
export type ArSpaceWire = Omit<ArSpaceView, 'sceneId'>

export type ArFeedResponse = { v: 1; version: string; space: ArSpaceWire; scene: SerializedScene | null }

/** A scene's draft, keyed by scene: what a headset builder polls. `version` is the SHA-256 of `{ scene }`. */
export type ArSceneFeedResponse = { v: 1; version: string; scene: SerializedScene | null }

export type ArMarkerLookup = { spaceId: string; floorId: string; markerId: string; spaceName: string; whereText: string | null }

/**
 * Headset pairing: the headset shows a code, a Virvi user approves it on the website as a personal headset (theirs,
 * stays paired while it is used) or a shared one (a venue's, one session). Codes use HYPERFY_PAIRING's alphabet and
 * length, and normalizePairingCode.
 */
export const AR_PAIRING = {
  /** How long a pairing code stays approvable and claimable, in ms. */
  codeTtlMs: 10 * 60_000,
  /** A personal headset stays paired this long after its last pass, in ms (90 days). */
  personalIdleTtlMs: 90 * 86_400_000,
  /** A shared headset's session lasts at most this long after it is claimed, in ms (12 h). */
  sharedSessionTtlMs: 12 * 3_600_000,
} as const

export type ArDeviceKind = 'personal' | 'shared'
export type ArDeviceStatus = 'pending' | 'approved' | 'refused' | 'claimed' | 'revoked'

/** POST /api/ar/pair */
export type ArPairStartResponse = { code: string; approveUrl: string; codeExpiresAt: string }
/** GET /api/ar/pair/:code (what the approval page shows) */
export type ArPairApprovalInfo = { deviceName: string | null; codeExpiresAt: string }
/** POST /api/ar/pair/:code/claim */
export type ArPairClaimResponse =
  | { status: 'pending' }
  | { status: 'approved'; deviceId: string; kind: ArDeviceKind; expiresAt: string }
  | { status: 'refused' }
/** POST /api/ar/devices/:id/pass */
export type ArPassResponse = { pass: string; passExpiresAt: string; sceneId: string }
/**
 * POST /api/ar/devices/:id/spaces: one entry of the headset's "pick a space" list. The ring codes let the headset
 * match a ring it sees to its space (and mint for that space's scene), published or not.
 */
export type ArDeviceSpace = {
  spaceId: string
  spaceName: string
  sceneId: string
  sceneName: string
  markers: Array<{ markerId: string; floorId: string; code: string }>
}
/** POST /api/ar/devices/:id/scenes: one scene a personal headset can build on, with or without a space. */
export type ArDeviceScene = { sceneId: string; sceneName: string; role: 'host' | 'cohost' | 'editor' | 'viewer' }
/** GET /api/ar/devices */
export type ArDeviceSummary = { id: string; deviceName: string | null; kind: ArDeviceKind | null; status: ArDeviceStatus; lastUsedAt: string | null; expiresAt: string | null }

/** A per-space tweak to one scene instance: position offset in metres, rotation offset in degrees, scale multipliers. */
export type Adjustment = { dPosition: Vec3; dRotation: Vec3; scaleFactor: Vec3 }
