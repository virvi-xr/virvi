/**
 * Decentraland Signed Fetch Verification (@dcl/crypto-middleware 6.x)
 *
 * Verifies that platform auth requests from Decentraland are cryptographically
 * signed by the player's wallet. Uses the AuthChain pattern:
 *
 * 1. SIGNER — identifies the Ethereum wallet address
 * 2. ECDSA_EPHEMERAL — wallet delegates to an ephemeral key (login proof)
 * 3. ECDSA_SIGNED_ENTITY — ephemeral key signs the specific request
 *
 * Headers sent by DCL's signedFetch:
 *   X-Identity-Auth-Chain-0, X-Identity-Auth-Chain-1, X-Identity-Auth-Chain-2
 *   X-Identity-Timestamp
 *   X-Identity-Metadata
 */

import { createHash } from 'node:crypto'
import { verify, requireSigner } from '@dcl/crypto-middleware'

const SCENE_SIGNER = 'decentraland-kernel-scene'
// Metadata keys we authorize on. Declaring them also lets requests from explorers that still sign
// the pre-6.0.0 (fully lowercased) payload through, but only when none of these keys is respelled.
const CANONICAL_KEYS = ['signer', 'sceneId', 'parcel', 'realm.serverName', 'realm.hostname', 'isGuest', 'hashPayload']
const EXPIRATION_MS = 120_000 // 2 minutes, generous for slow connections

type Headers = Record<string, string | string[] | undefined>

export interface DclAuthResult {
  /** Lowercase Ethereum address of the verified wallet */
  walletAddress: string
  /** Metadata sent with the signed request */
  metadata: Record<string, any>
}

/** What the signed metadata proves about the scene a request came from. */
export interface SceneRequestContext {
  sceneId: string
  parcel: string
  realm: { hostname: string; serverName: string }
  isGuest: boolean
}

const own = (o: unknown, k: string) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)
const str = (o: any, k: string) => (own(o, k) && typeof o[k] === 'string' && o[k].length > 0 ? (o[k] as string) : null)

/**
 * Verify any Decentraland signed fetch (scene or not). Used by setup, ingest and claims.
 * @throws Error if verification fails
 */
export async function verifyDclSignedFetch(method: string, path: string, headers: Headers): Promise<DclAuthResult> {
  const r = await verify(method, path, headers, { expiration: EXPIRATION_MS, canonicalMetadataKeys: CANONICAL_KEYS })
  return { walletAddress: r.auth.toLowerCase(), metadata: r.authMetadata || {} }
}

/**
 * Verify a request the explorer signed on a scene's behalf (ADR-289) and return its scene context.
 * Throws on anything else: bad signature, missing/respelled/foreign signer, incomplete scene
 * metadata, or a body that does not match the signed hashPayload.
 *
 * The web explorer signs the request but sends no hashPayload. With `allowUnsignedBody` such a
 * request is accepted with `bodySigned: false`, and the caller must not trust the body; a
 * hashPayload that is present still has to match.
 */
export async function verifyDclSceneRequest(
  method: string,
  path: string,
  headers: Headers,
  rawBody: string | null,
  opts: { allowUnsignedBody?: boolean } = {},
): Promise<{ wallet: string; scene: SceneRequestContext; bodySigned: boolean }> {
  const r = await verify(method, path, headers, {
    expiration: EXPIRATION_MS,
    canonicalMetadataKeys: CANONICAL_KEYS,
    metadataValidator: requireSigner(SCENE_SIGNER),
  })
  const m = r.authMetadata as Record<string, unknown>
  const sceneId = str(m, 'sceneId')
  const parcel = str(m, 'parcel')
  const realm = own(m, 'realm') ? (m.realm as Record<string, unknown>) : null
  const serverName = str(realm, 'serverName')
  const hostname = str(realm, 'hostname') ?? ''
  if (!sceneId || !parcel || !serverName) throw new Error('scene metadata incomplete')
  let bodySigned = true
  if (rawBody !== null && rawBody.length > 0) {
    const signed = str(m, 'hashPayload')
    if (signed === null && opts.allowUnsignedBody) bodySigned = false
    else if (signed !== createHash('sha256').update(rawBody, 'utf8').digest('hex')) {
      throw new Error(`body does not match signed hash (${signed ? 'hashPayload differs' : 'no hashPayload'})`)
    }
  }
  return {
    bodySigned,
    wallet: r.auth.toLowerCase(),
    scene: { sceneId, parcel, realm: { hostname, serverName }, isGuest: own(m, 'isGuest') && m.isGuest === true },
  }
}

/**
 * Check if a request has DCL auth chain headers.
 * Useful for determining which auth method to use.
 */
export function hasDclAuthHeaders(headers: Headers): boolean {
  return !!headers['x-identity-auth-chain-0']
}
