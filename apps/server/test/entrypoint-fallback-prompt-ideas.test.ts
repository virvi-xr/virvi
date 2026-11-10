import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'

/**
 * The Design Studio prompt ideas part of entrypoint.sh's schema fallback: run in a scratch schema, it makes
 * studio_idea_uses exactly as drizzle-kit push made it from schema.ts (columns, primary key and foreign keys).
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

const SCHEMA = 'fallback_prompt_ideas'

const columns = async (schema: string) => db.execute(sql`
  SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
  WHERE table_schema = ${schema} AND table_name = 'studio_idea_uses' ORDER BY column_name`)
const constraints = async (schema: string) => db.execute(sql`
  SELECT c.conname, c.contype, c.confdeltype, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = ${schema} AND t.relname = 'studio_idea_uses' ORDER BY c.conname`)

describe('entrypoint schema fallback: Design Studio prompt ideas', () => {
  it('makes the table exactly as schema.ts does, and runs again harmlessly', async () => {
    const statements = fallbackBlocks('Design Studio prompt ideas')
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`))
    await db.execute(sql.raw(`CREATE SCHEMA ${SCHEMA}`))
    try {
      const run = () => db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL search_path TO ${SCHEMA}, public`))
        for (const s of statements) await tx.execute(sql.raw(s))
      })
      await run()
      expect(await columns(SCHEMA)).toEqual(await columns('public'))
      expect(await columns(SCHEMA)).toHaveLength(4)
      // the primary key's name differs by schema only in what Postgres picks, so it is compared by kind and definition
      const strip = (rows: unknown) => (rows as { conname: string; contype: string; confdeltype: string; def: string }[])
        .map((r) => ({ ...r, conname: r.contype === 'p' ? 'pkey' : r.conname }))
      expect(strip(await constraints(SCHEMA))).toEqual(strip(await constraints('public')))
      await run()
      expect(await columns(SCHEMA)).toEqual(await columns('public'))
    } finally {
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`))
    }
  })
})
