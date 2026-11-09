// The public docs (apps/docs: Starlight, built with base /docs) served at /docs by this server, so hosted and
// self-hosted installs both carry docs that match their version. Agents get Markdown for every page (<page>.md),
// /docs/llms.txt and /docs/llms-full.txt (built by apps/docs/src/pages), and /llms.txt at the root, where they look first.
import type { FastifyInstance, FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'
import { createReadStream, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Whether a request path belongs to the docs (so the app's SPA fallback leaves it alone). */
export function isDocsPath(url: string): boolean {
  return url === '/docs' || url.startsWith('/docs/') || url.startsWith('/docs?')
}

/** Serves the built docs from `dir`. Returns false (and registers nothing) when the docs weren't built. */
export async function registerDocsSite(app: FastifyInstance, dir: string): Promise<boolean> {
  const root = resolve(dir)
  if (!existsSync(join(root, 'index.html'))) return false

  app.get('/docs', (_request, reply) => reply.redirect('/docs/', 301))
  await app.register(fastifyStatic, { root, prefix: '/docs/', decorateReply: false, redirect: true })

  const llms = join(root, 'llms.txt')
  app.get('/llms.txt', (_request, reply) => {
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
