import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'

/**
 * The Design Studio wallet invites part of entrypoint.sh's schema fallback: run in a scratch schema on the invites
 * table as it was before, it makes email nullable and adds wallet, its open-invite index and the one-target check
 * exactly as drizzle-kit push made them from schema.ts.
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

/** The SQL of the `// <label>` block of the fallback, statement by statement. */
function fallbackBlock(label: string): string[] {
  const script = fallbackScript()
  const start = script.indexOf(`// ${label}`)
  expect(start, label).toBeGreaterThan(-1)
  const block = script.slice(start, script.indexOf('} catch(e)', start))
  return [...block.matchAll(/await sql`([^`]*)`/g)].map((m) => m[1])
}

const SCHEMA = 'fallback_wallet_invites'

const shape = async (schema: string) => {
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = 'studio_design_invites' AND column_name IN ('email', 'wallet') ORDER BY column_name`)
  const idx = await db.execute(sql`
    SELECT replace(indexdef, ${schema + '.'}, '') AS def FROM pg_indexes
    WHERE schemaname = ${schema} AND indexname = 'studio_design_invites_open_wallet_uq'`)
  const chk = await db.execute(sql`
    SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = ${schema} AND c.conname = 'studio_design_invites_one_target'`)
  return { cols, idx, chk }
}

describe('entrypoint schema fallback: Design Studio wallet invites', () => {
  it('makes the wallet columns, index and check exactly as schema.ts does, and runs again harmlessly', async () => {
    const statements = fallbackBlock('Design Studio invites by linked wallet')
    expect(statements).toHaveLength(4)
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`))
    await db.execute(sql.raw(`CREATE SCHEMA ${SCHEMA}`))
    try {
      // The table as it was before this feature, with an email invite in it
      await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.studio_design_invites (LIKE public.studio_design_invites INCLUDING ALL)`))
      await db.execute(sql.raw(`ALTER TABLE ${SCHEMA}.studio_design_invites DROP COLUMN wallet`))
      await db.execute(sql.raw(`ALTER TABLE ${SCHEMA}.studio_design_invites ALTER COLUMN email SET NOT NULL`))
      await db.execute(sql.raw(`INSERT INTO ${SCHEMA}.studio_design_invites (design_id, email, role, token, invited_by, expires_at)
        VALUES (gen_random_uuid(), 'a@b.co', 'viewer', 't1', gen_random_uuid(), NOW())`))
      const run = () => db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL search_path TO ${SCHEMA}, public`))
        for (const s of statements) await tx.execute(sql.raw(s))
      })
      await run()
      const want = await shape('public')
      expect(want.cols).toHaveLength(2)
      expect(want.idx).toHaveLength(1)
      expect(want.chk).toHaveLength(1)
      expect(await shape(SCHEMA)).toEqual(want)
      await run()
      expect(await shape(SCHEMA)).toEqual(want)
      const rows = await db.execute(sql.raw(`SELECT email, wallet FROM ${SCHEMA}.studio_design_invites`))
      expect([...rows]).toEqual([{ email: 'a@b.co', wallet: null }])
    } finally {
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`))
    }
  })
})
