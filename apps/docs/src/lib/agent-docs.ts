// Plain-text views of the docs for AI agents and tools (the llms.txt convention): an index, everything in one file,
// and each page's Markdown at its own URL. Built from the same content collection as the site, so they never drift.
import { getCollection, type CollectionEntry } from 'astro:content'

export type DocEntry = CollectionEntry<'docs'>

/** Section order matches the site's sidebar (astro.config.mjs). */
export const SECTIONS: { dir: string; label: string }[] = [
  { dir: 'getting-started', label: 'Getting Started' },
  { dir: 'dashboard', label: 'Dashboard' },
  { dir: 'sdk', label: 'SDK' },
  { dir: 'custom-features', label: 'Custom Features' },
  { dir: 'api', label: 'API' },
  { dir: 'security', label: 'Security' },
  { dir: 'self-hosting', label: 'Self-Hosting' },
  { dir: 'agents', label: 'Using Virvi with an AI agent' },
]

export function sectionOf(id: string): string {
  const dir = id.split('/')[0]
  return SECTIONS.some((s) => s.dir === dir) ? dir : ''
}

/** Every page, in sidebar order (sections in order, then by sidebar.order, then by title). Drafts are left out. */
export async function orderedDocs(): Promise<DocEntry[]> {
  const all = (await getCollection('docs')).filter((e) => !e.data.draft)
  const rank = (e: DocEntry) => {
    const i = SECTIONS.findIndex((s) => s.dir === sectionOf(e.id))
    return i === -1 ? (e.id === 'index' ? -1 : SECTIONS.length) : i
  }
  const order = (e: DocEntry) => (e.data.sidebar as { order?: number } | undefined)?.order ?? 1000
  return all.sort((a, b) => rank(a) - rank(b) || order(a) - order(b) || a.data.title.localeCompare(b.data.title))
}

/** Absolute URLs for a page: the HTML page and its Markdown. `site` is Astro's configured site (no trailing slash). */
export function urls(site: string, id: string): { html: string; md: string } {
  const path = id === 'index' ? '' : `${id}/`
  return { html: `${site}/docs/${path}`, md: `${site}/docs/${id === 'index' ? 'index' : id}.md` }
}

export function siteOrigin(site: URL | undefined): string {
  return (site?.toString() ?? 'https://virvi.io').replace(/\/$/, '')
}

/** The page as Markdown an agent can read on its own: title, source URL, description, then the body. */
export function pageMarkdown(site: string, e: DocEntry): string {
  const { html } = urls(site, e.id)
  const desc = e.data.description ? `\n> ${e.data.description}\n` : ''
  return `# ${e.data.title}\n\nSource: ${html}\n${desc}\n${(e.body ?? '').trim()}\n`
}
