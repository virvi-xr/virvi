import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { scenes } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser } from './helpers/factories.js'

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

describe('entrypoint schema fallback', () => {
  it('reaches Node as valid JavaScript', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'entrypoint-')), 'fallback.js')
    writeFileSync(file, fallbackScript())
    expect(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })).not.toThrow()
  })

  it('adds the scene thumbnail columns (LIV-88) as schema.ts has them', () => {
    const script = fallbackScript()
    expect(script).toContain('ALTER TABLE scenes ADD COLUMN IF NOT EXISTS thumbnail_key TEXT')
    expect(script).toContain('ALTER TABLE scenes ADD COLUMN IF NOT EXISTS thumbnail_bytes INTEGER')
  })

  it('adds scenes.thumbnail_source (LIV-89) and marks the thumbnails from before it as uploads', async () => {
    const script = fallbackScript()
    const start = script.indexOf('// Scene thumbnail (LIV-88)')
    const statements = [...script.slice(start, script.indexOf('} catch(e)', start)).matchAll(/await sql`([^`]*)`/g)].map((m) => m[1])
    expect(statements).toContain('ALTER TABLE scenes ADD COLUMN IF NOT EXISTS thumbnail_source TEXT')
    await resetDb()
    const user = await createUser()
    const uploaded = (await createScene(user)).scene
    const imported = (await createScene(user)).scene
    const none = (await createScene(user)).scene
    await db.update(scenes).set({ thumbnailKey: 'scenes/a/thumbnail-0123456789abcdef.png' }).where(eq(scenes.id, uploaded.id))
    await db.update(scenes).set({ thumbnailKey: 'scenes/b/thumbnail-0123456789abcdef.png', thumbnailSource: 'import' }).where(eq(scenes.id, imported.id))
    // Twice: it runs on every boot
    for (const st of [...statements, ...statements]) await db.execute(sql.raw(st))
    const source = async (id: string) => (await db.query.scenes.findFirst({ where: eq(scenes.id, id) }))!.thumbnailSource
    expect([await source(uploaded.id), await source(imported.id), await source(none.id)]).toEqual(['upload', 'import', null])
  })

  it('keeps the quotes on room_sets."offset", a reserved word in SQL', () => {
    expect(fallbackScript()).toContain('"offset" JSONB NOT NULL')
  })
})
