/**
 * A sound's or screen's volume, 0 to 1, as the dashboard stores it (its slider runs 0 to 1, default 1). Older data
 * (v1, the seed) used 0 to 100, so a value above 1 is read as a percentage. Missing or not a number: `fallback`.
 */
export function normalizeVolume(v: unknown, fallback = 1): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const scaled = n > 1 ? n / 100 : n
  return Math.min(1, Math.max(0, scaled))
}
