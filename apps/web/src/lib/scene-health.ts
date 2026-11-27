/** A scene's performance budget (LIV-41): what /api/scenes/:id/health returns, and how the panel words it. */

export type BudgetState = 'within' | 'close' | 'over'
export interface BudgetMetric { key: 'triangles' | 'entities' | 'bytes' | 'textures'; used: number; limit: number | null; state: BudgetState; blocks: boolean }
export interface BudgetContributor { elementId: string; name: string; copies: number; triangles: number | null; bytes: number | null; textureBytes: number | null; maxTexturePx: number | null }
export interface BudgetTarget { id: string | null; name: string; kind: 'world' | 'parcels' | 'none'; parcels: number; state: BudgetState; metrics: BudgetMetric[] }
export interface SceneHealth { state: BudgetState; targets: BudgetTarget[]; byTriangles: BudgetContributor[]; bySize: BudgetContributor[]; unmeasured: number; measuring: number; textureMemory: { bytes: number; textures: number }; byTextureMemory: BudgetContributor[]; frames: number; suggestions: string[] }

export const METRIC_LABEL: Record<BudgetMetric['key'], string> = { triangles: 'Triangles', entities: 'Entities', bytes: 'File size', textures: 'Textures' }
export const STATE_LABEL: Record<BudgetState, string> = { within: 'Within budget', close: 'Close to the limit', over: 'Over the limit' }

const MB = 1024 * 1024
export const formatBytes = (n: number) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** "12,000 of 10,000", "3.0 MB" (no limit), for one metric. */
export function metricLine(m: BudgetMetric): string {
  const f = (n: number) => (m.key === 'bytes' ? formatBytes(n) : n.toLocaleString('en-US'))
  return m.limit === null ? f(m.used) : `${f(m.used)} of ${f(m.limit)}`
}

/** How full, 0–100, for the bar (capped at 100). */
export const fill = (m: BudgetMetric) => (m.limit ? Math.min(100, Math.round((m.used / m.limit) * 100)) : 0)

/** What going over means for this metric. */
export function overNote(m: BudgetMetric): string | null {
  if (m.state !== 'over') return null
  return m.blocks ? "Over this, Decentraland won't take the deploy." : 'It still deploys, but may run slowly for visitors.'
}

/** Where the budget applies, in words. */
export function targetLabel(t: BudgetTarget): string {
  const parcels = `${t.parcels} ${t.parcels === 1 ? 'parcel' : 'parcels'}`
  if (t.kind === 'none') return "Not set up to deploy yet: shown for one parcel"
  return t.kind === 'world' ? `${t.name} (World, ${parcels})` : `${t.name} (Genesis City, ${parcels})`
}

/** "Textures use about 48.0 MB of graphics memory (3 textures)." */
export function textureMemoryLine(t: SceneHealth['textureMemory']): string | null {
  if (!t.textures) return null
  return `Textures use about ${formatBytes(t.bytes)} of graphics memory (${t.textures} ${t.textures === 1 ? 'texture' : 'textures'}).`
}
