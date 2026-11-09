import type { APIRoute } from 'astro'
import { orderedDocs, SECTIONS, sectionOf, siteOrigin, urls } from '../lib/agent-docs'

// The llms.txt index: what Virvi is, and every docs page with its Markdown link.
export const GET: APIRoute = async ({ site }) => {
  const origin = siteOrigin(site)
  const docs = await orderedDocs()
  const lines = [
    '# Virvi',
    '',
    '> Virvi runs media, events, ads, analytics and in-world builder HUDs for virtual worlds (Decentraland, Hyperfy, Meta Quest and Apple Vision Pro AR) from one dashboard and server. It can be used hosted at virvi.io or self-hosted from one Docker image.',
    '',
    'These docs are written for people and their AI agents. Every page is available as Markdown (the links below). The whole set in one file:',
    `${origin}/docs/llms-full.txt`,
    '',
    `Start with the agent guide: ${urls(origin, 'agents/use-virvi-with-your-agent').md}`,
    '',
  ]
  for (const { dir, label } of SECTIONS) {
    const pages = docs.filter((e) => sectionOf(e.id) === dir)
    if (!pages.length) continue
    lines.push(`## ${label}`, '')
    for (const e of pages) lines.push(`- [${e.data.title}](${urls(origin, e.id).md})${e.data.description ? `: ${e.data.description}` : ''}`)
    lines.push('')
  }
  const other = docs.filter((e) => e.id !== 'index' && !sectionOf(e.id))
  if (other.length) {
    lines.push('## Other', '')
    for (const e of other) lines.push(`- [${e.data.title}](${urls(origin, e.id).md})`)
    lines.push('')
  }
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
