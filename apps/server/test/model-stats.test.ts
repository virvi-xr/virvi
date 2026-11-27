import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { Document, NodeIO } from '@gltf-transform/core'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { modelStats } from '../src/db/schema.js'
import { measureGlb, measurementsSettled, setModelFetcher } from '../src/scenes/model-stats.js'
import { modelsInScene } from '../src/services/dcl/assemble.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'

/** Measuring models' triangles and textures from their GLBs (LIV-41). */

const CDN = 'https://cdn.virvi.test'
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: '#888' } }).png().toBuffer()

/** A GLB with one triangle mesh of `tris` triangles (plus a collider) and one texture per size given. */
async function glb(tris: number, textures: [number, number][]): Promise<Uint8Array> {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array(tris * 9)).setBuffer(buffer)
  const prim = doc.createPrimitive().setAttribute('POSITION', pos)
  const material = doc.createMaterial()
  for (const [w, h] of textures) material.setBaseColorTexture(doc.createTexture().setImage(new Uint8Array(await png(w, h))).setMimeType('image/png'))
  prim.setMaterial(material)
  const collider = doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(900)).setBuffer(buffer))
  const scene = doc.createScene()
  scene.addChild(doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(prim)))
  scene.addChild(doc.createNode('wall_collider').setMesh(doc.createMesh('wall_collider').addPrimitive(collider)))
  doc.getRoot().setDefaultScene(scene)
  return new NodeIO().writeBinary(doc)
}

describe('measureGlb', () => {
  it('counts drawn triangles (not colliders) and each texture’s size and memory, mipmaps included', async () => {
    const cost = await measureGlb(await glb(12, [[2048, 1024], [256, 256]]))
    expect(cost.triangles).toBe(12)
    expect(cost.textureCount).toBe(2)
    expect(cost.maxTexturePx).toBe(2048)
    // RGBA with a full mip chain: about 4/3 of width × height × 4
    expect(cost.textureBytes).toBeGreaterThan(2048 * 1024 * 4)
    expect(cost.textureBytes).toBeLessThan((2048 * 1024 + 256 * 256) * 4 * 1.4)
  })

  it('throws on a file that is not a GLB', async () => {
    await expect(measureGlb(new TextEncoder().encode('not a model'))).rejects.toThrow()
  })
})

describe('scene budget with measured models', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let savedCdn: string | null
  beforeEach(async () => {
    await resetDb()
    savedCdn = config.cdnUrl
    ;(config as { cdnUrl: string | null }).cdnUrl = CDN
    app = await testApp()
  })
  afterEach(async () => {
    setModelFetcher(null)
    ;(config as { cdnUrl: string | null }).cdnUrl = savedCdn
    await app.close()
  })

  it('measures unmeasured models in the background, then counts their triangles and textures', async () => {
    const files: Record<string, Uint8Array> = {
      [`${CDN}/m/Statue.glb`]: await glb(3_000, [[2048, 2048]]),
      [`${CDN}/m/Broken.glb`]: new TextEncoder().encode('nope'),
    }
    const fetched: string[] = []
    setModelFetcher(async (url) => { fetched.push(url); return files[url] })
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    const statue = await createElement(preset.id, { type: 'model', name: 'Statue', properties: { modelSrc: `${CDN}/m/Statue.glb` } })
    await createInstance(statue.id)
    await createInstance(statue.id)
    await createElement(preset.id, { type: 'model', name: 'Broken', properties: { modelSrc: `${CDN}/m/Broken.glb` } })
    await createElement(preset.id, { type: 'model', name: 'Elsewhere', properties: { modelSrc: 'https://example.com/x.fbx' } })
    const get = async () => (await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/health`, headers: { authorization: `Bearer ${tokenFor(host)}` } })).json()

    const first = await get()
    expect(first.measuring).toBe(2)
    expect(first.textureMemory).toEqual({ bytes: 0, textures: 0 })
    await measurementsSettled()

    const second = await get()
    expect(second.measuring).toBe(0)
    const tris = second.targets[0].metrics.find((m: any) => m.key === 'triangles')
    expect(tris.used).toBe(6_000) // 3,000 per copy × 2 copies, now that it's measured
    expect(second.targets[0].metrics.find((m: any) => m.key === 'textures')).toMatchObject({ used: 1, limit: 10, state: 'within', blocks: false })
    expect(second.textureMemory.textures).toBe(1)
    expect(second.textureMemory.bytes).toBeGreaterThan(2048 * 2048 * 4)
    expect(second.byTextureMemory[0]).toMatchObject({ name: 'Statue', maxTexturePx: 2048 })
    expect(second.suggestions.some((s: string) => s.startsWith('"Statue" has a 2048 px texture') && s.includes('three quarters'))).toBe(true)

    // A file that couldn't be read is recorded, and never fetched again
    const broken = (await db.select().from(modelStats)).find((r) => r.url.endsWith('Broken.glb'))!
    expect(broken.error).toBeTruthy()
    await get()
    await measurementsSettled()
    expect(fetched.filter((u) => u.endsWith('Broken.glb'))).toHaveLength(1)
    // …until a day has passed
    await db.update(modelStats).set({ measuredAt: new Date(Date.now() - 25 * 60 * 60_000) }).where(eq(modelStats.url, broken.url))
    await get()
    await measurementsSettled()
    expect(fetched.filter((u) => u.endsWith('Broken.glb'))).toHaveLength(2)

    // The deploy check reads the measured triangles too
    expect((await modelsInScene(scene.id)).find((m) => m.name === 'Statue')).toMatchObject({ triangles: 3_000, textures: { count: 1, maxPx: 2048 } })
  })
})
