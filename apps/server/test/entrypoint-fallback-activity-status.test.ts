import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'

/**
 * The scene activity (LIV-32) and status page (LIV-40) parts of entrypoint.sh's schema fallback: run in a scratch schema,
 * they make the tables exactly as drizzle-kit push makes them from schema.ts, and run again harmlessly.
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

const SCHEMA = 'fallback_activity_status'

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

describe('entrypoint schema fallback: scene activity and status page', () => {
  it.each([
    ['Scene activity', ['scene_activity']],
    ['Status page', ['status_checks', 'status_incidents', 'status_incident_updates']],
    ['Model stats', ['model_stats']],
    ['Moderation', ['moderation_actions', 'moderation_appeals']],
  ])('%s: creates the tables exactly as schema.ts does, and runs again harmlessly', async (label, tables) => {
    const statements = fallbackBlocks(label)
    await scratch(async () => {
      await runFallback(statements)
      for (const t of tables) {
        expect(await columns(SCHEMA, t), t).toEqual(await columns('public', t))
        expect(await constraints(SCHEMA, t), t).toEqual(await constraints('public', t))
        expect(await indexes(SCHEMA, t), t).toEqual(await indexes('public', t))
      }
      await runFallback(statements)
    })
  })
})
