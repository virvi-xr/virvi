import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser } from './helpers/factories.js'
import { TEST_DATABASE_URL } from '../vitest.config'

/**
 * LIV-211: the boot's pre-push upgrade dropped every scene_state table, so each deploy wiped the scenes' saved state
 * (LIV-158). It must drop only v1's per-user table (with user_id) and keep today's, rows and all.
 */
const script = fileURLToPath(new URL('../scripts/pre-push-upgrade.mjs', import.meta.url))
const runUpgrade = () => execFileSync(process.execPath, [script], { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: 'pipe' })
const columns = async () => ((await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'scene_state' ORDER BY 1`)) as unknown as { column_name: string }[]).map((c) => c.column_name)

describe('pre-push upgrade and scene_state', () => {
  it("keeps today's scene_state and its rows", async () => {
    await resetDb()
    const { scene } = await createScene(await createUser())
    await db.execute(sql`INSERT INTO scene_state (scene_id, key, value) VALUES (${scene.id}, 'round', '3'::jsonb)`)
    runUpgrade()
    expect(await columns()).toEqual(['key', 'scene_id', 'updated_at', 'value'])
    const rows = (await db.execute(sql`SELECT key, value FROM scene_state`)) as unknown as unknown[]
    expect(rows).toEqual([{ key: 'round', value: 3 }])
  })

  it("drops v1's per-user scene_state, so push can make today's", async () => {
    const saved = await columns()
    await db.execute(sql`ALTER TABLE scene_state RENAME TO scene_state_now`)
    try {
      await db.execute(sql`CREATE TABLE scene_state (scene_id uuid NOT NULL, user_id uuid NOT NULL, key text NOT NULL, value jsonb)`)
      runUpgrade()
      expect(await columns()).toEqual([])
    } finally {
      await db.execute(sql`DROP TABLE IF EXISTS scene_state`)
      await db.execute(sql`ALTER TABLE scene_state_now RENAME TO scene_state`)
    }
    expect(await columns()).toEqual(saved)
  })
})
