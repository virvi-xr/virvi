import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { HYPERFY_APP_VERSION, HYPERFY_FEED, compareHudVersions, parseHudVersion, type HyperfyWorldSummary } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'

export type HyperfyWorldRow = typeof hyperfyWorlds.$inferSelect

export function hashWorldKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** A world key: `virviw_` + 32 random bytes as hex. Only the hash is stored; the raw key is shown once. */
export function createWorldKey(): { raw: string; hash: string; prefix: string } {
  const raw = `${HYPERFY_FEED.keyPrefix}${randomBytes(32).toString('hex')}`
  return { raw, hash: hashWorldKey(raw), prefix: raw.slice(0, 12) }
}

export async function findWorldByKey(raw: string): Promise<HyperfyWorldRow | null> {
  if (!raw.startsWith(HYPERFY_FEED.keyPrefix)) return null
  const [row] = await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.keyHash, hashWorldKey(raw)))
  // An ended or failed hosted world no longer serves its feed: a failed one's cleanup may have left its machine
  // running. Self-run worlds are always 'running'.
  return row && row.status !== 'ended' && row.status !== 'failed' ? row : null
}

/** A random 32-byte world secret (hex). A hosted world's server holds it in VIRVI_WORLD_SECRET; only its hash is stored. */
export function createWorldSecret(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex')
  return { raw, hash: hashWorldKey(raw) }
}

/**
 * The live hosted world with this key whose secret this is; null for any other case (unknown key, no secret, wrong
 * secret, another world's secret, ended or failed). The secret is compared in constant time.
 */
export async function findWorldBySecret(worldKey: string, secret: string): Promise<HyperfyWorldRow | null> {
  if (typeof worldKey !== 'string' || typeof secret !== 'string' || !secret) return null
  const row = await findWorldByKey(worldKey)
  if (!row || !row.worldSecretHash) return null
  const a = Buffer.from(row.worldSecretHash), b = Buffer.from(hashWorldKey(secret))
  return a.length === b.length && timingSafeEqual(a, b) ? row : null
}

/**
 * LIV-33: the Virvi app release a world runs, against the one this server serves. Null until the world has polled.
 * An app that sent no version predates numbered releases, so it is behind.
 */
export function hyperfyAppStatus(w: Pick<HyperfyWorldRow, 'appVersion' | 'lastSeenAt'>, latest: string = HYPERFY_APP_VERSION) {
  if (!w.lastSeenAt) return null
  return { version: w.appVersion, latest, behind: compareHudVersions(w.appVersion, latest) < 0 }
}

/** The release to keep for a world: the newest seen wins, so an old copy still running can't mark it behind again. */
export function newerAppVersion(stored: string | null, raw: unknown): string | null {
  const sent = parseHudVersion(raw) ? String(raw).trim() : null
  return compareHudVersions(stored, sent) >= 0 ? stored : sent
}

export function worldSummary(w: HyperfyWorldRow): HyperfyWorldSummary {
  return {
    id: w.id,
    sceneId: w.sceneId,
    name: w.name,
    kind: w.kind === 'hosted' ? 'hosted' : 'self',
    address: w.address,
    status: w.status as HyperfyWorldSummary['status'],
    errorMessage: w.errorMessage,
    keyPrefix: w.keyPrefix,
    createdAt: w.createdAt.toISOString(),
    lastSeenAt: w.lastSeenAt ? w.lastSeenAt.toISOString() : null,
    app: hyperfyAppStatus(w),
    endsAt: w.endsAt ? w.endsAt.toISOString() : null,
    endedAt: w.endedAt ? w.endedAt.toISOString() : null,
    purgeAfter: w.purgeAfter ? w.purgeAfter.toISOString() : null,
  }
}
