import type { SceneLibraryChangeData, SceneLibraryItemData } from '@virvixr/shared'

/** What the HUD's 3D Models panel (the scene's library) shows for an item. */
export type HUDMediaStatus = 'uploading' | 'processing' | 'available' | 'needs_sync' | 'failed'

/**
 * A library item's HUD status. A ready model needs sync only when it's placed but its file isn't deployed with
 * the scene (its url is among `missingSrcs`, see Virvi.missingModelSrcs); `virvi-dcl sync` only fetches placed models.
 */
export function hudStatus(item: SceneLibraryItemData, isModel: boolean, missingSrcs: ReadonlySet<string>): HUDMediaStatus {
  if (item.status !== 'ready') return item.status
  return isModel && missingSrcs.has(item.url) ? 'needs_sync' : 'available'
}

/** Apply a live change: a new item goes first (newest first, like the server), a known one is replaced in place. */
export function applyLibraryChange(items: SceneLibraryItemData[], change: SceneLibraryChangeData): SceneLibraryItemData[] {
  if (change.action === 'remove') return items.filter((i) => i.id !== change.id)
  const at = items.findIndex((i) => i.id === change.item.id)
  if (at === -1) return [change.item, ...items]
  return items.map((i, k) => (k === at ? change.item : i))
}
