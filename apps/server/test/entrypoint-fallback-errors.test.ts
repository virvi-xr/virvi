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
const NEW_TABLES = ['error_signatures', 'error_events', 'error_hourly', 'error_hourly_dims', 'error_hourly_users', 'error_reports', 'error_settings', 'error_budget', 'error_releases', 'error_ip_keys', 'error_prompt_state', 'error_prompt_asked', 'error_prompt_known']

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

  it('upgrades error tables made before fix round 1 (32-bit counters, hourly sampling) to the current shape', async () => {
    const statements = fallbackBlocks('Error reporting')
    await scratch(async () => {
      await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.error_signatures (LIKE public.error_signatures INCLUDING ALL)`))
      await db.execute(sql.raw(`ALTER TABLE ${SCHEMA}.error_signatures DROP COLUMN stored_day, DROP COLUMN stored_today, DROP COLUMN seen_users`))
      await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.error_hourly (signature_id UUID NOT NULL CONSTRAINT error_hourly_signature_id_error_signatures_id_fk REFERENCES ${SCHEMA}.error_signatures(id) ON DELETE CASCADE, hour TIMESTAMPTZ NOT NULL, count INTEGER NOT NULL DEFAULT 0, users INTEGER NOT NULL DEFAULT 0, stored INTEGER NOT NULL DEFAULT 0, CONSTRAINT error_hourly_signature_id_hour_pk PRIMARY KEY (signature_id, hour))`))
      await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.error_hourly_dims (signature_id UUID NOT NULL CONSTRAINT error_hourly_dims_signature_id_error_signatures_id_fk REFERENCES ${SCHEMA}.error_signatures(id) ON DELETE CASCADE, hour TIMESTAMPTZ NOT NULL, dim TEXT NOT NULL, value TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, CONSTRAINT error_hourly_dims_signature_id_hour_dim_value_pk PRIMARY KEY (signature_id, hour, dim, value))`))
      await runFallback(statements)
      for (const t of ['error_signatures', 'error_hourly', 'error_hourly_dims']) {
        expect(await columns(SCHEMA, t), t).toEqual(await columns('public', t))
      }
    })
  })

  it('upgrades phase-1 error tables to phase 2 (filing marker, Linear Done, screenshots, posted reports)', async () => {
    const statements = fallbackBlocks('Error reporting')
    await scratch(async () => {
      await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.error_signatures (LIKE public.error_signatures INCLUDING ALL)`))
      await db.execute(sql.raw(`ALTER TABLE ${SCHEMA}.error_signatures DROP COLUMN linear_filing_at, DROP COLUMN linear_done_at`))
      await db.execute(sql.raw(`CREATE TABLE ${SCHEMA}.error_reports (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), signature_id UUID NOT NULL CONSTRAINT error_reports_signature_id_error_signatures_id_fk REFERENCES ${SCHEMA}.error_signatures(id) ON DELETE CASCADE, user_id UUID CONSTRAINT error_reports_user_id_users_id_fk REFERENCES public.users(id) ON DELETE SET NULL, description TEXT NOT NULL, payload JSONB NOT NULL, release TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`))
      await runFallback(statements)
      for (const t of ['error_signatures', 'error_reports']) expect(await columns(SCHEMA, t), t).toEqual(await columns('public', t))
      expect(await indexes(SCHEMA, 'error_reports')).toEqual(await indexes('public', 'error_reports'))
    })
  })

  it('leaves 64-bit columns alone on later boots, so it never waits on a lock a running server holds (N3)', async () => {
    const statements = fallbackBlocks('Error reporting')
    await scratch(async () => {
      await runFallback(statements)
      let release!: () => void
      const held = new Promise<void>((r) => { release = r })
      let locked!: () => void
      const isLocked = new Promise<void>((r) => { locked = r })
      // Another session reading error_hourly (as a running flusher would) holds a share lock until released
      const holder = db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SELECT count(*) FROM ${SCHEMA}.error_hourly, ${SCHEMA}.error_signatures, ${SCHEMA}.error_hourly_dims`))
        locked()
        await held
      })
      await isLocked
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL lock_timeout = '300ms'`))
          await tx.execute(sql.raw(`SET LOCAL search_path TO ${SCHEMA}, public`))
          for (const s of statements) await tx.execute(sql.raw(s))
        })
      } finally {
        release()
        await holder
      }
    })
  })
})
