import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { beatSettingsFrom, config } from '../src/config.js'
import { beatContracts, releaseInfo } from '../src/transparency.js'
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

  describe('BEAT contracts (LIV-11)', () => {
    const AMOY = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
    const saved = config.beats.contracts
    afterEach(() => { config.beats.contracts = saved })

    it('standards I5: links the contract source at the commit it was deployed from, else the contracts folder on main, claiming no commit', () => {
      expect(beatContracts({ 'polygon-amoy': AMOY }, { 'polygon-amoy': '6637054d' })).toEqual([{
        chain: 'polygon-amoy',
        address: AMOY,
        explorerUrl: `https://amoy.polygonscan.com/address/${AMOY}`,
        deployedCommit: '6637054d',
        sourceUrl: 'https://github.com/virvi-xr/virvi/blob/6637054d/contracts/src/VirviBeat.sol',
      }])
      expect(beatContracts({ 'polygon-amoy': AMOY })[0]).toMatchObject({ deployedCommit: null, sourceUrl: 'https://github.com/virvi-xr/virvi/tree/main/contracts' })
    })

    it('GET /api/transparency lists no contracts when none is set', async () => {
      config.beats.contracts = beatSettingsFrom({}).contracts
      const app = await testApp()
      try {
        expect((await app.inject({ method: 'GET', url: '/api/transparency' })).json().contracts).toEqual([])
      } finally { await app.close() }
    })

    it('GET /api/transparency lists the Amoy contract once BEAT_CONTRACT_POLYGON_AMOY is set', async () => {
      config.beats.contracts = beatSettingsFrom({ BEAT_CONTRACT_POLYGON_AMOY: AMOY }).contracts
      const app = await testApp()
      try {
        const { contracts } = (await app.inject({ method: 'GET', url: '/api/transparency' })).json()
        expect(contracts).toHaveLength(1)
        expect(contracts[0]).toMatchObject({ chain: 'polygon-amoy', address: AMOY, explorerUrl: `https://amoy.polygonscan.com/address/${AMOY}` })
        // Not the running server's commit: no BEAT_CONTRACT_COMMIT_POLYGON_AMOY in tests, so the folder on main
        expect(contracts[0]).toMatchObject({ deployedCommit: null, sourceUrl: 'https://github.com/virvi-xr/virvi/tree/main/contracts' })
      } finally { await app.close() }
    })
  })
})
