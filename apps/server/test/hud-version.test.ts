import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { DCL_HUD_VERSION, HUD_VERSION_HEADER, compareHudVersions } from '@virvixr/shared'
import { resetDb } from './helpers/db.js'
import { db } from '../src/db/connection.js'
import { sceneDeployments } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { testApp, createUser, createScene, tokenFor } from './helpers/factories.js'
import { clearHudVersionThrottle, dclHudStatus, noteDclHud } from '../src/scenes/hud-version.js'

const dclPass = (u: any, sceneId: string) => tokenFor(u, { kind: 'scene', sceneId, locationId: null, orgId: null })
const flush = () => new Promise((r) => setTimeout(r, 50))

describe('which Decentraland HUD release a scene runs (LIV-33)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); clearHudVersionThrottle(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const detail = async (u: any, id: string) => (await app.inject({ method: 'GET', url: `/api/scenes/${id}`, headers: { authorization: `Bearer ${tokenFor(u)}` } })).json().scene
  const hudCall = (u: any, id: string, version?: string) => app.inject({
    method: 'GET', url: `/api/scenes/${id}`,
    headers: { authorization: `Bearer ${dclPass(u, id)}`, ...(version ? { [HUD_VERSION_HEADER]: version } : {}) },
  })

  it('no HUD has called: nothing to say', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    expect((await detail(owner, scene.id)).dclHud).toBeNull()
  })

  it('a HUD from before the header is recorded with no version; the latest is not behind', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    await hudCall(owner, scene.id)
    await flush()
    expect((await detail(owner, scene.id)).dclHud).toMatchObject({ version: null, latest: DCL_HUD_VERSION })
    clearHudVersionThrottle()
    await hudCall(owner, scene.id, DCL_HUD_VERSION)
    await flush()
    expect((await detail(owner, scene.id)).dclHud).toMatchObject({ version: DCL_HUD_VERSION, behind: false })
  })

  it('no version is behind only once the latest release sends one; an older version is behind', () => {
    const seen = new Date()
    expect(dclHudStatus({ dclHudVersion: null, dclHudSeenAt: seen }, '2.13.0')!.behind).toBe(false) // redeploying wouldn't help yet
    expect(dclHudStatus({ dclHudVersion: null, dclHudSeenAt: seen }, '2.14.0')!.behind).toBe(true)
    expect(dclHudStatus({ dclHudVersion: '2.14.0', dclHudSeenAt: seen }, '2.15.1')!.behind).toBe(true)
    expect(dclHudStatus({ dclHudVersion: '2.15.1', dclHudSeenAt: seen }, '2.15.1')!.behind).toBe(false)
    expect(dclHudStatus({ dclHudVersion: null, dclHudSeenAt: null })).toBeNull()
  })

  it('says whether Virvi deploys the scene, so the page offers Redeploy only where it helps (LIV-13)', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    await hudCall(owner, scene.id, '2.14.0')
    await flush()
    // Deployed from the creator's own project: Virvi has nothing to redeploy
    expect((await detail(owner, scene.id)).dclHud).toMatchObject({ virviDeploys: false })
    const [d] = await db.insert(sceneDeployments).values({ sceneId: scene.id, platform: 'decentraland', status: 'deployed', deploymentType: 'world', target: {} }).returning()
    expect((await detail(owner, scene.id)).dclHud).toMatchObject({ virviDeploys: true })
    // Taken down, or a Hyperfy deployment: not a Decentraland deployment Virvi can replace
    await db.update(sceneDeployments).set({ removedAt: new Date() }).where(eq(sceneDeployments.id, d.id))
    await db.insert(sceneDeployments).values({ sceneId: scene.id, platform: 'hyperfy', status: 'deployed', deploymentType: 'instance', target: {} })
    await db.insert(sceneDeployments).values({ sceneId: scene.id, platform: 'decentraland', status: 'failed', deploymentType: 'world', target: {} })
    expect((await detail(owner, scene.id)).dclHud).toMatchObject({ virviDeploys: false })
  })

  it('the newest release seen wins, so an old copy still running during a redeploy can\'t flip it back', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    await noteDclHud(scene.id, '2.13.0', 1)
    await noteDclHud(scene.id, '2.12.0', 2)
    await noteDclHud(scene.id, undefined, 3)
    await noteDclHud(scene.id, 'not-a-version', 4)
    expect((await detail(owner, scene.id)).dclHud.version).toBe('2.13.0')
  })

  it('Hyperfy and headset passes, and the dashboard, record nothing', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}`, headers: { authorization: `Bearer ${tokenFor(owner)}`, [HUD_VERSION_HEADER]: '1.0.0' } })
    await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}`, headers: { authorization: `Bearer ${tokenFor(owner, { kind: 'scene', sceneId: scene.id, via: 'hyperfy', locationId: null, orgId: null })}`, [HUD_VERSION_HEADER]: '1.0.0' } })
    await flush()
    expect((await detail(owner, scene.id)).dclHud).toBeNull()
  })

  it('versions compare as numbers, and the shared constant matches the @virvixr/dcl release', () => {
    expect(compareHudVersions('2.9.0', '2.13.0')).toBeLessThan(0)
    expect(compareHudVersions('2.13.0', '2.13.0')).toBe(0)
    expect(compareHudVersions(null, '0.0.1')).toBeLessThan(0)
    const dcl = JSON.parse(readFileSync(new URL('../../../packages/dcl/package.json', import.meta.url), 'utf8'))
    // Raise both together at each release, but only once the release is on npm: Scene Import and the redeploy prompt
    // point at DCL_HUD_VERSION, so it may trail the package by one minor release while that release awaits publishing
    const [hudMajor, hudMinor] = DCL_HUD_VERSION.split('.').map(Number)
    const [pkgMajor, pkgMinor] = String(dcl.version).split('.').map(Number)
    expect(hudMajor).toBe(pkgMajor)
    expect(pkgMinor - hudMinor).toBeGreaterThanOrEqual(0)
    expect(pkgMinor - hudMinor).toBeLessThanOrEqual(1)
    if (pkgMinor === hudMinor) expect(DCL_HUD_VERSION).toBe(dcl.version)
  })
})
