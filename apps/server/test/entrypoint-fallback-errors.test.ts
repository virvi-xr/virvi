import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'

/**
 * The error reporting part of entrypoint.sh's schema fallback (LIV-66): run in a scratch schema, it makes the seven
 * error tables exactly as drizzle-kit push made them from schema.ts, and runs again harmlessly.
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

const SCHEMA = 'fallback_errors'
const NEW_TABLES = ['error_signatures', 'error_events', 'error_hourly', 'error_hourly_dims', 'error_hourly_users', 'error_reports', 'error_settings']

type Col = { column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null }
const columns = async (schema: string, table: string) => (await db.execute(sql`
  SELECT column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns
  WHERE table_schema = ${schema} AND table_name = ${table} ORDER BY column_name`) as unknown as Col[])
  .map((c) => ({ ...c, column_default: c.column_default?.replace(`${schema}.`, '') ?? null }))
const constraints = async (schema: string, table: string) => (await db.execute(sql`
  SELECT conname, contype, regexp_replace(pg_get_constraintdef(oid), '${sql.raw(SCHEMA)}\\.', '', 'g') AS def FROM pg_constraint
  WHERE conrelid = ${`${schema}.${table}`}::regclass ORDER BY conname`) as unknown as object[])
const indexes = async (schema: string, table: string) => (await db.execute(sql`
  SELECT indexname, regexp_replace(indexdef, ' ON [a-z_]+\.', ' ON ') AS def FROM pg_indexes
  WHERE schemaname = ${schema} AND tablename = ${table} ORDER BY indexname`) as unknown as { indexname: string; def: string }[])

async function scratch(run: () => Promise<void>) {
  await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`))
  await db.execute(sql.raw(`CREATE SCHEMA ${SCHEMA}`))
  try {
    await run()
  } finally {
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`))
  }
}

async function runFallback(statements: string[]) {
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${SCHEMA}, public`))
    for (const s of statements) await tx.execute(sql.raw(s))
  })
}

describe('entrypoint schema fallback: error reporting', () => {
  it('creates the error tables exactly as schema.ts does, and runs again harmlessly', async () => {
    const statements = fallbackBlocks('Error reporting')
    await scratch(async () => {
      await runFallback(statements)
      for (const t of NEW_TABLES) {
        expect(await columns(SCHEMA, t), t).toEqual(await columns('public', t))
        expect(await constraints(SCHEMA, t), t).toEqual(await constraints('public', t))
        expect(await indexes(SCHEMA, t), t).toEqual(await indexes('public', t))
      }
      await runFallback(statements)
      expect(await constraints(SCHEMA, 'error_events')).toEqual(await constraints('public', 'error_events'))
    })
  })
})
