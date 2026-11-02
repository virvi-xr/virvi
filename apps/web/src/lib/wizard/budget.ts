import { dclBudget, plotParcels, type Plot } from '@virvixr/shared'
import type { PlacedItem } from './placement'

export interface BudgetStatus {
  triangles: { used: number; limit: number | null }
  entities: { used: number; limit: number | null }
  bytes: { used: number; remaining: number | null }
  /** What stops the scene: too many items or not enough World storage. */
  over: null | string
  /** More triangles than Decentraland recommends: shown, never a stop (Decentraland doesn't refuse it). */
  warning: null | string
}

const n = (v: number) => Math.round(v).toLocaleString('en-US')
const mb = (v: number) => `${(v / 1_048_576).toFixed(1)} MB`

/** A room set in the scene: one more entity, and its triangles once a preview has counted them. */
export interface RoomBudget { triangles: number | null }

/**
 * Running Decentraland budget for the placed items (and the room set, when there is one).
 * `plot` null means no hard limits (Hyperfy/AR only).
 */
export function budgetStatus(
  items: PlacedItem[],
  plot: Plot | null,
  storage: { maxAllowedBytes: number; usedBytes: number } | null,
  room: RoomBudget | null = null,
): BudgetStatus {
  const budget = plot ? dclBudget(plotParcels(plot).length) : null
  const triUsed = items.reduce((s, i) => s + (i.asset.triangleCount ?? 0), room?.triangles ?? 0)
  const entities = items.length + (room ? 1 : 0)
  const distinct = new Map(items.map((i) => [i.asset.id, i.asset.fileSizeBytes]))
  const bytesUsed = [...distinct.values()].reduce((s, b) => s + b, 0)
  const remaining = storage ? storage.maxAllowedBytes - storage.usedBytes : null

  let over: string | null = null
  if (budget && entities > budget.entities) {
    over = `This plot fits about ${n(budget.entities)} items; that would make it ${n(entities)}`
  } else if (remaining !== null && bytesUsed > remaining) {
    over = `Your World has about ${mb(Math.max(remaining, 0))} of storage left; that would make it ${mb(bytesUsed)}`
  }
  return {
    triangles: { used: triUsed, limit: budget?.triangles ?? null },
    entities: { used: entities, limit: budget?.entities ?? null },
    bytes: { used: bytesUsed, remaining: remaining === null ? null : remaining - bytesUsed },
    over,
    warning: budget && triUsed > budget.triangles
      ? `This scene has ${n(triUsed)} triangles, more than the ${n(budget.triangles)} Decentraland recommends for this plot. It still deploys, but it may run slowly for visitors.`
      : null,
  }
}

/** Drops items from the end until the plot's item limit holds, leaving room for the room set. Triangles never drop one. */
export function fitToBudget(items: PlacedItem[], plot: Plot, room: RoomBudget | null = null): { items: PlacedItem[]; dropped: number } {
  const kept = items.slice(0, Math.max(dclBudget(plotParcels(plot).length).entities - (room ? 1 : 0), 0))
  return { items: kept, dropped: items.length - kept.length }
}
