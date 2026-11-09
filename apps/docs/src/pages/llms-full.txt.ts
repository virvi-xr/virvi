import type { APIRoute } from 'astro'
import { orderedDocs, pageMarkdown, siteOrigin } from '../lib/agent-docs'

// Every docs page as Markdown in one file, in sidebar order, for agents that want the whole picture at once.
export const GET: APIRoute = async ({ site }) => {
  const origin = siteOrigin(site)
  const docs = await orderedDocs()
  const body = docs.map((e) => pageMarkdown(origin, e)).join('\n---\n\n')
  return new Response(`# Virvi documentation (full text)\n\nIndex: ${origin}/docs/llms.txt\n\n---\n\n${body}`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
