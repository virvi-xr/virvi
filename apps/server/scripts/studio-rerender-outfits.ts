/**
 * LIV-143: re-renders the Studio views made before each body shape had its own outfit (src/studio/rerender-outfits.ts).
 *
 * Run it in the production server's environment (a Railway shell: it needs STUDIO_MACHINES=fly, STUDIO_WORKER_IMAGE
 * and FLY_API_TOKEN, and refuses a real run without them), once the worker image with per-body-shape outfits is live
 * AND no machine on an older image is still running (`fly machines list -a <studio app>`; an idle worker exits after
 * 10 minutes). --before is that moment: renders whose job was made earlier are redone. Designs whose machine is still
 * on an older image are skipped and listed; run again later to catch them. Start with --dry-run, then a --design
 * canary, then batches of --limit designs (default 20), most recently active first. Each design's worker is started
 * and its renders waited for (up to 10 minutes) before the next. If Fly refuses a start the run stops; that design's
 * renders stay queued.
 *
 *   pnpm exec tsx scripts/studio-rerender-outfits.ts --before 2026-11-09T12:00:00Z [--dry-run] [--limit 20] [--design <id>]
 */
import { rerenderOutfitViews } from '../src/studio/rerender-outfits.js'

const args = process.argv.slice(2)
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const before = value('--before') ? new Date(value('--before')!) : null
const limit = value('--limit') ? Number(value('--limit')) : 20
if (!before || Number.isNaN(before.getTime()) || !Number.isInteger(limit) || limit < 1) {
  console.error('usage: studio-rerender-outfits.ts --before <ISO time> [--dry-run] [--limit <designs, default 20>] [--design <id>]')
  process.exit(2)
}
const dryRun = args.includes('--dry-run')
try {
  const r = await rerenderOutfitViews(new Date(), { before, dryRun, limit, designId: value('--design') })
  console.log(JSON.stringify({ dryRun, before: before.toISOString(), limit, ...r }))
  process.exit(r.stopped ? 1 : 0)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
}
