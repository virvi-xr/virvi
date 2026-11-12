import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { config } from '../src/config.js'
import { releaseInfo } from '../src/transparency.js'
import { testApp } from './helpers/factories.js'

/** What production says it runs, for the Transparency page (LIV-165). */
describe('transparency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'virvi-transparency-'))
  const manifest = JSON.stringify({ files: { 'index.html': 'ab' } })
  writeFileSync(join(dir, 'release-manifest.json'), manifest)
  const info = join(dir, 'build-info.json')
  writeFileSync(info, JSON.stringify({ commit: 'a'.repeat(40), buildUrl: 'https://github.com/virvi-xr/virvi/actions/runs/1', buildArgs: { NEXT_PUBLIC_API_URL: 'https://api.virvi.io' } }))

  it('reports the commit, the CI run, the image and the website manifest with its hash', () => {
    const r = releaseInfo({ buildInfoPath: info, dashboardDir: dir, release: 'aaaaaaaaaaaa' })
    expect(r).toMatchObject({
      repo: 'https://github.com/virvi-xr/virvi',
      commit: 'a'.repeat(40),
      commitUrl: `https://github.com/virvi-xr/virvi/commit/${'a'.repeat(40)}`,
      buildUrl: 'https://github.com/virvi-xr/virvi/actions/runs/1',
      image: `ghcr.io/virvi-xr/virvi:${'a'.repeat(40)}`,
      buildArgs: { NEXT_PUBLIC_API_URL: 'https://api.virvi.io' },
      verified: true,
      manifest: { url: '/release-manifest.json', sha256: createHash('sha256').update(manifest).digest('hex') },
    })
  })

  it('a build not made by CI says so instead of claiming a commit', () => {
    const r = releaseInfo({ buildInfoPath: join(dir, 'missing.json'), dashboardDir: join(dir, 'nowhere'), release: 'dev' })
    expect(r).toMatchObject({ commit: null, image: null, buildUrl: null, verified: false, manifest: null, release: 'dev' })
  })

  it('GET /api/transparency is public', async () => {
    const app = await testApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/transparency' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ repo: 'https://github.com/virvi-xr/virvi', release: config.release })
    } finally { await app.close() }
  })
})
