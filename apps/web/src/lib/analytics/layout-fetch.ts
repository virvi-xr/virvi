import type { LayoutItem } from './types'

/**
 * The linked scene's layout for the heatmap (LIV-85). It only adds detail, so any failure means "no layout" and the
 * map shows just the parcels: a 404 from a server without the route must not read as "no access" to the dashboard.
 */
export async function loadLayout(get: () => Promise<{ layout: { items: LayoutItem[] } | null }>): Promise<LayoutItem[] | null> {
  try {
    return (await get()).layout?.items ?? null
  } catch {
    return null
  }
}
