// Local tools: they run here, not through a route. search_help reads the public docs; open_page only returns a link;
// open_finalize reads the design and its quote as the user, then returns a link to the page that finalizes it;
// open_beat_pay does the same for a draft BEAT and the page that pays for it.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { config } from '../../config.js'
import { dollars } from '../../studio/pricing.js'
import { id } from './read.js'
import { get } from './write.js'
import { STUDIO_REFUSALS } from './studio.js'
import { ToolError, type ToolDef } from './types.js'

const MAX_RESULTS = 3
const EXCERPT_MAX = 1500
/** How far before the first match an excerpt starts, for context. */
const LEAD = 200

/** The real top-level dashboard pages (apps/web/src/app/(dashboard)/), less admin and demo. */
const PAGES = ['scenes', 'studio', 'sync', 'events', 'drops', 'virvi-cities', 'cities', 'analytics', 'media', 'streaming', 'beats', 'settings', 'publish', 'assets', 'import', 'command-center']
/** Old paths that redirect (/deploy → /sync, /giveaways → /drops): still accepted, not offered. */
const OLD_PAGES = ['deploy', 'giveaways']
const PAGE_RE = new RegExp(`^/(${[...PAGES, ...OLD_PAGES].join('|')})(/[^\\s?#\\\\]*)?(\\?[\\w=&%-]*)?$`)
const BAD_PAGE = 'Only Virvi dashboard pages can be opened.'

/** A dashboard path, with no `.`/`..` segment (plain or percent-encoded) that a browser would resolve elsewhere. */
export function isDashboardPath(path: string): boolean {
  if (!PAGE_RE.test(path)) return false
  return !path.split('?')[0].split('/').some((seg) => {
    const s = seg.toLowerCase().replaceAll('%2e', '.')
    return s === '.' || s === '..'
  })
}

function markdownFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md')) out.push(full)
    }
  }
  walk(root)
  return out
}

export interface HelpResult {
  title: string
  href: string
  excerpt: string
}

/** The docs pages that best match `query`, by how often its terms appear. */
export function searchHelp(query: string, dir = config.docsDir): HelpResult[] {
  const root = resolve(dir)
  if (!existsSync(root)) return []
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1))]
  if (!terms.length) return []
  const scored: Array<HelpResult & { score: number }> = []
  for (const file of markdownFiles(root)) {
    const text = readFileSync(file, 'utf8')
    const lower = text.toLowerCase()
    let score = 0
    let first = -1
    for (const t of terms) {
      for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length)) {
        score++
        if (first === -1 || i < first) first = i
      }
    }
    if (!score) continue
    const heading = /^#\s+(.+)$/m.exec(text)
    const slug = relative(root, file).split(sep).join('/').replace(/\.md$/, '').replace(/(^|\/)index$/, '$1')
    const title = heading?.[1].trim() || slug || 'Virvi docs'
    // Start near the first match, but after the title line
    const bodyStart = heading ? heading.index + heading[0].length : 0
    const start = Math.max(bodyStart, first - LEAD)
    scored.push({ title, href: `/docs/${slug}`, excerpt: text.slice(start, start + EXCERPT_MAX).trim(), score })
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map(({ score: _score, ...r }) => r)
}

/** The local tools whose result is a link (with a price) the loop shows, by the id arg its history row is matched on. */
export const LINK_TOOLS: Record<string, string> = { open_finalize: 'designId', open_beat_pay: 'beatId' }

export const BEAT_ALREADY_PAID = 'This BEAT is already paid for.'
/** Why a BEAT that isn't a draft can't be paid for, in the payment routes' own words. */
const NOT_PAYABLE: Record<string, string> = { cancelled: 'This BEAT is cancelled.', ended: 'This BEAT is over.' }
/** A price as the BEAT page shows it ($12.00). */
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`

export const LOCAL_TOOLS: ToolDef<any>[] = [
  {
    name: 'search_help',
    description: "Search Virvi's help docs. Returns up to 3 pages, each with its title, link and an excerpt.",
    input: z.object({ query: z.string().trim().min(1).max(200) }),
    effect: 'read',
    call: () => {
      throw new Error('search_help runs locally')
    },
    local: async (a) => searchHelp(a.query),
    label: (a) => `Search the help for "${a.query}"`,
    summarize: (res) => res,
  },
  {
    name: 'open_page',
    description: `Offer the user a link to a Virvi dashboard page (a path such as /scenes?id=…; top-level pages: ${PAGES.join(', ')}).`,
    input: z.object({ path: z.string().max(500), label: z.string().trim().min(1).max(80) }),
    effect: 'read',
    call: () => {
      throw new Error('open_page runs locally')
    },
    local: async (a) => {
      if (!isDashboardPath(a.path)) throw new ToolError(400, BAD_PAGE)
      return { href: a.path, label: a.label }
    },
    label: (a) => `Link to ${a.label}`,
    summarize: (res) => res,
  },
  {
    name: 'open_finalize',
    description: "Offer the user a link to finalize a Studio design (pay for its pieces), with the price now. The user finalizes it there; the assistant can't.",
    input: z.object({ designId: id() }),
    effect: 'read',
    call: () => {
      throw new Error('open_finalize runs locally')
    },
    local: async (a, ctx) => {
      const name = (await get(ctx, `/api/studio/designs/${a.designId}`, STUDIO_REFUSALS)).design?.name
      const quote = await get(ctx, `/api/studio/designs/${a.designId}/finalize`, STUDIO_REFUSALS)
      const label = typeof name === 'string' && name.trim() ? `Finalize "${name}"` : 'Finalize the design'
      return { href: `/studio/${a.designId}?step=finalize`, label, detail: `Total ${dollars(Number(quote.totalCents) || 0)}` }
    },
    label: () => 'Link to finalize a design',
    summarize: (res) => res,
  },
  {
    name: 'open_beat_pay',
    description: "Offer the user a link to pay for a draft BEAT on its page, with the price now. The user pays there; the assistant can't.",
    input: z.object({ beatId: id() }),
    effect: 'read',
    call: () => {
      throw new Error('open_beat_pay runs locally')
    },
    local: async (a, ctx) => {
      const beat = await get(ctx, `/api/beats/${a.beatId}`)
      if (beat.status !== 'draft') throw new ToolError(409, NOT_PAYABLE[beat.status] ?? BEAT_ALREADY_PAID)
      // The price is the same by card or credit; credit is asked for so a price under the card minimum still quotes
      const quote = await get(ctx, `/api/beats/${a.beatId}/quote?method=credit`)
      const label = typeof beat.name === 'string' && beat.name.trim() ? `Pay for "${beat.name}"` : 'Pay for the BEAT'
      return { href: `/beats/${a.beatId}`, label, detail: `Total ${usd(Number(quote.cents) || 0)}` }
    },
    label: () => 'Link to pay for a BEAT',
    summarize: (res) => res,
  },
]
