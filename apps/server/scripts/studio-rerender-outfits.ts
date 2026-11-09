/**
 * LIV-143, run once after the studio worker image with per-body-shape outfits is live: drops the emote views and
 * queues the latest revisions' outfit views again, for renders whose job was made before <cutoff> (when that image
 * went live). --dry-run only counts them.
 *
 *   DATABASE_URL=... pnpm exec tsx scripts/studio-rerender-outfits.ts --before 2026-11-09T12:00:00Z [--dry-run]
 */
import { rerenderOutfitViews } from '../src/studio/rerender-outfits.js'

const args = process.argv.slice(2)
const at = args.indexOf('--before')
const before = at >= 0 ? new Date(args[at + 1]) : null
if (!before || Number.isNaN(before.getTime())) {
  console.error('usage: studio-rerender-outfits.ts --before <ISO time the new worker image went live> [--dry-run]')
  process.exit(2)
}
const dryRun = args.includes('--dry-run')
const counts = await rerenderOutfitViews(new Date(), { before, dryRun })
console.log(JSON.stringify({ dryRun, before: before.toISOString(), droppedEmoteViews: counts.setViews, requeuedViews: counts.views }))
process.exit(0)
