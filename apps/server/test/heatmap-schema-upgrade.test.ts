import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { resetDb } from './helpers/db.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { TEST_DATABASE_URL } from '../vitest.config'

type Con = { name: string; def: string }
/** The table's keys: its primary key or unique constraints, and its unique indexes. */
const constraints = async (): Promise<Con[]> =>
  ((await db.execute(sql`
    select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'analytics_heatmap_daily'::regclass and contype in ('p', 'u')
    union all
    select indexname, indexdef from pg_indexes where tablename = 'analytics_heatmap_daily' and indexdef like 'CREATE UNIQUE%'
      and indexname not in (select conname from pg_constraint where conrelid = 'analytics_heatmap_daily'::regclass)
    order by 1`)) as unknown as Con[])

/** analytics_heatmap_daily as it was before LIV-85: no cell_y, keyed by (scene_id, day, cell_x, cell_z). */
async function oldShape() {
  await db.execute(sql`alter table analytics_heatmap_daily drop constraint if exists analytics_heatmap_daily_cell_uq`)
  await db.execute(sql`drop index if exists analytics_heatmap_daily_cell_uq`)
  await db.execute(sql`alter table analytics_heatmap_daily drop column if exists cell_y`)
  await db.execute(sql`alter table analytics_heatmap_daily add constraint analytics_heatmap_daily_scene_id_day_cell_x_cell_z_pk primary key (scene_id, day, cell_x, cell_z)`)
}

/** The schema fallback in entrypoint.sh, as bash hands it to `node -e`. */
function fallbackScript(): string {
  const sh = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8')
  const start = sh.indexOf('node -e "')
  const end = sh.indexOf('" 2>&1 || echo "[virvi-server] SQL fallback had errors"')
  return execFileSync('bash', ['-c', `node() { printf '%s' "$2"; }; ${sh.slice(start, end + 1)}`], { encoding: 'utf8' })
}

describe('analytics_heatmap_daily height upgrade (LIV-85)', () => {
  let pushed: Con[] = []
  afterAll(async () => {
    // Leave the table as push made it for the files that run after this one.
    expect(await constraints()).toEqual(pushed)
  })

  it('push makes a unique index that includes cell_y, and no primary key', async () => {
    pushed = await constraints()
    expect(pushed).toEqual([
      { name: 'analytics_heatmap_daily_cell_uq', def: 'CREATE UNIQUE INDEX analytics_heatmap_daily_cell_uq ON public.analytics_heatmap_daily USING btree (scene_id, day, cell_x, cell_z, cell_y)' },
    ])
  })

  it('the pre-push upgrade turns the old table into that shape, keeping its rows, and is safe to run twice', async () => {
    await resetDb()
    await oldShape()
    const s = await createAnalyticsScene()
    await db.execute(sql`insert into analytics_heatmap_daily (scene_id, day, cell_x, cell_z, dwell_sec, visits) values (${s.id}, '2026-10-01', 1, 2, 30, 1)`)
    const script = fileURLToPath(new URL('../scripts/pre-push-upgrade.mjs', import.meta.url))
    for (let i = 0; i < 2; i++) execFileSync(process.execPath, [script], { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: 'pipe' })
    expect(await constraints()).toEqual(pushed)
    const rows = (await db.execute(sql`select cell_x, cell_y, cell_z, dwell_sec from analytics_heatmap_daily`)) as unknown as unknown[]
    expect(rows).toEqual([{ cell_x: 1, cell_y: null, cell_z: 2, dwell_sec: 30 }])
  })

  it("entrypoint.sh's fallback makes the same change", async () => {
    const script = fallbackScript()
    const start = script.indexOf('// Heatmap height (LIV-85)')
    expect(start).toBeGreaterThan(-1)
    const statements = [...script.slice(start, script.indexOf('} catch(e)', start)).matchAll(/await sql`([^`]*)`/g)].map((m) => m[1])
    expect(statements.length).toBeGreaterThan(0)
    await resetDb()
    await oldShape()
    for (const st of [...statements, ...statements]) await db.execute(sql.raw(st))
    expect(await constraints()).toEqual(pushed)
  })
})
