import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { errorSignatures, errorEvents, errorHourly, errorHourlyDims, errorHourlyUsers, errorReports } from '../src/db/schema.js'
import { purgeErrors, RAW_DAYS, COUNT_DAYS } from '../src/errors/retention.js'
import { resetDb } from './helpers/db.js'

const DAY = 86_400_000

describe('error retention', () => {
  beforeEach(async () => { await resetDb() })

  it('keeps raw events and user hashes 30 days and hourly counts 400 days', async () => {
    expect(RAW_DAYS).toBe(30)
    expect(COUNT_DAYS).toBe(400)
    const now = new Date('2026-11-08T12:00:00Z')
    const ago = (d: number) => new Date(now.getTime() - d * DAY)
    const [old] = await db.insert(errorSignatures).values({ hash: 'a', signature: 'a', source: 'web', kind: 'crash', firstSeenAt: ago(500), lastSeenAt: ago(450) }).returning()
    const [filed] = await db.insert(errorSignatures).values({ hash: 'b', signature: 'b', source: 'web', kind: 'crash', firstSeenAt: ago(500), lastSeenAt: ago(450), linearIssueId: 'lin' }).returning()
    const [live] = await db.insert(errorSignatures).values({ hash: 'c', signature: 'c', source: 'web', kind: 'crash', firstSeenAt: ago(40), lastSeenAt: ago(1) }).returning()
    const ev = (d: number) => ({ signatureId: live.id, occurredAt: ago(d), receivedAt: ago(d), source: 'web', kind: 'crash' })
    await db.insert(errorEvents).values([ev(31), ev(29)])
    await db.insert(errorHourly).values([{ signatureId: live.id, hour: ago(401), count: 1 }, { signatureId: live.id, hour: ago(31), count: 1 }])
    await db.insert(errorHourlyDims).values([{ signatureId: live.id, hour: ago(401), dim: 'os', value: 'x', count: 1 }, { signatureId: live.id, hour: ago(31), dim: 'os', value: 'x', count: 1 }])
    await db.insert(errorHourlyUsers).values([{ signatureId: live.id, hour: ago(31), userHash: 'u1' }, { signatureId: live.id, hour: ago(2), userHash: 'u2' }])
    await db.insert(errorReports).values([{ signatureId: live.id, description: 'old', payload: {}, createdAt: ago(401) }, { signatureId: live.id, description: 'new', payload: {}, createdAt: ago(3) }])

    const r = await purgeErrors(now)
    expect(r.events).toBe(1)
    expect((await db.select().from(errorEvents)).length).toBe(1)
    expect((await db.select().from(errorHourly)).length).toBe(1)
    expect((await db.select().from(errorHourlyDims)).length).toBe(1)
    expect((await db.select().from(errorHourlyUsers)).map((u) => u.userHash)).toEqual(['u2'])
    expect((await db.select().from(errorReports)).map((u) => u.description)).toEqual(['new'])
    // a long-quiet signature goes, unless it has its Linear issue
    expect((await db.select().from(errorSignatures)).map((s) => s.id).sort()).toEqual([filed.id, live.id].sort())
    expect(old.id).toBeTruthy()
  })
})
