/** One row of the HUD's Scene Layout panel. `copies` is how many instances the element has in the scene. */
export type HUDLayoutItem = { id: string; name: string; type: string; enabled: boolean; copies: number }

/**
 * A layout row from a preset element. An element update returns the row without its instances,
 * so the count falls back to the previous row's (LIV-12).
 */
export function toLayoutItem(el: any, previous?: HUDLayoutItem): HUDLayoutItem {
  const copies = Array.isArray(el?.instances) ? el.instances.length : previous?.copies ?? 0
  return { id: el.id, name: el.name, type: el.type, enabled: el.enabled !== false, copies }
}

export function withCopies(list: HUDLayoutItem[], elementId: string, copies: number): HUDLayoutItem[] {
  return list.map((el) => (el.id === elementId ? { ...el, copies } : el))
}

const nameOf = (name: string) => name || 'Unnamed'

/** The confirmation for "remove every copy, keep the element" (the dashboard's Delete all). */
export function clearCopiesPrompt(item: { name: string; copies: number }): string {
  const what = item.copies === 1 ? 'the only copy' : `all ${item.copies} copies`
  return `Remove ${what} of ${nameOf(item.name)}? The element stays. This can't be undone.`
}

export function clearedMessage(name: string, deleted: number): string {
  if (deleted === 0) return `${nameOf(name)} had no copies left`
  return `Removed ${deleted} ${deleted === 1 ? 'copy' : 'copies'} of ${nameOf(name)}`
}
