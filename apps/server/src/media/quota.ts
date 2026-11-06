import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, mediaAssets, scenes } from '../db/schema.js'
import { config } from '../config.js'
import { getSubscription } from '../integrations/stripe.js'
import { StoreMediaError } from './store.js'

/**
 * Throws StoreMediaError(storage_limit_reached) when ownerId's media, asset-library uploads and scene thumbnails plus
 * addBytes exceed their tier (skipped in self-hosted mode). addBytes may be negative (a smaller replacement).
 */
export async function assertStorageQuota(
  ownerId: string,
  addBytes: number,
  opts: { quotaMessage?: string; quotaStatus?: number } = {},
): Promise<void> {
  if (config.allFeaturesUnlocked) return
  const sub = await getSubscription(ownerId)
  const storageLimit = sub.limits.storageBytes

  const [{ usedBytes: mediaBytes }] = await db
    .select({ usedBytes: sql<number>`coalesce(sum(${mediaAssets.sizeBytes}), 0)::bigint`.mapWith(Number) })
    .from(mediaAssets)
    .where(eq(mediaAssets.ownerId, ownerId))
  const [{ usedBytes: libraryBytes }] = await db
    .select({ usedBytes: sql<number>`coalesce(sum(${assetLibraryItems.fileSizeBytes}), 0)::bigint`.mapWith(Number) })
    .from(assetLibraryItems)
    // Design Studio pieces the person paid for (sourceRef studio:…) don't count against their upload storage
    .where(and(eq(assetLibraryItems.uploadedBy, ownerId), sql`coalesce(${assetLibraryItems.sourceRef}, '') NOT LIKE 'studio:%'`))
  const [{ usedBytes: thumbnailBytes }] = await db
    .select({ usedBytes: sql<number>`coalesce(sum(${scenes.thumbnailBytes}), 0)::bigint`.mapWith(Number) })
    .from(scenes)
    .where(eq(scenes.ownerId, ownerId))
  const usedBytes = mediaBytes + libraryBytes + thumbnailBytes

  if (addBytes > 0 && usedBytes + addBytes > storageLimit) {
    throw new StoreMediaError(opts.quotaStatus ?? 403, {
      error: 'storage_limit_reached',
      message:
        opts.quotaMessage ??
        `Your ${sub.tier} plan allows up to ${Math.round(storageLimit / 1024 / 1024)} MB of storage. This upload would exceed your quota.`,
      currentUsageBytes: usedBytes,
      uploadSizeBytes: addBytes,
      limitBytes: storageLimit,
      tier: sub.tier,
    })
  }
}
