// The public docs (apps/docs: Starlight, built with base /docs) served at /docs by this server, so hosted and
// self-hosted installs both carry docs that match their version. Agents get Markdown for every page (<page>.md),
// /docs/llms.txt and /docs/llms-full.txt (built by apps/docs/src/pages), and /llms.txt at the root, where they look first.
import type { FastifyInstance, FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/** The site the docs are built for (apps/docs `site`, unless DOCS_SITE is set at build time). */
const BUILT_SITE = 'https://virvi.io'

/** Every built .md and .txt file under `root`, by its URL path under /docs/. */
function agentFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md') || entry.name.endsWith('.txt')) out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * The agent files (llms.txt, llms-full.txt, <page>.md) with their links moved from the built site to this server, so an
 * agent reading a self-hosted install's docs stays on that install. Empty when this server is the built site.
 */
export function rewrittenAgentFiles(root: string, siteUrl: string | undefined): Map<string, string> {
  const files = new Map<string, string>()
  let origin: string
  try { origin = new URL(siteUrl ?? '').origin } catch { return files }
  if (origin === BUILT_SITE) return files
  for (const full of agentFiles(root)) {
    const text = readFileSync(full, 'utf8')
    if (!text.includes(BUILT_SITE)) continue
    const moved = text.replaceAll(`${BUILT_SITE}/docs`, `${origin}/docs`).replaceAll(`${BUILT_SITE}/llms.txt`, `${origin}/llms.txt`)
    files.set(`/docs/${relative(root, full).split(sep).join('/')}`, moved)
  }
  return files
}

const typeOf = (path: string) => (path.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')

/** Whether a request path belongs to the docs (so the app's SPA fallback leaves it alone). */
export function isDocsPath(url: string): boolean {
  return url === '/docs' || url.startsWith('/docs/') || url.startsWith('/docs?')
}

/**
 * Serves the built docs from `dir`. Returns false (and registers nothing) when the docs weren't built. With a
 * `siteUrl` (the dashboard's origin, WEB_APP_URL) other than the built site, the agent files' links point there instead.
 */
export async function registerDocsSite(app: FastifyInstance, dir: string, siteUrl?: string): Promise<boolean> {
  const root = resolve(dir)
  if (!existsSync(join(root, 'index.html'))) return false

  const rewritten = rewrittenAgentFiles(root, siteUrl)
  if (rewritten.size > 0) {
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0]
      const text = rewritten.get(path)
      if (text !== undefined && (request.method === 'GET' || request.method === 'HEAD')) return reply.type(typeOf(path)).send(text)
    })
  }

  app.get('/docs', (_request, reply) => reply.redirect('/docs/', 301))
  await app.register(fastifyStatic, { root, prefix: '/docs/', decorateReply: false, redirect: true })

  const llms = join(root, 'llms.txt')
  app.get('/llms.txt', (_request, reply) => {
    const text = rewritten.get('/docs/llms.txt')
    if (text !== undefined) return reply.type('text/plain; charset=utf-8').send(text)
    if (!existsSync(llms)) return reply.callNotFound()
    return reply.type('text/plain; charset=utf-8').send(createReadStream(llms))
  })
  return true
}

/** The docs' own 404 page for a docs path that doesn't exist. */
export function sendDocsNotFound(reply: FastifyReply, dir: string): FastifyReply {
  const page = join(resolve(dir), '404.html')
  if (!existsSync(page)) return reply.status(404).type('text/plain; charset=utf-8').send('Not found')
  return reply.status(404).type('text/html; charset=utf-8').send(createReadStream(page))
}
