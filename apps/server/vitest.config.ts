import { defineConfig } from 'vitest/config'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Uploaded and private files the tests write go to a fresh temp folder, not the default ./uploads and ./private
 * next to the code (private/ isn't gitignored, and a worktree left them behind).
 */
const STORAGE = mkdtempSync(join(tmpdir(), 'virvi-server-test-'))

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://vlm:vlm_dev@localhost:5432/vlm_test'

export default defineConfig({
  resolve: {
    alias: {
      '@virvixr/shared': resolve(here, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'test-secret',
      VIRVI_MODE: 'single',
      TRIALS_ENABLED: 'true', // trial tests run in single mode, where trials default off
      LOG_LEVEL: 'silent',
      LIFECYCLE_SWEEP_MS: '0',
      DCL_REDEPLOY_SWEEP_MS: '0',
      DCL_MAP_SWEEP_MS: '0',
      // Never the real abgen CDN: tests inject a fetcher, and a default one that slipped through fails fast
      DCL_MAP_MANIFEST_URL: 'http://127.0.0.1:9/abgen-manifests',
      ANALYTICS_JOBS: 'false',
      LOCAL_STORAGE_PATH: join(STORAGE, 'uploads'),
      PRIVATE_STORAGE_PATH: join(STORAGE, 'private'),
    },
  },
})
