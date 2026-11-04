import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { instanceBranding } from '../db/schema.js'
import { createStorage, type StorageProvider } from '../storage/index.js'
import { cleanBrandName, processFavicon, processLogo } from './images.js'

const ROW = 'default'

export interface Branding { name: string | null; logoUrl: string | null; faviconUrl: string | null }
export const NO_BRANDING: Branding = { name: null, logoUrl: null, faviconUrl: null }

let storageOverride: StorageProvider | null = null
let defaultStorage: StorageProvider | null = null
/** Tests swap in a memory store; null restores the configured one. */
export function setBrandingStorage(s: StorageProvider | null): void {
  storageOverride = s
}
const storage = () => storageOverride ?? (defaultStorage ??= createStorage())

export async function getBranding(): Promise<Branding> {
  const row = await db.query.instanceBranding.findFirst({ where: eq(instanceBranding.id, ROW) })
  if (!row) return NO_BRANDING
  return { name: row.name, logoUrl: row.logoUrl, faviconUrl: row.faviconUrl }
}

/** undefined keeps a field, null clears it, a value replaces it. Images arrive as raw bytes. */
export interface BrandingUpdate { name?: unknown; logo?: Buffer | null; favicon?: Buffer | null }

/**
 * Validates everything before writing anything, so a bad file leaves the branding as it was. Replaced or cleared
 * files are deleted from storage once the row points elsewhere.
 */
export async function updateBranding(update: BrandingUpdate, userId: string): Promise<Branding> {
  const name = update.name === undefined ? undefined : cleanBrandName(update.name)
  const logo = update.logo ? await processLogo(update.logo) : update.logo
  const favicon = update.favicon ? await processFavicon(update.favicon) : update.favicon

  const current = await db.query.instanceBranding.findFirst({ where: eq(instanceBranding.id, ROW) })
  const next = {
    name: name === undefined ? current?.name ?? null : name,
    logoKey: current?.logoKey ?? null, logoUrl: current?.logoUrl ?? null,
    faviconKey: current?.faviconKey ?? null, faviconUrl: current?.faviconUrl ?? null,
  }
  const stale: string[] = []
  if (logo !== undefined) {
    if (next.logoKey) stale.push(next.logoKey)
    next.logoKey = logo ? `branding/logo-${randomUUID()}.png` : null
    next.logoUrl = logo ? await storage().upload(next.logoKey!, logo, 'image/png') : null
  }
  if (favicon !== undefined) {
    if (next.faviconKey) stale.push(next.faviconKey)
    next.faviconKey = favicon ? `branding/favicon-${randomUUID()}.png` : null
    next.faviconUrl = favicon ? await storage().upload(next.faviconKey!, favicon, 'image/png') : null
  }
  await db.insert(instanceBranding)
    .values({ id: ROW, ...next, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: instanceBranding.id, set: { ...next, updatedBy: userId, updatedAt: new Date() } })
  await removeFiles(stale)
  return { name: next.name, logoUrl: next.logoUrl, faviconUrl: next.faviconUrl }
}

/** Back to the plain Virvi look. */
export async function resetBranding(): Promise<void> {
  const [row] = await db.delete(instanceBranding).where(eq(instanceBranding.id, ROW)).returning()
  if (row) await removeFiles([row.logoKey, row.faviconKey].filter((k): k is string => !!k))
}

async function removeFiles(keys: string[]) {
  for (const key of keys) {
    try { await storage().delete(key) } catch (err) { console.warn(`[branding] could not delete ${key}:`, err) }
  }
}
