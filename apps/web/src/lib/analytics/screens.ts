/** Screens on the analytics page (LIV-38): each video screen's plays and watch time, most watched first. */
export interface ScreenRow { name: string; plays: number; watchSec: number; avgSec: number }

export function screenRows(videos: Record<string, { plays: number; watchSec: number }> | undefined, top = 8): ScreenRow[] {
  return Object.entries(videos ?? {})
    .filter(([, v]) => v.plays > 0 || v.watchSec > 0)
    .map(([name, v]) => ({ name, plays: v.plays, watchSec: v.watchSec, avgSec: v.plays ? Math.round(v.watchSec / v.plays) : 0 }))
    .sort((a, b) => b.watchSec - a.watchSec || b.plays - a.plays || a.name.localeCompare(b.name))
    .slice(0, top)
}
