/**
 * Development seed script
 *
 * Creates a test user with a scene containing video, image, and sound elements.
 * Run: pnpm db:seed (from apps/server)
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import bcrypt from 'bcryptjs'
import * as schema from './schema.js'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const sql = postgres(DATABASE_URL)
const db = drizzle(sql, { schema })

async function seed() {
  console.log('Seeding database...')

  // ── Create test user ──
  const passwordHash = await bcrypt.hash('password123', 12)

  const [user] = await db
    .insert(schema.users)
    .values({
      displayName: 'Test User',
      email: 'test@virvi.io',
      role: 'admin',
    })
    .returning()

  await db.insert(schema.userAuthMethods).values({
    userId: user.id,
    type: 'email',
    identifier: 'test@virvi.io',
    credentialHash: passwordHash,
  })

  console.log(`  Created user: ${user.email} (${user.id})`)

  // ── Create test scene ──
  const [scene] = await db
    .insert(schema.scenes)
    .values({
      ownerId: user.id,
      name: 'Demo Scene',
      description: 'A test scene with video, image, and sound elements',
    })
    .returning()

  // ── Create default preset ──
  const [preset] = await db
    .insert(schema.scenePresets)
    .values({
      sceneId: scene.id,
      name: 'Default',
    })
    .returning()

  // Set active preset
  const { eq } = await import('drizzle-orm')
  await db
    .update(schema.scenes)
    .set({ activePresetId: preset.id })
    .where(eq(schema.scenes.id, scene.id))

  console.log(`  Created scene: ${scene.name} (${scene.id})`)
  console.log(`  Created preset: ${preset.name} (${preset.id})`)

  // ── Create video element ──
  const [videoElement] = await db
    .insert(schema.sceneElements)
    .values({
      presetId: preset.id,
      type: 'video',
      name: 'Main Screen',
      enabled: true,
      customId: 'main-screen',
      properties: {
        liveSrc: 'https://d3rlna7iyyu8wu.cloudfront.net/skip_armstrong/skip_armstrong_stereo_subs.m3u8',
        isLive: false,
        enableLiveStream: true,
        offImageSrc: 'https://via.placeholder.com/1920x1080/1a1a2e/ffffff?text=Stream+Offline',
        offType: 1,
        playlist: [],
        volume: 0.8,
        emission: 0.6,
      },
    })
    .returning()

  const [videoInstance] = await db
    .insert(schema.sceneElementInstances)
    .values({
      elementId: videoElement.id,
      enabled: true,
      customId: 'main-screen-1',
      position: { x: 8, y: 3, z: 8 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 8, y: 4.5, z: 0.01 },
      withCollisions: false,
    })
    .returning()

  console.log(`  Created video: ${videoElement.name} (${videoElement.id})`)

  // ── Create image element ──
  const [imageElement] = await db
    .insert(schema.sceneElements)
    .values({
      presetId: preset.id,
      type: 'image',
      name: 'Welcome Banner',
      enabled: true,
      customId: 'welcome-banner',
      properties: {
        textureSrc: 'https://via.placeholder.com/1024x512/2d2d44/ffffff?text=Welcome+to+Virvi',
        emission: 1.0,
        isTransparent: false,
      },
    })
    .returning()

  const [imageInstance] = await db
    .insert(schema.sceneElementInstances)
    .values({
      elementId: imageElement.id,
      enabled: true,
      customId: 'welcome-banner-1',
      position: { x: 4, y: 2, z: 12 },
      rotation: { x: 0, y: 90, z: 0 },
      scale: { x: 4, y: 2, z: 0.01 },
      withCollisions: false,
    })
    .returning()

  console.log(`  Created image: ${imageElement.name} (${imageElement.id})`)

  // ── Create sound element ──
  const [soundElement] = await db
    .insert(schema.sceneElements)
    .values({
      presetId: preset.id,
      type: 'sound',
      name: 'Ambient Music',
      enabled: true,
      customId: 'ambient-music',
      properties: {
        audioSrc: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
        volume: 0.3,
        sourceType: 1, // LOOP
      },
    })
    .returning()

  const [soundInstance] = await db
    .insert(schema.sceneElementInstances)
    .values({
      elementId: soundElement.id,
      enabled: true,
      position: { x: 8, y: 1, z: 8 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      withCollisions: false,
    })
    .returning()

  console.log(`  Created sound: ${soundElement.name} (${soundElement.id})`)

  // ── Summary ──
  console.log('\nSeed complete!')
  console.log(`  Scene ID: ${scene.id}`)
  console.log(`  Preset ID: ${preset.id}`)
  console.log(`  Login: test@virvi.io / password123`)

  await sql.end()
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
