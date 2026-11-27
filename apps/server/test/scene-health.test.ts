import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, dclWorldDestinations, sceneRoles } from '../src/db/schema.js'
import { budgetFor, suggestionsFor } from '../src/scenes/health.js'
import type { ModelNeed } from '../src/services/dcl/assemble.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, randomWallet } from './helpers/factories.js'

/** Scene performance budgets (LIV-41). */

const CDN = 'https://cdn.virvi.test'
const need = (name: string, triangles: number | null, bytes: number | null, instances: number): ModelNeed => ({
  elementId: name, name, url: `${CDN}/m/${name}.glb`, file: `models/virvi/${name}.glb`, triangles, bytes, instances,
})
const metric = (r: ReturnType<typeof budgetFor>, key: string) => r.metrics.find((m) => m.key === key)!

describe('scene budget', () => {
  it("counts triangles per copy, entities per copy plus frames, and size once per file, against one parcel's limits", () => {
    const r = budgetFor([need('Chair', 1_000, 2_000_000, 3), need('Lamp', null, null, 1)], 4, { kind: 'parcels', parcels: 1 })
    expect(metric(r, 'triangles')).toEqual({ key: 'triangles', used: 3_000, limit: 10_000, state: 'within', blocks: false })
    expect(metric(r, 'entities')).toEqual({ key: 'entities', used: 8, limit: 180, state: 'within', blocks: true })
    expect(metric(r, 'bytes')).toMatchObject({ used: 2_000_000, limit: 15 * 1024 * 1024, blocks: true })
    expect(r.state).toBe('within')
  })

  it('is close from 80% of a limit, over above it, and the worst metric wins', () => {
    expect(budgetFor([need('A', 8_000, 1, 1)], 0, { kind: 'parcels', parcels: 1 }).state).toBe('close')
    const over = budgetFor([need('A', 10_001, 1, 1)], 0, { kind: 'parcels', parcels: 1 })
    expect(over.state).toBe('over')
    expect(metric(over, 'triangles').state).toBe('over')
    // More parcels, more room
    expect(budgetFor([need('A', 10_001, 1, 1)], 0, { kind: 'parcels', parcels: 2 }).state).toBe('within')
  })

  it("a World has no fixed size limit (its storage is the owner's, checked at deploy)", () => {
    const r = budgetFor([need('A', 1, 500 * 1024 * 1024, 1)], 0, { kind: 'world', parcels: 1 })
    expect(metric(r, 'bytes')).toMatchObject({ limit: null, state: 'within', blocks: false })
  })

  it('suggests fixes only for what is close or over, naming the biggest contributor', () => {
    const models = [need('Statue', 9_000, 1_000, 1), need('Rug', 100, 1_000, 1)]
    const targets = [{ id: null, name: 'One parcel', kind: 'none' as const, parcels: 1, ...budgetFor(models, 0, { kind: 'none', parcels: 1 }) }]
    expect(suggestionsFor(targets, models, 0)).toEqual(['Use a lower-detail version of "Statue" (9,000 triangles), or place fewer copies of it.'])
    const fine = [{ id: null, name: 'One parcel', kind: 'none' as const, parcels: 1, ...budgetFor([need('Rug', 100, 1_000, 1)], 0, { kind: 'none', parcels: 1 }) }]
    expect(suggestionsFor(fine, [need('Rug', 100, 1_000, 1)], 0)).toEqual([])
    const huge = [need('Castle', 10, 60 * 1024 * 1024, 1)]
    const big = [{ id: null, name: 'One parcel', kind: 'none' as const, parcels: 1, ...budgetFor(huge, 0, { kind: 'none', parcels: 1 }) }]
    const tips = suggestionsFor(big, huge, 0)
    expect(tips[0]).toMatch(/^Make "Castle" smaller \(60\.0 MB\)/)
    expect(tips[1]).toMatch(/over Decentraland's 50 MB limit for one file/)
  })
})

describe('GET /api/scenes/:sceneId/health', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let savedCdn: string | null
  beforeEach(async () => {
    await resetDb()
    savedCdn = config.cdnUrl
    ;(config as { cdnUrl: string | null }).cdnUrl = CDN
    app = await testApp()
  })
  afterEach(async () => {
    ;(config as { cdnUrl: string | null }).cdnUrl = savedCdn
    await app.close()
  })

  it("reports each destination's budget and the biggest models; editors can read it, viewers can't", async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    const url = `${CDN}/m/Statue.glb`
    await db.insert(assetLibraryItems).values({ name: 'Statue', cdnUrl: url, storageKey: 'k', fileSizeBytes: 3_000_000, triangleCount: 4_000 } as never)
    const statue = await createElement(preset.id, { type: 'model', name: 'Statue', properties: { modelSrc: url } })
    for (let i = 0; i < 3; i++) await createInstance(statue.id)
    await createElement(preset.id, { type: 'model', name: 'Mystery', properties: { modelSrc: `${CDN}/m/Mystery.glb` } })

    const get = (u: Parameters<typeof tokenFor>[0]) => app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/health`, headers: { authorization: `Bearer ${tokenFor(u)}` } })
    // No destination yet: one parcel's budget
    let body = (await get(host)).json()
    expect(body.targets).toEqual([expect.objectContaining({ id: null, kind: 'none', parcels: 1, state: 'over' })])
    expect(body.targets[0].metrics.find((m: any) => m.key === 'triangles')).toMatchObject({ used: 12_000, limit: 10_000, state: 'over' })
    expect(body.byTriangles).toEqual([{ elementId: statue.id, name: 'Statue', copies: 3, triangles: 4_000, bytes: 3_000_000 }])
    expect(body.unmeasured).toBe(1)
    expect(body.suggestions[0]).toMatch(/lower-detail version of "Statue" \(4,000 triangles × 3 copies\)/)

    await db.insert(dclWorldDestinations).values({ sceneId: scene.id, ownerUserId: host.id, ownerWallet: '0xa', worldName: 'big.dcl.eth', base: '0,0', parcels: ['0,0', '0,1'], mode: 'virvi' } as never)
    body = (await get(host)).json()
    // 12,000 of 2 parcels' 20,000 triangles: within
    expect(body.targets).toEqual([expect.objectContaining({ name: 'big.dcl.eth', kind: 'world', parcels: 2, state: 'within' })])
    expect(body.state).toBe('within')
    expect(body.suggestions).toEqual([])

    const editor = await createUser({ wallet: randomWallet() })
    const viewer = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values([
      { sceneId: scene.id, walletAddress: editor.wallet!, userId: editor.id, role: 'editor' },
      { sceneId: scene.id, walletAddress: viewer.wallet!, userId: viewer.id, role: 'viewer' },
    ])
    expect((await get(editor)).statusCode).toBe(200)
    expect((await get(viewer)).statusCode).toBe(403)
    expect((await get(await createUser())).statusCode).toBe(403)
  })
})
