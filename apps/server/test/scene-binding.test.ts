import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db.js'
import { createUser, createScene } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { locationSetups } from '../src/db/schema.js'
import { createSetup } from './helpers/setups.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { bindSceneRequest, locationKeyForContext } from '../src/auth/scene-binding.js'

const ctx = (o: Partial<{ sceneId: string; parcel: string; serverName: string; hostname: string }> = {}) => ({
  sceneId: o.sceneId ?? 'bafyA',
  parcel: o.parcel ?? '10,20',
  realm: { hostname: o.hostname ?? 'peer.decentraland.org', serverName: o.serverName ?? 'main' },
  isGuest: false,
})

/** The official directory shows this scene deployed by `deployer` (no setup has recorded it). */
function live(scene: { entityId: string; base: string; parcels: string[] }, deployer: string) {
  const dir = new FakeDclDirectory()
  dir.addScene(scene, deployer)
  setDclDirectory(dir)
}

describe('scene binding', () => {
  beforeEach(async () => { await resetDb(); setDclDirectory(new FakeDclDirectory()) })

  it('location keys: Genesis City realms are never Worlds; World names are lowercased', () => {
    for (const serverName of ['main', 'realm-1', 'hela']) expect(locationKeyForContext(ctx({ serverName }), '0xa', false)).toBe('gc:10,20')
    expect(locationKeyForContext(ctx({ serverName: 'MyWorld.dcl.eth' }), '0xa', false)).toBe('world:myworld.dcl.eth')
    expect(locationKeyForContext(ctx(), '0xA', true)).toBe('preview:0xa:10,20')
  })

  it('binds a Genesis City parcel to the active setup of its location', async () => {
    const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000a1' })
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20', '10,21'], activeEntityId: 'bafyA' } as any)
    await createSetup(loc.id, scene.id)
    live({ entityId: 'bafyA', base: '10,20', parcels: ['10,20', '10,21'] }, owner.wallet!)
    expect(await bindSceneRequest(ctx(), owner.wallet!)).toEqual({ locationId: loc.id, sceneId: scene.id })
  })

  it('finds the location by any of its parcels when the base key misses', async () => {
    const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000a2' })
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,19', baseParcel: '10,19', parcels: ['10,19', '10,20'] } as any)
    await createSetup(loc.id, scene.id)
    live({ entityId: 'bafyA', base: '10,19', parcels: ['10,19', '10,20'] }, owner.wallet!)
    expect((await bindSceneRequest(ctx(), '0xa')).sceneId).toBe(scene.id)
  })

  it('binds a World by name', async () => {
    const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000a3' })
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ kind: 'world', locationKey: 'world:myworld.dcl.eth', worldName: 'myworld.dcl.eth', baseParcel: '0,0', parcels: ['0,0'] } as any)
    await createSetup(loc.id, scene.id)
    const dir = new FakeDclDirectory()
    dir.worlds.set('myworld.dcl.eth', { sceneUrns: ['urn:decentraland:entity:bafyA'] })
    dir.worldOwners.set('myworld.dcl.eth', owner.wallet!)
    setDclDirectory(dir)
    expect((await bindSceneRequest(ctx({ serverName: 'myworld.dcl.eth', parcel: '0,0', hostname: 'worlds-content-server.decentraland.org/world/myworld.dcl.eth' }), '0xa')).sceneId).toBe(scene.id)
  })

  it('no location, or a location with no active setup → visitor binding', async () => {
    expect(await bindSceneRequest(ctx(), '0xa')).toEqual({ locationId: null, sceneId: null })
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'] } as any)
    expect(await bindSceneRequest(ctx(), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
  })

  it('directory down while checking a changed deployment → visitor binding', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'], activeEntityId: 'bafyOld' } as any)
    const setup = await createSetup(loc.id, scene.id)
    await db.update(locationSetups).set({ deploymentEntityId: 'bafyOld' }).where(eq(locationSetups.id, setup.id))
    const dir = new FakeDclDirectory(); dir.down = true; setDclDirectory(dir)
    expect(await bindSceneRequest(ctx({ sceneId: 'bafyNew' }), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
  })

  describe('official realms only (an attacker-run realm must not claim a victim location)', () => {
    async function victimGc() {
      const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000b1' })
      const { scene } = await createScene(owner)
      const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'], activeEntityId: 'bafyVictim' } as any)
      const setup = await createSetup(loc.id, scene.id)
      await db.update(locationSetups).set({ deploymentEntityId: 'bafyVictim' }).where(eq(locationSetups.id, setup.id))
      const dir = new FakeDclDirectory()
      dir.addScene({ entityId: 'bafyVictim', base: '10,20', parcels: ['10,20'] }, owner.wallet ?? '0xv')
      setDclDirectory(dir)
      return { scene, loc, dir }
    }
    async function victimWorld() {
      const owner = await createUser()
      const { scene } = await createScene(owner)
      const loc = await createAnalyticsScene({ kind: 'world', locationKey: 'world:victim.dcl.eth', worldName: 'victim.dcl.eth', baseParcel: '0,0', parcels: ['0,0'], activeEntityId: 'bafyVictim' } as any)
      const setup = await createSetup(loc.id, scene.id)
      await db.update(locationSetups).set({ deploymentEntityId: 'bafyVictim' }).where(eq(locationSetups.id, setup.id))
      const dir = new FakeDclDirectory()
      dir.worlds.set('victim.dcl.eth', { sceneUrns: ['urn:decentraland:entity:bafyVictim?=&baseUrl=https://worlds-content-server.decentraland.org/contents/'] })
      setDclDirectory(dir)
      return { scene, loc, dir }
    }
    const WORLDS = 'worlds-content-server.decentraland.org'

    it('foreign hostname on a Genesis City parcel → visitor (reviewer attack)', async () => {
      await victimGc()
      expect(await bindSceneRequest(ctx({ hostname: 'evil.example', sceneId: 'bafyAttackerCopy' }), '0xa')).toEqual({ locationId: null, sceneId: null })
      // Even serving the victim's own entity id from a foreign realm is not enough.
      expect(await bindSceneRequest(ctx({ hostname: 'evil.example', sceneId: 'bafyVictim' }), '0xa')).toEqual({ locationId: null, sceneId: null })
    })

    it('foreign hostname announcing a World name → visitor', async () => {
      await victimWorld()
      for (const hostname of ['evil.example', 'evil.example/world/victim.dcl.eth'])
        expect(await bindSceneRequest(ctx({ hostname, serverName: 'victim.dcl.eth', parcel: '0,0', sceneId: 'bafyAttackerCopy' }), '0xa')).toEqual({ locationId: null, sceneId: null })
    })

    it('lookalike hostnames → visitor', async () => {
      await victimGc()
      for (const hostname of ['peer.decentraland.org.evil.com', 'evil-decentraland.org', 'evil.decentraland.org', 'peer.decentraland.org:443', 'peer.decentraland.org.', ' peer.decentraland.org', 'peer.decentraland.org/x', 'https://peer.decentraland.org', ''])
        expect(await bindSceneRequest(ctx({ hostname, sceneId: 'bafyVictim' }), '0xa'), hostname).toEqual({ locationId: null, sceneId: null })
    })

    it('Worlds bind only from the Worlds host, Genesis City only from Genesis City hosts', async () => {
      const { scene, loc } = await victimWorld()
      const w = (hostname: string, serverName = 'victim.dcl.eth') => bindSceneRequest(ctx({ hostname, serverName, parcel: '0,0', sceneId: 'bafyVictim' }), '0xa')
      expect(await w(WORLDS)).toEqual({ locationId: loc.id, sceneId: scene.id })
      expect(await w(`${WORLDS}/world/victim.dcl.eth`)).toEqual({ locationId: loc.id, sceneId: scene.id })
      expect(await w(`WORLDS-CONTENT-SERVER.decentraland.org/world/Victim.dcl.eth`)).toEqual({ locationId: loc.id, sceneId: scene.id })
      expect(await w(`${WORLDS}/world/other.dcl.eth`)).toEqual({ locationId: null, sceneId: null })
      expect(await w(`${WORLDS}.evil.com/world/victim.dcl.eth`)).toEqual({ locationId: null, sceneId: null })
      expect(await w('peer.decentraland.org')).toEqual({ locationId: null, sceneId: null })
      expect(await w('realm-provider.decentraland.org')).toEqual({ locationId: null, sceneId: null })
      // Current explorers reach Worlds through Decentraland's gateway (seen live 2026-10-26).
      expect(await w('gateway.decentraland.org/worlds-content-server/world/victim.dcl.eth')).toEqual({ locationId: loc.id, sceneId: scene.id })
      expect(await w('gateway.decentraland.org/worlds-content-server/world/victim.dcl.eth/')).toEqual({ locationId: loc.id, sceneId: scene.id })
      expect(await w('gateway.decentraland.org/worlds-content-server/world/other.dcl.eth')).toEqual({ locationId: null, sceneId: null })
      expect(await w('gateway.decentraland.org/evil/world/victim.dcl.eth')).toEqual({ locationId: null, sceneId: null })
      expect(await w('gateway.decentraland.org/world/victim.dcl.eth')).toEqual({ locationId: null, sceneId: null })
      expect(await w('gateway.decentraland.org')).toEqual({ locationId: null, sceneId: null })
      expect(await w('gateway.decentraland.org.evil.com/worlds-content-server/world/victim.dcl.eth')).toEqual({ locationId: null, sceneId: null })
      // A Genesis City realm name on the Worlds host is not a Genesis City realm.
      await victimGc()
      expect(await bindSceneRequest(ctx({ hostname: WORLDS, sceneId: 'bafyVictim' }), '0xa')).toEqual({ locationId: null, sceneId: null })
    })

    it('Genesis City through the gateway: only the bare gateway host counts (seen live 2026-11-14)', async () => {
      const { scene, loc } = await victimGc()
      const g = (hostname: string) => bindSceneRequest(ctx({ hostname, sceneId: 'bafyVictim' }), '0xa')
      expect(await g('gateway.decentraland.org')).toEqual({ locationId: loc.id, sceneId: scene.id })
      expect(await g('GATEWAY.decentraland.org')).toEqual({ locationId: loc.id, sceneId: scene.id })
      expect(await g('gateway.decentraland.org/evil')).toEqual({ locationId: null, sceneId: null })
      expect(await g('gateway.decentraland.org/worlds-content-server/world/victim.dcl.eth')).toEqual({ locationId: null, sceneId: null })
      expect(await g('gateway.decentraland.org.evil.com')).toEqual({ locationId: null, sceneId: null })
    })

    it('official hostname with a mismatched entity → visitor pass at the location', async () => {
      const { loc } = await victimGc()
      expect(await bindSceneRequest(ctx({ hostname: 'peer.decentraland.org', sceneId: 'bafyAttackerCopy' }), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
      const w = await victimWorld()
      expect(await bindSceneRequest(ctx({ hostname: WORLDS, serverName: 'victim.dcl.eth', parcel: '0,0', sceneId: 'bafyAttackerCopy' }), '0xa')).toEqual({ locationId: w.loc.id, sceneId: null })
    })

    it('official hostname + matching entity → bound, for Decentraland hosts and DAO catalysts', async () => {
      const { scene, loc, dir } = await victimGc()
      dir.catalystHosts = ['peer.melonwave.com', 'peer-ec1.decentraland.org']
      // Current explorers report the main realm through Decentraland's gateway too (seen live 2026-11-14, the studio parcel)
      for (const hostname of ['realm-provider.decentraland.org', 'peer.decentraland.org', 'PEER-EC1.decentraland.org', 'peer.melonwave.com', 'gateway.decentraland.org'])
        expect(await bindSceneRequest(ctx({ hostname, sceneId: 'bafyVictim' }), '0xa'), hostname).toEqual({ locationId: loc.id, sceneId: scene.id })
    })

    it('catalyst list fetch failure → the fallback set is used', async () => {
      const { scene, loc, dir } = await victimGc()
      dir.catalystHosts = ['peer.melonwave.com']
      dir.catalystsDown = true
      expect(await bindSceneRequest(ctx({ hostname: 'peer-eu1.decentraland.org', sceneId: 'bafyVictim' }), '0xa')).toEqual({ locationId: loc.id, sceneId: scene.id })
      expect(await bindSceneRequest(ctx({ hostname: 'peer.melonwave.com', sceneId: 'bafyVictim' }), '0xa')).toEqual({ locationId: null, sceneId: null })
    })

    describe('setup with no recorded deployment (comms-less foreign realms report the realm-provider host)', () => {
      async function unrecordedGc() {
        const { scene, loc, dir } = await victimGc()
        await db.update(locationSetups).set({ deploymentEntityId: null }).where(eq(locationSetups.analyticsSceneId, loc.id))
        return { scene, loc, dir }
      }

      it('signed entity that is not the live deployment → visitor pass at the location', async () => {
        const { loc } = await unrecordedGc()
        expect(await bindSceneRequest(ctx({ hostname: 'realm-provider.decentraland.org', sceneId: 'bafyAttackerCopy' }), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
      })

      it('live deployment unknown or directory down → visitor pass', async () => {
        const { loc, dir } = await unrecordedGc()
        dir.scenes.clear()
        expect(await bindSceneRequest(ctx({ hostname: 'realm-provider.decentraland.org', sceneId: 'bafyVictim' }), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
        dir.down = true
        expect(await bindSceneRequest(ctx({ hostname: 'realm-provider.decentraland.org', sceneId: 'bafyVictim' }), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
      })

      it('signed entity is the live deployment by the team → bound, and the deployment is recorded', async () => {
        const { scene, loc } = await unrecordedGc()
        expect(await bindSceneRequest(ctx({ hostname: 'realm-provider.decentraland.org', sceneId: 'bafyVictim' }), '0xa')).toEqual({ locationId: loc.id, sceneId: scene.id })
        const row = await db.query.locationSetups.findFirst({ where: eq(locationSetups.analyticsSceneId, loc.id) })
        expect(row?.deploymentEntityId).toBe('bafyVictim')
      })

      it('live deployment by an outsider → visitor, and the setup is released', async () => {
        const { loc, dir } = await unrecordedGc()
        dir.addScene({ entityId: 'bafyOutsider', base: '10,20', parcels: ['10,20'] }, '0x00000000000000000000000000000000000000ee')
        expect(await bindSceneRequest(ctx({ hostname: 'realm-provider.decentraland.org', sceneId: 'bafyOutsider' }), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
        const row = await db.query.locationSetups.findFirst({ where: eq(locationSetups.analyticsSceneId, loc.id) })
        expect(row?.endedAt).not.toBeNull()
      })

      it('live deployer unknown → visitor, setup kept unrecorded', async () => {
        const { loc, dir } = await unrecordedGc()
        dir.deployers.clear()
        expect(await bindSceneRequest(ctx({ hostname: 'realm-provider.decentraland.org', sceneId: 'bafyVictim' }), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
        const row = await db.query.locationSetups.findFirst({ where: eq(locationSetups.analyticsSceneId, loc.id) })
        expect(row).toMatchObject({ endedAt: null, deploymentEntityId: null })
      })
    })

    it('a foreign realm never reaches the database or the directory', async () => {
      const { dir } = await victimGc()
      dir.calls = 0
      dir.catalystHosts = []
      await bindSceneRequest(ctx({ hostname: 'evil.example', sceneId: 'bafyX' }), '0xa')
      expect(dir.calls).toBeLessThanOrEqual(1) // at most the (cached) catalyst list
    })

    it('local preview binding is unaffected', async () => {
      const owner = await createUser()
      const { scene } = await createScene(owner)
      const loc = await createAnalyticsScene({ locationKey: 'preview:0xa:10,20', baseParcel: '10,20', parcels: ['10,20'] } as any)
      await createSetup(loc.id, scene.id)
      expect(await bindSceneRequest(ctx({ hostname: 'localhost:8000' }), '0xa', { preview: true })).toEqual({ locationId: loc.id, sceneId: scene.id })
    })
  })
})
