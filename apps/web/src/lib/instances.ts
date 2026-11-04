import { plural } from './format'

/** The confirmation shown before deleting every instance of one element. */
export function deleteAllInstancesPrompt(count: number): string {
  return `Delete ${count === 1 ? '' : 'all '}${plural(count, 'instance')}? The element stays. This can't be undone.`
}

type WithInstances = { id: string; instances: unknown[] }
type SceneLike<E extends WithInstances> = { presets: { elements: E[] }[] }

/** The scene with one element's instances removed (after DELETE /api/elements/:id/instances), unchanged otherwise. */
export function withoutInstancesOf<E extends WithInstances, S extends SceneLike<E>>(scene: S | null, elementId: string): S | null {
  if (!scene) return scene
  return {
    ...scene,
    presets: scene.presets.map((preset) => ({
      ...preset,
      elements: preset.elements.map((el) => (el.id === elementId ? { ...el, instances: [] } : el)),
    })),
  }
}

/** The confirmation shown before deleting an element, which takes its instances with it. */
export function deleteElementPrompt(name: string, count: number): string {
  return `Delete ${name}${count ? ` and its ${plural(count, 'instance')}` : ''}? This can't be undone.`
}

type SceneOf<E extends { id: string }> = { presets: { elements: E[] }[] }

/** The scene without one element (after DELETE /api/elements/:id), unchanged otherwise. */
export function withoutElement<E extends { id: string }, S extends SceneOf<E>>(scene: S | null, elementId: string): S | null {
  if (!scene) return scene
  return { ...scene, presets: scene.presets.map((preset) => ({ ...preset, elements: preset.elements.filter((el) => el.id !== elementId) })) }
}
