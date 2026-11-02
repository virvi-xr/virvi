import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The schema fallback in entrypoint.sh, as bash hands it to `node -e` (bash, not Node, removes one level of quoting). */
function fallbackScript(): string {
  const sh = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8')
  const start = sh.indexOf('node -e "')
  const end = sh.indexOf('" 2>&1 || echo "[virvi-server] SQL fallback had errors"')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const block = sh.slice(start, end + 1)
  return execFileSync('bash', ['-c', `node() { printf '%s' "$2"; }; ${block}`], { encoding: 'utf8' })
}

describe('entrypoint schema fallback', () => {
  it('reaches Node as valid JavaScript', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'entrypoint-')), 'fallback.js')
    writeFileSync(file, fallbackScript())
    expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow()
  })

  it('keeps the quotes on room_sets."offset", a reserved word in SQL', () => {
    expect(fallbackScript()).toContain('"offset" JSONB NOT NULL')
  })
})
