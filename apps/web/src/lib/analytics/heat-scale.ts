// The heat ramp shared by every heatmap view: the metric and its 6 colour steps (kept apart from heat.ts so the
// Here-now map doesn't load the 3D helpers).
export type HeatMetric = 'dwell' | 'visits'
export const HEAT_STEPS = 6

export const cellValue = (c: { dwellSec: number; visits: number }, metric: HeatMetric) => (metric === 'dwell' ? c.dwellSec : c.visits)

/** Quantise v against max into 0..5 (6 sequential steps); v <= 0 is not drawn. */
export const colourStep = (v: number, max: number) => Math.min(HEAT_STEPS - 1, Math.floor((v / max) * HEAT_STEPS))

/** The largest f(item) (0 for none), in a loop: heatmaps can have more cells than a call can take as arguments. */
export function maxOf<T>(items: readonly T[], f: (t: T) => number): number {
  let m = 0
  for (const t of items) {
    const v = f(t)
    if (v > m) m = v
  }
  return m
}
