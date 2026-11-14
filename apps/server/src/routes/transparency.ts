import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from '../config.js'
import { beatContracts, currentReleaseInfo } from '../transparency.js'

/**
 * GET /api/transparency: what this server says it runs (LIV-165), and the BEAT contracts (LIV-11). Public; read once, it doesn't change while running.
 * Also /.well-known/security.txt from the website build: the static server skips dot-folders.
 */
export default async function transparencyRoutes(app: FastifyInstance) {
  const release = currentReleaseInfo(config)
  const info = { ...release, contracts: beatContracts(config.beats.contracts, release.commit) }
  app.get('/api/transparency', async (_request, reply) => reply.header('cache-control', 'public, max-age=300').send(info))

  let securityTxt: Buffer | null = null
  try { securityTxt = readFileSync(join(resolve(config.dashboardDir), '.well-known', 'security.txt')) } catch { /* no website build */ }
  app.get('/.well-known/security.txt', async (_request, reply) =>
    securityTxt ? reply.type('text/plain; charset=utf-8').send(securityTxt) : reply.status(404).send({ error: 'Not found' }))
}
