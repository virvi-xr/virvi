/**
 * The HUD's Presets section (LIV-84): which presets the scene has, which one is live, and wording. Pure (no
 * @dcl/sdk), so it is unit-tested. Mirrors the dashboard (apps/web src/lib/presets.ts).
 */
import { friendlyEditError } from './edit-errors.js'

export const PRESET_NAME_MAX = 60

export interface HUDPreset { id: string; name: string }

export function presetsFromScene(scene: { activePresetId?: string | null; presets?: { id: string; name: string }[] }): { activeId: string | null; list: HUDPreset[] } {
  return { activeId: scene.activePresetId ?? null, list: (scene.presets ?? []).map((p) => ({ id: p.id, name: p.name })) }
}

export type PresetsChange =
  | { action: 'upsert'; preset: { id: string; name: string } }
  | { action: 'delete'; presetId: string }

/** A preset created, renamed or deleted elsewhere (the scene room's `scene_presets_changed`). */
export function applyPresetsChange(list: HUDPreset[], change: PresetsChange): HUDPreset[] {
  if (change?.action === 'delete') return list.filter((p) => p.id !== change.presetId)
  if (change?.action !== 'upsert' || !change.preset?.id) return list
  const { id, name } = change.preset
  return list.some((p) => p.id === id) ? list.map((p) => (p.id === id ? { id, name } : p)) : [...list, { id, name }]
}

/** "Copy of Concert", or "Copy of Concert (2)" when that's taken; never over the name limit. */
export function copyName(name: string, taken: string[]): string {
  const base = `Copy of ${name}`.slice(0, PRESET_NAME_MAX - 5)
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base} (${n})`)) return `${base} (${n})`
}

/** Booking copies are named `booking:<id>` on the server. */
export const presetLabel = (name: string) => (name.startsWith('booking:') ? 'Booking copy' : name)

/** The server's own message for a refused preset change (e.g. a bad name), else the usual edit wording. */
export function friendlyPresetError(err: unknown, opts: { connected?: boolean } = {}): string {
  const m = /^HTTP (400|409): (.*)$/s.exec(err instanceof Error ? err.message : String(err))
  if (m) {
    try {
      const body = JSON.parse(m[2])
      if (typeof body?.message === 'string' && body.message) return body.message
    } catch { /* not JSON */ }
  }
  return friendlyEditError(err, opts)
}
