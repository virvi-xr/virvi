/** Scene presets in the editor (LIV-84): which one is being edited, and keeping the list current. */

export const PRESET_NAME_MAX = 60

interface PresetLike { id: string; name: string; elements: unknown[] }
interface SceneLike<P extends PresetLike> { activePresetId?: string | null; presets: P[] }

/** The preset the editor shows: the one chosen, else the live one. The first only when there's no live preset. */
export function editingPreset<P extends PresetLike>(scene: SceneLike<P> | null | undefined, chosenId: string | null): P | undefined {
  if (!scene) return undefined
  return scene.presets.find((p) => p.id === chosenId)
    ?? scene.presets.find((p) => p.id === scene.activePresetId)
    ?? scene.presets[0]
}

/** "Copy of Concert", or "Copy of Concert (2)" when that's taken; never over the name limit. */
export function copyName(name: string, taken: string[]): string {
  const base = `Copy of ${name}`.slice(0, PRESET_NAME_MAX - 5)
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    const next = `${base} (${n})`
    if (!taken.includes(next)) return next
  }
}

/** Booking copies are named `booking:<id>` on the server. */
export function presetDisplayName(name: string): string {
  return name.startsWith('booking:') ? 'Booking copy' : name
}

export type PresetsChange =
  | { action: 'upsert'; preset: { id: string; name: string } }
  | { action: 'delete'; presetId: string }

/** Apply a create/rename/delete from the scene room or a local action. New presets start with no elements loaded. */
export function applyPresetsChange<S extends SceneLike<PresetLike>>(scene: S, change: PresetsChange): S {
  if (change.action === 'delete') return { ...scene, presets: scene.presets.filter((p) => p.id !== change.presetId) }
  const { id, name } = change.preset
  if (scene.presets.some((p) => p.id === id)) {
    return { ...scene, presets: scene.presets.map((p) => (p.id === id ? { ...p, name } : p)) }
  }
  return { ...scene, presets: [...scene.presets, { id, name, elements: [] }] }
}
