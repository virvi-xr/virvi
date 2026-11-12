import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from '../config.js'
import { currentReleaseInfo } from '../transparency.js'

/**
 * GET /api/transparency: what this server says it runs (LIV-165). Public; read once, it doesn't change while running.
 * Also /.well-known/security.txt from the website build: the static server skips dot-folders.
 */
export default async function transparencyRoutes(app: FastifyInstance) {
  const info = currentReleaseInfo(config)
  app.get('/api/transparency', async (_request, reply) => reply.header('cache-control', 'public, max-age=300').send(info))

  let securityTxt: Buffer | null = null
  try { securityTxt = readFileSync(join(resolve(config.dashboardDir), '.well-known', 'security.txt')) } catch { /* no website build */ }
  app.get('/.well-known/security.txt', async (_request, reply) =>
    securityTxt ? reply.type('text/plain; charset=utf-8').send(securityTxt) : reply.status(404).send({ error: 'Not found' }))
}
