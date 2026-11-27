import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** LIV-32: the tenant area column is in entrypoint.sh's schema fallback, as schema.ts declares it. */
function fallbackScript(): string {
  const sh = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8')
  const start = sh.indexOf('node -e "')
  const end = sh.indexOf('" 2>&1 || echo "[virvi-server] SQL fallback had errors"')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return execFileSync('bash', ['-c', `node() { printf '%s' "$2"; }; ${sh.slice(start, end + 1)}`], { encoding: 'utf8' })
}

describe('entrypoint fallback: scene_roles.area (LIV-32)', () => {
  it('adds the column the schema declares', () => {
    expect(fallbackScript()).toContain('ALTER TABLE scene_roles ADD COLUMN IF NOT EXISTS area JSONB')
    expect(readFileSync(new URL('../src/db/schema.ts', import.meta.url), 'utf8')).toContain("area: jsonb('area').$type<EditArea>()")
  })
})
