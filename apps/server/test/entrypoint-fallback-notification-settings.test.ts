import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'

/** LIV-30: the notification settings table is in entrypoint.sh's schema fallback, the same as schema.ts makes it. */
function fallbackSql(): string[] {
  const sh = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8')
  const start = sh.indexOf('node -e "')
  const end = sh.indexOf('" 2>&1 || echo "[virvi-server] SQL fallback had errors"')
  const script = execFileSync('bash', ['-c', `node() { printf '%s' "$2"; }; ${sh.slice(start, end + 1)}`], { encoding: 'utf8' })
  const at = script.indexOf('// Notification settings (LIV-30)')
  expect(at).toBeGreaterThan(-1)
  const block = script.slice(at, script.indexOf('} catch(e)', at))
  return [...block.matchAll(/await sql`([^`]*)`/g)].map((m) => m[1])
}

describe('entrypoint fallback: notification_settings (LIV-30)', () => {
  it('makes the table as drizzle-kit does, and runs again harmlessly', async () => {
    const S = 'fallback_notification_settings'
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S}`))
    try {
      for (let i = 0; i < 2; i++) for (const q of fallbackSql()) await db.execute(sql.raw(`SET search_path TO ${S}, public; ${q}`))
      const cols = (await db.execute(sql`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ${S} AND table_name = 'notification_settings' ORDER BY column_name`)) as unknown as Array<Record<string, string>>
      const real = (await db.execute(sql`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notification_settings' ORDER BY column_name`)) as unknown as Array<Record<string, string>>
      expect(cols).toEqual(real)
      expect(cols.map((c) => c.column_name)).toEqual(['muted', 'updated_at', 'user_id'])
    } finally {
      await db.execute(sql.raw(`SET search_path TO public; DROP SCHEMA IF EXISTS ${S} CASCADE`))
    }
  })
})
