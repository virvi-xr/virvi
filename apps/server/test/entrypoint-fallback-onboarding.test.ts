import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** LIV-37: the onboarding column is in entrypoint.sh's schema fallback, as schema.ts declares it. */
describe('entrypoint fallback: users.onboarding_dismissed_at (LIV-37)', () => {
  it('adds the column the schema declares', () => {
    const sh = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8')
    const start = sh.indexOf('node -e "')
    const end = sh.indexOf('" 2>&1 || echo "[virvi-server] SQL fallback had errors"')
    const script = execFileSync('bash', ['-c', `node() { printf '%s' "$2"; }; ${sh.slice(start, end + 1)}`], { encoding: 'utf8' })
    expect(script).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_dismissed_at TIMESTAMPTZ')
    expect(readFileSync(new URL('../src/db/schema.ts', import.meta.url), 'utf8')).toContain("onboardingDismissedAt: timestamp('onboarding_dismissed_at', { withTimezone: true })")
  })
})
