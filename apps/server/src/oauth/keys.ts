import { createHash, randomBytes } from 'node:crypto'
import { db } from '../db/connection.js'
import { apiKeys } from '../db/schema.js'

/** The scopes a key carries (LIV-170): read-only and/or scene limits; null acts as the account (keys before scopes). */
export function keyScopes(access: 'read' | 'full', sceneIds: string[]): string[] | null {
  return access === 'read' || sceneIds.length ? [...(access === 'read' ? ['read'] : ['full']), ...sceneIds.map((id) => `scene:${id}`)] : null
}

/**
 * Mints an API key: `virvi_k1_` + 32 random hex characters, stored only as its SHA-256 hash. The prefix kept for
 * display is 12 characters, enough to tell keys apart (the first 8 are the same for every key).
 */
export async function issueApiKey(o: {
  userId: string; orgId: string | null; name: string; access: 'read' | 'full'; sceneIds: string[]; expiresAt: Date | null; oauthClientId?: string | null
}) {
  const rawKey = `virvi_k1_${randomBytes(16).toString('hex')}`
  const [apiKey] = await db.insert(apiKeys).values({
    userId: o.userId,
    orgId: o.orgId,
    name: o.name,
    keyHash: createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 12),
    scopes: keyScopes(o.access, o.sceneIds),
    expiresAt: o.expiresAt,
    oauthClientId: o.oauthClientId ?? null,
  }).returning()
  return { apiKey, rawKey }
}
