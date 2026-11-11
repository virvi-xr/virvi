/**
 * Heatmap height (LIV-85). The daily heatmap stores each 1 m x/z cell per floor band: `floor((feet + slack) / band)`,
 * where `feet` is the visitor's feet height. Platforms report different points of the visitor:
 * - Decentraland (`parcels`, `world`, `preview`): the player's Transform, about 0.9 m above the feet
 *   (the same offset the DCL adapter uses to place things at the player's feet).
 * - Hyperfy: the player's position, at the feet (the Hyperfy HUD uses it as the floor height).
 * - AR (Quest): the headset, about 1.5 m above the floor for a standing or seated visitor.
 * The slack puts the band edges 0.4 m below each nominal floor, so a visitor standing on the ground (or a little
 * below it, or jumping) stays in band 0 and one on a floor 3 m up lands in band 1. Heights are rounded to the
 * centimetre first, as the rollup SQL does, so both agree at the edges.
 */
export const HEATMAP_BAND_M = 2
export const HEATMAP_BAND_SLACK_M = 0.4

export type HeatmapLocationKind = 'parcels' | 'world' | 'preview' | 'hyperfy' | 'ar'

/** How far above the feet each platform's reported y is. */
export const HEATMAP_FEET_OFFSET_M: Record<HeatmapLocationKind, number> = {
  parcels: 0.9,
  world: 0.9,
  preview: 0.9,
  hyperfy: 0,
  ar: 1.5,
}

/** Decentraland has nothing below the ground, so its bands start at 0 (a sample under it counts as ground level). */
export function groundClamped(kind: string): boolean {
  return kind === 'parcels' || kind === 'world' || kind === 'preview'
}

export function feetOffsetM(kind: string): number {
  return HEATMAP_FEET_OFFSET_M[kind as HeatmapLocationKind] ?? 0
}

/** The visitor's feet height from a reported y. */
export function feetHeight(y: number, kind: string): number {
  return y - feetOffsetM(kind)
}

/** The floor band a reported y falls in (band 0 is the ground floor). */
export function heightBand(y: number, kind: string): number {
  const cm = Math.round((y - feetOffsetM(kind) + HEATMAP_BAND_SLACK_M) * 100)
  const band = Math.floor(cm / (HEATMAP_BAND_M * 100))
  return groundClamped(kind) ? Math.max(0, band) : band
}

/** The feet heights a band covers, [from, to). */
export function bandRangeM(band: number): { from: number; to: number } {
  const from = Math.round((band * HEATMAP_BAND_M - HEATMAP_BAND_SLACK_M) * 100) / 100
  return { from, to: Math.round((from + HEATMAP_BAND_M) * 100) / 100 }
}
