import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { hyperfyWorlds, subscriptions } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { TIER_LIMITS } from '../src/integrations/stripe.js'
import { hostedWorldSlots } from '../src/hyperfy/slots.js'
import { worldSummary } from '../src/hyperfy/worlds.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, type TestUser } from './helpers/factories.js'

describe('hosted Hyperfy world slots', () => {
  let owner: TestUser
  let sceneId: string

  const unlocked = config.allFeaturesUnlocked
  afterEach(() => { config.allFeaturesUnlocked = unlocked })

  beforeEach(async () => {
    config.allFeaturesUnlocked = false
    await resetDb()
    owner = await createUser()
    sceneId = (await createScene(owner, 'World')).scene.id
  })

  let n = 0
  const addWorld = (values: Partial<typeof hyperfyWorlds.$inferInsert> = {}) => {
    n += 1
    return db
      .insert(hyperfyWorlds)
      .values({ sceneId, ownerId: owner.id, name: `W${n}`, keyHash: `hash-${n}`, keyPrefix: 'virviw_xxxxxxx', ...values })
      .returning()
      .then((r) => r[0])
  }

  it('the limit is Infinity when all features are unlocked (R2)', async () => {
    await db.insert(subscriptions).values({ userId: owner.id, tier: 'creator' })
    config.allFeaturesUnlocked = true
    expect(await hostedWorldSlots(owner.id)).toEqual({ used: 0, limit: Infinity })
  })

  it('TIER_LIMITS hyperfyInstances are 1, 1, 3, 10 and Infinity', () => {
    expect(TIER_LIMITS.free.hyperfyInstances).toBe(1) // everyone can host one world from the wizard
    expect(TIER_LIMITS.creator.hyperfyInstances).toBe(1)
    expect(TIER_LIMITS.pro.hyperfyInstances).toBe(3)
    expect(TIER_LIMITS.studio.hyperfyInstances).toBe(10)
    expect(TIER_LIMITS.enterprise.hyperfyInstances).toBe(Infinity)
  })

  it('slots count provisioning and running hosted worlds, not failed, ended, purged or self-run', async () => {
    await db.insert(subscriptions).values({ userId: owner.id, tier: 'pro' })
    await addWorld({ kind: 'hosted', slug: 'running-one', status: 'running' })
    await addWorld({ kind: 'hosted', slug: 'provisioning-one', status: 'provisioning' })
    await addWorld({ kind: 'hosted', slug: 'failed-one', status: 'failed' })
    await addWorld({ kind: 'hosted', slug: 'ended-one', status: 'ended', endedAt: new Date() })
    await addWorld({ kind: 'hosted', slug: 'purged-one', status: 'ended', purgedAt: new Date() })
    await addWorld({ kind: 'hosted', slug: 'purged-failed', status: 'failed', purgedAt: new Date() })
    await addWorld({ kind: 'self' })
    expect(await hostedWorldSlots(owner.id)).toEqual({ used: 2, limit: 3 })

    const other = await createUser()
    expect(await hostedWorldSlots(other.id)).toEqual({ used: 0, limit: 1 })
  })

  it('a slug can be reused once the world holding it is purged, but not while it exists', async () => {
    const first = await addWorld({ kind: 'hosted', slug: 'taken' })
    await expect(addWorld({ kind: 'hosted', slug: 'taken' })).rejects.toThrow()
    await db.update(hyperfyWorlds).set({ purgedAt: new Date() }).where(eq(hyperfyWorlds.id, first.id))
    await expect(addWorld({ kind: 'hosted', slug: 'taken' })).resolves.toBeTruthy()
  })

  it('summary of a self-run world has kind self, status running and null hosting fields', async () => {
    const row = await addWorld()
    expect(worldSummary(row)).toMatchObject({
      id: row.id,
      kind: 'self',
      status: 'running',
      address: null,
      errorMessage: null,
      endsAt: null,
      endedAt: null,
      purgeAfter: null,
    })
  })

  it('summary of a hosted world carries its address, status and dates', async () => {
    const endsAt = new Date('2027-01-01T00:00:00Z')
    const row = await addWorld({ kind: 'hosted', slug: 'hosted-a', address: 'vlm-w-hosted-a.fly.dev', status: 'failed', errorMessage: 'boom', endsAt })
    expect(worldSummary(row)).toMatchObject({
      kind: 'hosted',
      address: 'vlm-w-hosted-a.fly.dev',
      status: 'failed',
      errorMessage: 'boom',
      endsAt: endsAt.toISOString(),
      endedAt: null,
      purgeAfter: null,
    })
  })
})
