import type { APIRoute, GetStaticPaths } from 'astro'
import { orderedDocs, pageMarkdown, siteOrigin, type DocEntry } from '../lib/agent-docs'

// Each page's Markdown at /docs/<page>.md (the home page at /docs/index.md).
export const getStaticPaths: GetStaticPaths = async () =>
  (await orderedDocs()).map((entry) => ({ params: { slug: entry.id }, props: { entry } }))

export const GET: APIRoute = ({ props, site }) =>
  new Response(pageMarkdown(siteOrigin(site), (props as { entry: DocEntry }).entry), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
