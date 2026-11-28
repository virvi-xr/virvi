import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'

/** LIV-170: the OAuth tables and api_keys.oauth_client_id are in entrypoint.sh's fallback, as schema.ts makes them. */
function fallbackSql(): string[] {
  const sh = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8')
  const start = sh.indexOf('node -e "')
  const end = sh.indexOf('" 2>&1 || echo "[virvi-server] SQL fallback had errors"')
  const script = execFileSync('bash', ['-c', `node() { printf '%s' "$2"; }; ${sh.slice(start, end + 1)}`], { encoding: 'utf8' })
  const at = script.indexOf('// OAuth for MCP clients (LIV-170)')
  expect(at).toBeGreaterThan(-1)
  return [...script.slice(at, script.indexOf('} catch(e)', at)).matchAll(/await sql`([^`]*)`/g)].map((m) => m[1])
}

describe('entrypoint fallback: OAuth (LIV-170)', () => {
  it('makes the tables as drizzle-kit does, and runs again harmlessly', async () => {
    const S = 'fallback_oauth'
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S}; CREATE TABLE ${S}.api_keys (id UUID PRIMARY KEY)`))
    try {
      for (let i = 0; i < 2; i++) for (const q of fallbackSql()) await db.execute(sql.raw(`SET search_path TO ${S}, public; ${q}`))
      for (const t of ['oauth_clients', 'oauth_codes']) {
        const q = (schema: string) => db.execute(sql`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${t} ORDER BY column_name`)
        expect(await q(S), t).toEqual(await q('public'))
      }
      const col = await db.execute(sql`SELECT data_type FROM information_schema.columns WHERE table_schema = ${S} AND table_name = 'api_keys' AND column_name = 'oauth_client_id'`)
      expect(col).toEqual([{ data_type: 'text' }])
    } finally {
      await db.execute(sql.raw(`SET search_path TO public; DROP SCHEMA IF EXISTS ${S} CASCADE`))
    }
  })
})
