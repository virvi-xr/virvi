import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'

/**
 * The scene import part of entrypoint.sh's schema fallback (I8). main's entrypoint-fallback.test.ts checks the whole
 * script reaches Node as valid JavaScript; this one runs the import statements and compares them with what push made.
 */

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

/** The SQL of one `// <label>` block of the fallback, statement by statement. */
function fallbackBlock(label: string): string[] {
  const script = fallbackScript()
  const start = script.indexOf(`// ${label}`)
  expect(start, label).toBeGreaterThan(-1)
  const block = script.slice(start, script.indexOf('} catch(e)', start))
  return [...block.matchAll(/await sql`([^`]*)`/g)].map((m) => m[1])
}

describe('entrypoint schema fallback: scene imports', () => {
  const SCHEMA = 'fallback_check'
  type Col = { table_name: string; column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null }
  const columns = async (schema: string, table: string) => (await db.execute(sql`
    SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${table} ORDER BY column_name`) as unknown as Col[])
    .map((c) => ({ ...c, table_name: undefined, column_default: c.column_default?.replace(`${schema}.`, '') ?? null }))
  const foreignKeys = async (schema: string, table: string) => (await db.execute(sql`
    SELECT a.attname AS col, c.confdeltype AS on_delete, c.confrelid::regclass::text AS target
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.conrelid = ${`${schema}.${table}`}::regclass ORDER BY a.attname`) as unknown as object[])
  const indexes = async (schema: string, table: string) => (await db.execute(sql`
    SELECT indexname, regexp_replace(indexdef, ' ON [a-z_]+\.', ' ON ') AS def FROM pg_indexes WHERE schemaname = ${schema} AND tablename = ${table} ORDER BY indexname`) as unknown as object[])

  it('the whole fallback still reaches Node as valid JavaScript', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'entrypoint-')), 'fallback.js')
    writeFileSync(file, fallbackScript())
    expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow()
  })

  it('creates the enum, scene_imports and pending_import_id exactly as schema.ts does', async () => {
    const statements = fallbackBlock('Scene imports')
    expect(statements.some((s) => s.includes('pending_import_id'))).toBe(true)
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`))
    await db.execute(sql.raw(`CREATE SCHEMA ${SCHEMA}`))
    try {
      // The fallback runs where the tables it references already exist; scene_imports lands in the scratch schema
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL search_path TO ${SCHEMA}, public`))
        for (const s of statements) await tx.execute(sql.raw(s))
      })
      const enumOf = async (schema: string) => (await db.execute(sql`
        SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'scene_import_status' AND n.nspname = ${schema} ORDER BY e.enumsortorder`) as unknown as object[])
      expect(await enumOf(SCHEMA)).toEqual(await enumOf('public'))
      expect(await columns(SCHEMA, 'scene_imports')).toEqual(await columns('public', 'scene_imports'))
      const fks = (rows: object[]) => rows.map((r) => ({ ...r, target: String((r as { target: string }).target).replace(`${SCHEMA}.`, '') }))
      expect(fks(await foreignKeys(SCHEMA, 'scene_imports'))).toEqual(fks(await foreignKeys('public', 'scene_imports')))
      expect((await indexes(SCHEMA, 'scene_imports')).length).toBe((await indexes('public', 'scene_imports')).length)
      expect(await indexes(SCHEMA, 'scene_imports')).toEqual(await indexes('public', 'scene_imports'))
      // The column statement matches the pushed one (it is a no-op here, since push already made it)
      const pending = statements.find((s) => s.includes('pending_import_id'))!
      expect(pending).toMatch(/ADD COLUMN IF NOT EXISTS pending_import_id UUID REFERENCES scene_imports\(id\) ON DELETE SET NULL/)
    } finally {
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`))
    }
  })
})
