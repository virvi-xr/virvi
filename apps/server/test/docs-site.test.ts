// The docs site (apps/docs, built with base /docs) served by virvi-server: pages, Markdown for agents, llms.txt at the
// root as well, and the docs' own 404 page for a missing docs path.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerDocsSite, isDocsPath, sendDocsNotFound } from '../src/http/docs-site.js'

let dir: string
let app: FastifyInstance

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'docs-site-'))
  writeFileSync(join(dir, 'index.html'), '<h1>Virvi Docs</h1>')
  writeFileSync(join(dir, '404.html'), '<h1>Docs page not found</h1>')
  writeFileSync(join(dir, 'llms.txt'), '# Virvi\n')
  mkdirSync(join(dir, 'self-hosting', 'overview'), { recursive: true })
  writeFileSync(join(dir, 'self-hosting', 'overview', 'index.html'), '<h1>Self-hosting</h1>')
  writeFileSync(join(dir, 'self-hosting', 'overview.md'), '# Self-hosting\n')
  app = Fastify()
  expect(await registerDocsSite(app, dir)).toBe(true)
  app.setNotFoundHandler((request, reply) => (isDocsPath(request.url) ? sendDocsNotFound(reply, dir) : reply.status(404).send('app 404')))
  await app.ready()
})

afterAll(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('docs site', () => {
  it('redirects /docs to /docs/', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' })
    expect(res.statusCode).toBe(301)
    expect(res.headers.location).toBe('/docs/')
  })

  it('serves the home page and nested pages', async () => {
    expect((await app.inject({ method: 'GET', url: '/docs/' })).body).toContain('Virvi Docs')
    expect((await app.inject({ method: 'GET', url: '/docs/self-hosting/overview/' })).body).toContain('Self-hosting')
  })

  it('serves a page as Markdown', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/self-hosting/overview.md' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/markdown/)
    expect(res.body).toBe('# Self-hosting\n')
  })

  it('answers /llms.txt at the root as well as under /docs', async () => {
    for (const url of ['/llms.txt', '/docs/llms.txt']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
      expect(res.headers['content-type'], url).toMatch(/^text\/plain/)
      expect(res.body, url).toBe('# Virvi\n')
    }
  })

  it("shows the docs' own 404 page, with a 404 status, for a missing docs page", async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/no-such-page/' })
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('Docs page not found')
  })

  it('leaves other paths to the app', async () => {
    expect(isDocsPath('/docsy')).toBe(false)
    expect(isDocsPath('/scenes/docs/')).toBe(false)
    expect(isDocsPath('/docs/x')).toBe(true)
    expect((await app.inject({ method: 'GET', url: '/nope' })).body).toBe('app 404')
  })

  it('does nothing when the docs were not built', async () => {
    const bare = Fastify()
    expect(await registerDocsSite(bare, join(dir, 'missing'))).toBe(false)
    await bare.ready()
    expect((await bare.inject({ method: 'GET', url: '/llms.txt' })).statusCode).toBe(404)
    await bare.close()
  })
})

describe('docs site on a self-hosted address', () => {
  let selfDir: string
  let selfApp: FastifyInstance
  beforeAll(async () => {
    selfDir = mkdtempSync(join(tmpdir(), 'docs-self-'))
    writeFileSync(join(selfDir, 'index.html'), '<a href="https://virvi.io/docs/x/">x</a>')
    writeFileSync(join(selfDir, 'llms.txt'), '- [Overview](https://virvi.io/docs/self-hosting/overview.md)\nHosted: https://virvi.io\n')
    mkdirSync(join(selfDir, 'self-hosting'), { recursive: true })
    writeFileSync(join(selfDir, 'self-hosting', 'overview.md'), 'Index: https://virvi.io/llms.txt\n')
    selfApp = Fastify()
    await registerDocsSite(selfApp, selfDir, 'https://venues.example.com/')
    await selfApp.ready()
  })
  afterAll(async () => {
    await selfApp.close()
    rmSync(selfDir, { recursive: true, force: true })
  })

  it("points llms.txt's docs links at this server, at the root and under /docs, and leaves virvi.io itself alone", async () => {
    for (const url of ['/llms.txt', '/docs/llms.txt', '/docs/llms.txt?x=1']) {
      const res = await selfApp.inject({ method: 'GET', url })
      expect(res.headers['content-type'], url).toMatch(/^text\/plain/)
      expect(res.body, url).toBe('- [Overview](https://venues.example.com/docs/self-hosting/overview.md)\nHosted: https://virvi.io\n')
    }
  })

  it('rewrites Markdown pages and leaves HTML as built', async () => {
    const md = await selfApp.inject({ method: 'GET', url: '/docs/self-hosting/overview.md' })
    expect(md.headers['content-type']).toMatch(/^text\/markdown/)
    expect(md.body).toBe('Index: https://venues.example.com/llms.txt\n')
    expect((await selfApp.inject({ method: 'GET', url: '/docs/' })).body).toContain('https://virvi.io/docs/x/')
  })
})
