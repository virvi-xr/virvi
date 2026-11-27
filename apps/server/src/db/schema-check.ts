import { sql } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { db } from './connection.js'
import * as schema from './schema.js'

/**
 * Whether the database has every table and column schema.ts declares. Boot runs drizzle-kit push and a raw-SQL
 * fallback (entrypoint.sh), and push doesn't reliably add new tables or columns; production logs drop lines, so a
 * missing one used to go unnoticed until a route failed. /api/health reports this, read once a minute at most.
 * The schema is in the public repo, so naming what's missing gives nothing away.
 */
export function declaredColumns(): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = []
  for (const v of Object.values(schema)) {
    if (!(v instanceof PgTable)) continue
    const t = getTableConfig(v)
    if (t.schema && t.schema !== 'public') continue
    for (const c of t.columns) out.push({ table: t.name, column: c.name })
  }
  return out
}

export async function missingColumns(): Promise<string[]> {
  const rows = (await db.execute(sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`)) as unknown as Array<{ table_name: string; column_name: string }>
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`))
  return declaredColumns().map((c) => `${c.table}.${c.column}`).filter((k) => !have.has(k))
}

const EVERY_MS = 60_000
let cached: { at: number; value: string } | null = null

/** 'ok', or 'missing: a.b, c.d' (at most 10 named, then how many more). Never throws. */
export async function schemaStatus(now = Date.now()): Promise<string> {
  if (cached && now - cached.at < EVERY_MS) return cached.value
  let value: string
  try {
    const missing = await missingColumns()
    value = missing.length ? `missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}` : 'ok'
  } catch (err) {
    value = `unknown: ${err instanceof Error ? err.message : String(err)}`
  }
  cached = { at: now, value }
  return value
}

/** Tests: forget the cached answer. */
export function clearSchemaStatus(): void { cached = null }
