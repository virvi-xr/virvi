import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'

/**
 * The Design Studio credit and MANA part of entrypoint.sh's schema fallback: run in a scratch schema, it makes the
 * five new tables, and the new columns of studio_payments, studio_entitlements and studio_mistake_reports, exactly as
 * drizzle-kit push made them from schema.ts.
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

const SCHEMA = 'fallback_mana'
const NEW_TABLES = ['studio_credits', 'studio_credit_ledger', 'studio_mana_transfers', 'studio_mana_scan', 'studio_mana_refunds']
const NEW_COLUMNS: Record<string, string[]> = {
  studio_payments: ['method', 'credit_held_cents', 'mana_amount_wei', 'mana_usd_rate', 'mana_tx_hash'],
  studio_entitlements: ['method', 'credit_cents'],
  studio_mistake_reports: ['credited_cents', 'mana_cents'],
}

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

describe('entrypoint schema fallback: Design Studio credit and MANA', () => {
  it('creates the five new tables exactly as schema.ts does', async () => {
    const statements = fallbackBlocks('Design Studio credit and MANA')
    await scratch(async () => {
      // The tables the new ones point at, in the scratch schema, as they were before this feature
      await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.studio_payments (LIKE public.studio_payments INCLUDING ALL)`))
      await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.studio_entitlements (LIKE public.studio_entitlements INCLUDING ALL)`))
      await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.studio_mistake_reports (LIKE public.studio_mistake_reports INCLUDING ALL)`))
      for (const [table, cols] of Object.entries(NEW_COLUMNS)) {
        for (const c of cols) await db.execute(sql.raw(`ALTER TABLE ${SCHEMA}.${table} DROP COLUMN ${c}`))
      }
      await runFallback(statements)
      for (const t of NEW_TABLES) {
        expect(await columns(SCHEMA, t), t).toEqual(await columns('public', t))
        expect(await constraints(SCHEMA, t), t).toEqual(await constraints('public', t))
        expect(await indexes(SCHEMA, t), t).toEqual(await indexes('public', t))
      }
      for (const [table, cols] of Object.entries(NEW_COLUMNS)) {
        const pick = (rows: Col[]) => rows.filter((r) => cols.includes(r.column_name))
        expect(pick(await columns(SCHEMA, table)), table).toEqual(pick(await columns('public', table)))
      }
      // studio_payments' unique hash and the partial unique index that keeps two open quotes from one amount
      const named = async (schema: string) => (await indexes(schema, 'studio_payments'))
        .filter((i) => ['studio_payments_mana_tx_hash_unique', 'studio_payments_mana_open_idx'].includes(i.indexname))
      expect(await named(SCHEMA)).toEqual(await named('public'))
      expect(await named(SCHEMA)).toHaveLength(2)
      // Running it again on boot changes nothing
      await runFallback(statements)
      expect(await constraints(SCHEMA, 'studio_mana_transfers')).toEqual(await constraints('public', 'studio_mana_transfers'))
    })
  })

  it('makes an earlier transfer or MANA-back table outlive its payment or report (ON DELETE SET NULL)', async () => {
    const statements = fallbackBlocks('Design Studio credit and MANA')
    await scratch(async () => {
      await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.studio_mana_transfers (tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, from_address TEXT NOT NULL, amount_wei TEXT NOT NULL, block_number BIGINT NOT NULL, payment_id UUID, status TEXT NOT NULL, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CONSTRAINT studio_mana_transfers_tx_hash_log_index_pk PRIMARY KEY (tx_hash, log_index))`))
      await db.execute(sql.raw(`ALTER TABLE ${SCHEMA}.studio_mana_transfers ADD CONSTRAINT studio_mana_transfers_payment_id_studio_payments_id_fk FOREIGN KEY (payment_id) REFERENCES public.studio_payments(id)`))
      await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.studio_mana_refunds (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE, report_id UUID, usd_cents INTEGER NOT NULL, to_address TEXT NOT NULL, status TEXT NOT NULL, mana_amount_wei TEXT, tx_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ, decided_by UUID)`))
      await db.execute(sql.raw(`ALTER TABLE ${SCHEMA}.studio_mana_refunds ADD CONSTRAINT studio_mana_refunds_report_id_studio_mistake_reports_id_fk FOREIGN KEY (report_id) REFERENCES public.studio_mistake_reports(id)`))
      await runFallback(statements.filter((s) => !/ALTER TABLE studio_(payments|entitlements|mistake_reports) /.test(s) && !/ON studio_payments /.test(s)))
      const fk = async (table: string) => (await constraints(SCHEMA, table)).filter((c) => (c as { contype: string }).contype === 'f')
      expect(await fk('studio_mana_transfers')).toEqual([expect.objectContaining({ def: expect.stringContaining('ON DELETE SET NULL') })])
      expect((await fk('studio_mana_refunds')).find((c) => String((c as { def: string }).def).includes('report_id')))
        .toMatchObject({ def: expect.stringContaining('ON DELETE SET NULL') })
    })
  })
})
