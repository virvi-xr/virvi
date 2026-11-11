// Small pure helpers for the wizard page's steps.
import type { Plot } from '@virvixr/shared'
import type { WizardAsset } from '../api'

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * A row from GET /api/assets as a wizard asset, or null when the wizard can't place it: not a public
 * catalog model, no model URL, or no triangle count (the server refuses those, like the catalog does).
 */
export function toWizardAsset(row: Record<string, any>): WizardAsset | null {
  if (!row || typeof row.id !== 'string' || !row.isPublic || !row.packId || !row.cdnUrl || !isNum(row.triangleCount)) return null
  const d = row.dimensions as Record<string, unknown> | null
  const [x, y, z] = d ? [d.width ?? d.x, d.height ?? d.y, d.depth ?? d.z] : []
  return {
    id: row.id,
    name: String(row.name ?? 'Model'),
    thumbnailUrl: row.thumbnailUrl ?? null,
    cdnUrl: row.cdnUrl,
    dimensions: isNum(x) && isNum(y) && isNum(z) ? { x, y, z } : null,
    triangleCount: row.triangleCount,
    fileSizeBytes: isNum(row.fileSizeBytes) ? row.fileSizeBytes : 0,
  }
}

/** What someone typed as a World: lowercased, and a bare NAME gets `.dcl.eth`. */
export function normalizeWorldName(raw: string): string {
  const w = raw.trim().toLowerCase()
  if (!w) return ''
  return w.endsWith('.eth') ? w : `${w}.dcl.eth`
}

export const plotLabel = (p: Pick<Plot, 'width' | 'depth'>) => `${p.width}×${p.depth} ${p.width * p.depth === 1 ? 'parcel' : 'parcels'}`

export const mb = (bytes: number) => {
  const v = bytes / 1_048_576
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} MB`
}

/** "uses about X MB of your Y MB left", from the World's storage and this scene's bytes. */
export function storageLine(usedByScene: number, storage: { maxAllowedBytes: number; usedBytes: number }): string {
  const left = Math.max(storage.maxAllowedBytes - storage.usedBytes, 0)
  return `This scene uses about ${mb(usedByScene)} of your ${mb(left)} left.`
}

export const PLOT_CHOICES = [1, 2, 3] as const
export const MAX_PLOT_SIDE = 10

/** Custom sides are whole parcels from 1 to 10. */
export function clampSide(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_PLOT_SIDE, Math.max(1, Math.round(n))) : 1
}

export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

export type HostingChoice = 'available' | 'needs_account' | 'used_up' | 'unavailable' | 'loading'

/**
 * Whether "Hosted by Virvi" can be picked for a Hyperfy world. Hosting is account-only: a trial always needs an account,
 * whatever GET /api/hyperfy/slots says (it reports the free tier's slots to trials).
 */
export function hostingChoice(trial: boolean, slots: { used: number; limit: number | null; hostingAvailable: boolean } | null): HostingChoice {
  if (trial) return 'needs_account'
  if (!slots) return 'loading'
  if (!slots.hostingAvailable) return 'unavailable'
  return slots.limit === null || slots.used < slots.limit ? 'available' : 'used_up'
}
