import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'

/** LIV-170: the MCP call log table is in entrypoint.sh's schema fallback, the same as schema.ts makes it. */
function fallbackSql(): string[] {
  const sh = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8')
  const start = sh.indexOf('node -e "')
  const end = sh.indexOf('" 2>&1 || echo "[virvi-server] SQL fallback had errors"')
  const script = execFileSync('bash', ['-c', `node() { printf '%s' "$2"; }; ${sh.slice(start, end + 1)}`], { encoding: 'utf8' })
  const at = script.indexOf('// MCP call log (LIV-170)')
  expect(at).toBeGreaterThan(-1)
  return [...script.slice(at, script.indexOf('} catch(e)', at)).matchAll(/await sql`([^`]*)`/g)].map((m) => m[1])
}

describe('entrypoint fallback: mcp_calls (LIV-170)', () => {
  it('makes the table and indexes as drizzle-kit does, and runs again harmlessly', async () => {
    const S = 'fallback_mcp_calls'
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S}`))
    try {
      for (let i = 0; i < 2; i++) for (const q of fallbackSql()) await db.execute(sql.raw(`SET search_path TO ${S}, public; ${q}`))
      const q = (schema: string) => db.execute(sql`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = 'mcp_calls' ORDER BY column_name`)
      expect(await q(S)).toEqual(await q('public'))
      const idx = (schema: string) => db.execute(sql`SELECT indexname FROM pg_indexes WHERE schemaname = ${schema} AND tablename = 'mcp_calls' ORDER BY indexname`)
      expect(await idx(S)).toEqual(await idx('public'))
    } finally {
      await db.execute(sql.raw(`SET search_path TO public; DROP SCHEMA IF EXISTS ${S} CASCADE`))
    }
  })
})
