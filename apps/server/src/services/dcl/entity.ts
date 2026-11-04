/**
 * Decentraland scene entities, auth chains and Virvi's own deploy signer.
 *
 * Entities are built exactly as `sdk-commands deploy` does (dcl-catalyst-client's
 * DeploymentBuilder, ADR-32 CIDv1 hashes via @dcl/hashing); the entity id is the hash of the
 * entity file, and the deployer signs that id with an ephemeral key (ADR-44 style auth chain).
 */
import { Authenticator, type AuthChain } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { createPayload } from '@dcl/crypto-middleware'
// @dcl/hashing is CommonJS that Node's ESM loader can't read named exports from: import the default.
import hashing from '@dcl/hashing'
import { DeploymentBuilder } from 'dcl-catalyst-client'
import { Wallet } from 'ethers'
import { config } from '../../config.js'

const { hashV1 } = hashing

export type { AuthChain }

export interface ContentRef {
  file: string
  hash: string
}

export interface SceneMetadata {
  display: { title: string; [k: string]: unknown }
  scene: { parcels: string[]; base: string }
  main: string
  ecs7: boolean
  runtimeVersion: string
  /** Worlds only: a Genesis City parcel scene has none. */
  worldConfiguration?: { name: string; [k: string]: unknown }
  spawnPoints: unknown[]
  /** Virvi runtime config read by the generic scene bundle. */
  virvi?: { runtime: number; apiUrl: string; wssUrl: string }
  [k: string]: unknown
}

/** The content server's file hash: CIDv1 (ADR-32). */
export function dclHash(bytes: Uint8Array): Promise<string> {
  return hashV1(bytes)
}

/**
 * Builds a scene entity. `existing` files are already in the content store (referenced by hash);
 * `newFiles` (path to bytes) are hashed here and returned for upload. `files` holds the entity
 * file plus the new files only, keyed by hash. Order of inputs never changes the entity id.
 */
export async function buildEntity(input: {
  pointers: string[]
  metadata: SceneMetadata
  existing: ContentRef[]
  newFiles: Map<string, Uint8Array>
  timestamp: number
}): Promise<{ entityId: string; files: Map<string, Uint8Array> }> {
  const hashesByKey = new Map<string, string>()
  for (const { file, hash } of [...input.existing].sort((a, b) => a.file.localeCompare(b.file))) {
    hashesByKey.set(file, hash)
  }
  const uploads = new Map<string, Uint8Array>()
  for (const file of [...input.newFiles.keys()].sort()) {
    if (hashesByKey.has(file)) throw new Error(`New file ${file} collides with an existing file`)
    const bytes = input.newFiles.get(file)!
    const hash = await dclHash(bytes)
    hashesByKey.set(file, hash)
    uploads.set(hash, bytes)
  }

  // Same builder `sdk-commands deploy` uses. (buildEntityWithoutNewFiles is not exported by
  // dcl-catalyst-client's public entry; buildEntityAndFile takes the content mapping directly.)
  const { entity, entityFile } = await DeploymentBuilder.buildEntityAndFile({
    type: 'scene' as never, // EntityType.SCENE; @dcl/schemas is not a direct dependency
    pointers: input.pointers,
    timestamp: input.timestamp,
    content: [...hashesByKey].map(([file, hash]) => ({ file, hash })),
    metadata: input.metadata,
  })
  const files = new Map<string, Uint8Array>(uploads)
  files.set(entity.id, entityFile)
  return { entityId: entity.id, files }
}

/**
 * The payload a signed fetch (ADR-44) signs: `method:path:timestamp:metadata`, method/path/
 * timestamp lowercased, metadata verbatim (the 6.x format).
 *
 * Confirmed against the verifier the Worlds server uses: decentraland/worlds-content-server
 * src/controllers/routes.ts builds its signed-fetch middleware with `wellKnownComponents` from
 * @dcl/crypto-middleware (strict, current format only for the routes Virvi calls), and
 * @dcl/crypto-middleware 6.3.0 `createPayload` (dist/verify.js) is what it checks. This delegates
 * to that same function so the two cannot drift.
 */
export function signedFetchPayload(method: string, path: string, timestamp: number, metadata: string): string {
  return createPayload(method, path, String(timestamp), metadata)
}

/** Lowercased root signer (the SIGNER link) of an auth chain, or null if there is none. */
export function chainSigner(chain: AuthChain): string | null {
  const root = chain[0]
  if (!root || root.type !== 'SIGNER' || !root.payload) return null
  return root.payload.toLowerCase()
}

/** True when `chain` is a valid, unexpired signature over `payload` rooted at `expectedSigner`. */
export async function verifyChain(chain: AuthChain, payload: string, expectedSigner: string): Promise<boolean> {
  if (chainSigner(chain) !== expectedSigner.toLowerCase()) return false
  try {
    const result = await Authenticator.validateSignature(payload, chain, null)
    return result.ok
  } catch {
    return false
  }
}

/**
 * Virvi's own deploy wallet, from VIRVI_DCL_DEPLOY_KEY; null when unset. Like `sdk-commands
 * deploy`, the wallet signs once to authorise a 10-minute ephemeral key, which signs the payload.
 */
export function virviSigner(): { address: string; signChain(payload: string): Promise<AuthChain> } | null {
  const key = config.virviDclDeployKey
  if (!key) return null
  const wallet = new Wallet(key)
  const address = wallet.address.toLowerCase()
  return {
    address,
    async signChain(payload: string) {
      const identity = await Authenticator.initializeAuthChain(
        address, createUnsafeIdentity(), 10, (message) => wallet.signMessage(message),
      )
      return Authenticator.signPayload(identity, payload)
    },
  }
}
