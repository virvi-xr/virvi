import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { clearSchemaStatus, declaredColumns, missingColumns, schemaStatus } from '../src/db/schema-check.js'
import { testApp } from './helpers/factories.js'

/** /api/health says whether the database has everything schema.ts declares (production logs drop boot lines). */
describe('schema check', () => {
  beforeEach(() => clearSchemaStatus())
  afterEach(async () => {
    await db.execute(sql.raw('ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_dismissed_at TIMESTAMPTZ'))
    clearSchemaStatus()
  })

  it('knows the declared tables and columns, and the test database has them all', async () => {
    const cols = declaredColumns().map((c) => `${c.table}.${c.column}`)
    expect(cols).toContain('users.onboarding_dismissed_at')
    expect(cols).toContain('notification_settings.muted')
    expect(await missingColumns()).toEqual([])
    const app = await testApp()
    try {
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json().checks.schema).toBe('ok')
    } finally {
      await app.close()
    }
  })

  it('names a missing column, and is read at most once a minute', async () => {
    expect(await schemaStatus(1_000)).toBe('ok')
    await db.execute(sql.raw('ALTER TABLE users DROP COLUMN onboarding_dismissed_at'))
    expect(await schemaStatus(2_000)).toBe('ok') // cached
    expect(await schemaStatus(70_000)).toBe('missing: users.onboarding_dismissed_at')
  })
})
