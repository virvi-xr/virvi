import { createSigner } from 'fast-jwt'
import { eq } from 'drizzle-orm'
import { db } from '../../src/db/connection.js'
import {
  users,
  userAuthMethods,
  scenes,
  scenePresets,
  sceneElements,
  sceneElementInstances,
} from '../../src/db/schema.js'
import { buildApp } from '../../src/app.js'

const sign = createSigner({ key: 'test-secret', expiresIn: 15 * 60 * 1000 })
const signNoExpiry = createSigner({ key: 'test-secret' })

export type TestUser = typeof users.$inferSelect & { wallet: string | null }

let counter = 0
export function randomWallet() {
  counter++
  return ('0x' + counter.toString(16).padStart(8, '0') + crypto.randomUUID().replace(/-/g, '')).slice(0, 42)
}

export async function createUser(
  opts: { role?: 'admin' | 'creator' | 'viewer'; email?: string | null; wallet?: string | null; name?: string; emailVerified?: boolean } = {},
): Promise<TestUser> {
  const [user] = await db
    .insert(users)
    .values({
      displayName: opts.name ?? 'Test User',
      email: opts.email === undefined ? `u${Date.now()}${Math.random()}@test.dev` : opts.email,
      role: opts.role ?? 'creator',
      // Confirmed unless a test says otherwise (LIV-161): most tests aren't about verification
      emailVerifiedAt: opts.emailVerified === false ? null : new Date(),
    })
    .returning()
  const wallet = opts.wallet ? opts.wallet.toLowerCase() : null
  if (wallet) {
    await db.insert(userAuthMethods).values({
      userId: user.id,
      type: 'wallet',
      identifier: wallet,
      metadata: { verified: true },
    })
  }
  return { ...user, wallet }
}

export function tokenFor(user: TestUser, extra: Record<string, unknown> = {}) {
  return sign({
    id: user.id,
    email: user.email,
    role: user.role,
    orgId: null,
    wallet: user.wallet,
    verified: true,
    kind: 'account',
    ...extra,
  })
}

export function expiredTokenFor(user: TestUser) {
  return signNoExpiry({
    id: user.id,
    email: user.email,
    role: user.role,
    wallet: user.wallet,
    verified: true,
    kind: 'account',
    exp: Math.floor(Date.now() / 1000) - 60,
  })
}

export async function createScene(owner: TestUser, name = 'Venue Scene') {
  const [scene] = await db.insert(scenes).values({ ownerId: owner.id, name }).returning()
  const [preset] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Default' }).returning()
  await db.update(scenes).set({ activePresetId: preset.id }).where(eq(scenes.id, scene.id))
  return { scene: { ...scene, activePresetId: preset.id }, preset }
}

export async function createElement(
  presetId: string,
  opts: { type?: 'image' | 'video' | 'sound' | 'widget' | 'model' | 'ad_space' | 'claim_point'; name?: string; properties?: Record<string, unknown> } = {},
) {
  const [element] = await db
    .insert(sceneElements)
    .values({
      presetId,
      type: opts.type ?? 'video',
      name: opts.name ?? 'Main Screen',
      properties: opts.properties ?? { liveSrc: 'https://old.example/live.m3u8', playlist: [] },
    })
    .returning()
  return element
}

export async function createInstance(elementId: string) {
  const [instance] = await db
    .insert(sceneElementInstances)
    .values({ elementId, position: { x: 1, y: 1, z: 1 } })
    .returning()
  return instance
}

export async function testApp() {
  const app = await buildApp({ rateLimit: false, logger: false, backfill: false })
  await app.ready()
  return app
}
