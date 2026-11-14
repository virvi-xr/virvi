import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { BEAT_CHAINS, beatAddressUrl, type BeatChain } from '@virvixr/shared'

/**
 * What this server says it runs, for the Transparency page (LIV-165). CI builds each release from a public commit and
 * signs where the image came from (.github/workflows/release.yml); the image carries build-info.json and the website's
 * release-manifest.json (scripts/build-info.mjs, scripts/release-manifest.mjs). A server can claim anything, so this is
 * only a pointer: the signed attestation and a rebuild of the website (scripts/verify-release.sh) are the proof.
 */

export const REPO_URL = 'https://github.com/virvi-xr/virvi'
export const IMAGE = 'ghcr.io/virvi-xr/virvi'
export const MANIFEST_NAME = 'release-manifest.json'

const SHA = /^[0-9a-f]{40}$/

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** The BEAT contracts (LIV-11), each with its explorer page and its source in the repo at the running commit. */
export function beatContracts(contracts: Partial<Record<BeatChain, string>>, commit: string | null) {
  return BEAT_CHAINS.filter((chain) => contracts[chain]).map((chain) => ({
    chain,
    address: contracts[chain]!,
    explorerUrl: beatAddressUrl(chain, contracts[chain]!),
    sourceUrl: `${REPO_URL}/blob/${commit ?? 'main'}/contracts/src/VirviBeat.sol`,
  }))
}

export function releaseInfo(opts: { buildInfoPath: string; dashboardDir: string; release: string }) {
  const build = readJson(opts.buildInfoPath)
  const commit = typeof build?.commit === 'string' && SHA.test(build.commit) ? build.commit : null
  let manifest: { url: string; sha256: string } | null = null
  try {
    const bytes = readFileSync(join(opts.dashboardDir, MANIFEST_NAME))
    manifest = { url: `/${MANIFEST_NAME}`, sha256: createHash('sha256').update(bytes).digest('hex') }
  } catch { /* a dev server or a build without a manifest */ }
  const buildUrl = typeof build?.buildUrl === 'string' && build.buildUrl.startsWith(`${REPO_URL}/actions/runs/`) ? build.buildUrl : null
  return {
    repo: REPO_URL,
    release: opts.release,
    commit,
    commitUrl: commit ? `${REPO_URL}/commit/${commit}` : null,
    buildUrl,
    image: commit ? `${IMAGE}:${commit}` : null,
    buildArgs: (build?.buildArgs && typeof build.buildArgs === 'object' ? build.buildArgs : {}) as Record<string, string>,
    // Built by CI from a public commit (it has a signed attestation to check); false for a build from someone's machine
    verified: !!(commit && buildUrl),
    manifest,
  }
}

/** The running image's release info: build-info.json sits at the image's root (/app), next to the dashboard. */
export function currentReleaseInfo(config: { dashboardDir: string; release: string }) {
  const dashboardDir = resolve(config.dashboardDir)
  return releaseInfo({ buildInfoPath: join(dirname(dashboardDir), 'build-info.json'), dashboardDir, release: config.release })
}
