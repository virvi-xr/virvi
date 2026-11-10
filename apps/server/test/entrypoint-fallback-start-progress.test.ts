import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'

/**
 * The Design Studio first-reply wait part of entrypoint.sh's schema fallback: run in a scratch schema, it adds
 * studio_jobs.timings and studio_designs.warmed_at exactly as drizzle-kit push made them from schema.ts.
 */

function fallbackScript(): string {
  const sh = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8')
  const start = sh.indexOf('node -e "')
  const end = sh.indexOf('" 2>&1 || echo "[virvi-server] SQL fallback had errors"')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const block = sh.slice(start, end + 1)
  return execFileSync('bash', ['-c', `node() { printf '%s' "$2"; }; ${block}`], { encoding: 'utf8' })
}

/** The SQL of every `// <label>` block of the fallback, statement by statement. */
function fallbackBlocks(label: string): string[] {
  const script = fallbackScript()
  const out: string[] = []
  for (let start = script.indexOf(`// ${label}`); start > -1; start = script.indexOf(`// ${label}`, start + 1)) {
    const block = script.slice(start, script.indexOf('} catch(e)', start))
    out.push(...[...block.matchAll(/await sql`([^`]*)`/g)].map((m) => m[1]))
  }
  expect(out.length, label).toBeGreaterThan(0)
  return out
}

const SCHEMA = 'fallback_start_progress'
const COLUMNS = [['studio_jobs', 'timings'], ['studio_designs', 'warmed_at']] as const

type Col = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }
const columns = async (schema: string) => (await db.execute(sql`
  SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
  WHERE table_schema = ${schema} AND ((table_name = 'studio_jobs' AND column_name = 'timings')
    OR (table_name = 'studio_designs' AND column_name = 'warmed_at'))
  ORDER BY table_name`) as unknown as Col[])

describe('entrypoint schema fallback: Design Studio first-reply wait', () => {
  it('adds the timings and warmed_at columns exactly as schema.ts does, and runs again harmlessly', async () => {
    const statements = fallbackBlocks('Design Studio first-reply wait')
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`))
    await db.execute(sql.raw(`CREATE SCHEMA ${SCHEMA}`))
    try {
      // The tables as they were before this feature
      for (const [table, column] of COLUMNS) {
        await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.${table} (LIKE public.${table} INCLUDING ALL)`))
        await db.execute(sql.raw(`ALTER TABLE ${SCHEMA}.${table} DROP COLUMN ${column}`))
      }
      const run = () => db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL search_path TO ${SCHEMA}, public`))
        for (const s of statements) await tx.execute(sql.raw(s))
      })
      await run()
      expect(await columns(SCHEMA)).toEqual(await columns('public'))
      expect(await columns(SCHEMA)).toHaveLength(2)
      await run()
      expect(await columns(SCHEMA)).toEqual(await columns('public'))
    } finally {
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`))
    }
  })
})
