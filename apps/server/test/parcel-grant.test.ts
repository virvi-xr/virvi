import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { eq } from 'drizzle-orm'
import { Interface, Wallet, ZeroAddress } from 'ethers'
import { db } from '../src/db/connection.js'
import { dclWorldDestinations, sceneDeployments, sceneImports } from '../src/db/schema.js'
import { setDclDirectory, type ParcelRights } from '../src/analytics/dcl-directory.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { CatalystError, setCatalystClient } from '../src/services/dcl/catalyst-client.js'
import { setWorldsClient } from '../src/services/dcl/worlds-client.js'
import { chainSigner, virviParcelSigner, virviSigner } from '../src/services/dcl/entity.js'
import { whenSettled } from '../src/services/dcl/world-deployer.js'
import { deployImport, startImportDeploy } from '../src/services/import/import-deploy.js'
import { ESTATE_REGISTRY, grantTransactions, LAND_REGISTRY, landAssetId } from '../src/services/dcl/parcel-grant.js'
import { AETHERIA_OWNERS } from '../src/services/dcl/parcel-control.js'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { FakeCatalystClient } from './helpers/fake-catalyst.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'

vi.mock('../src/net/public-url.js', async (orig) => ({
  ...(await orig<typeof import('../src/net/public-url.js')>()),
  assertPublicHttpUrl: async (url: string) => new URL(url),
}))

const LAND = new Interface(['function setManyUpdateOperator(uint256[] _assetIds, address _operator)'])
const ESTATE = new Interface(['function setUpdateOperator(uint256 estateId, address operator)'])
const COST_NOTE =
  'This is an Ethereum mainnet transaction: you pay its gas fee once. Undo it any time with a second transaction from here (also paid in gas).'
const REVOKED = 'Virvi is no longer an operator on these parcels. Sign this deploy in the browser, or set Virvi up again.'

describe('grantTransactions', () => {
  it('encodes asset ids for negative coordinates', () => {
    expect(landAssetId('-9,-9')).toBe(0xfffffffffffffffffffffffffffffff7fffffffffffffffffffffffffffffff7n)
    expect(landAssetId('1,2')).toBe((1n << 128n) | 2n)
    const op = Wallet.createRandom().address.toLowerCase()
    const [tx] = grantTransactions(['-9,-9', '0,1'], new Map([['-9,-9', null], ['0,1', null]]), op)
    expect(tx.to).toBe(LAND_REGISTRY)
    const [ids, operator] = LAND.decodeFunctionData('setManyUpdateOperator', tx.data)
    expect([...ids]).toEqual([0xfffffffffffffffffffffffffffffff7fffffffffffffffffffffffffffffff7n, 1n])
    expect(operator.toLowerCase()).toBe(op)
  })

  it('makes one estate call per estate, and the loose parcels in one LAND call', () => {
    const op = Wallet.createRandom().address.toLowerCase()
    const estates = new Map<string, string | null>([['1,1', '77'], ['1,2', '77'], ['3,3', null], ['4,4', '12']])
    const txs = grantTransactions(['1,1', '1,2', '3,3', '4,4'], estates, op)
    expect(txs.map((t) => t.to)).toEqual([LAND_REGISTRY, ESTATE_REGISTRY, ESTATE_REGISTRY])
    expect([...LAND.decodeFunctionData('setManyUpdateOperator', txs[0].data)[0]]).toEqual([landAssetId('3,3')])
    expect(ESTATE.decodeFunctionData('setUpdateOperator', txs[1].data)[0]).toBe(77n)
    expect(ESTATE.decodeFunctionData('setUpdateOperator', txs[2].data)[0]).toBe(12n)
    expect(String(ESTATE.decodeFunctionData('setUpdateOperator', txs[2].data)[1]).toLowerCase()).toBe(op)
    for (const t of txs) expect(t.label).toBeTruthy()
  })

  it('a null operator encodes the zero address (revoke), with no LAND call when every parcel is in an estate', () => {
    const txs = grantTransactions(['1,1'], new Map([['1,1', '77']]), null)
    expect(txs).toHaveLength(1)
    expect(ESTATE.decodeFunctionData('setUpdateOperator', txs[0].data)[1]).toBe(ZeroAddress)
  })
})

const PARCELS = ['10,10', '10,11']
const BASE = '10,10'
const enc = (s: string) => new TextEncoder().encode(s)
const rights = (r: Partial<ParcelRights> = {}): ParcelRights => ({ owner: null, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [], ...r })
const sceneJson = JSON.stringify({
  display: { title: 'Plaza' }, owner: '', main: 'bin/index.js', ecs7: true, runtimeVersion: '7', scene: { parcels: PARCELS, base: BASE }, spawnPoints: [],
})

describe('the Genesis City operator grant', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let catalyst: FakeCatalystClient
  let dir: FakeDclDirectory
  let store: ReturnType<typeof memoryPrivateStore>
  let user: TestUser
  const cfg = config as { virviDclDeployKey: string | null; virviDclParcelDeployKey: string | null }
  const saved = { world: cfg.virviDclDeployKey, parcel: cfg.virviDclParcelDeployKey }
  let virvi: string

  beforeEach(async () => {
    await resetDb()
    cfg.virviDclDeployKey = Wallet.createRandom().privateKey
    cfg.virviDclParcelDeployKey = Wallet.createRandom().privateKey
    virvi = virviParcelSigner()!.address
    catalyst = new FakeCatalystClient()
    setCatalystClient(catalyst)
    setWorldsClient(new FakeWorldsClient())
    dir = new FakeDclDirectory()
    setDclDirectory(dir)
    store = memoryPrivateStore()
    setImportStore(store)
    user = await createUser({ wallet: createUnsafeIdentity().address })
    for (const p of PARCELS) dir.rights.set(p, rights({ owner: user.wallet }))
    app = await testApp()
  })
  afterEach(async () => {
    cfg.virviDclDeployKey = saved.world
    cfg.virviDclParcelDeployKey = saved.parcel
    setCatalystClient(null)
    setWorldsClient(null)
    setDclDirectory(null)
    setImportStore(null)
    await app.close()
  })

  const destRow = async (id: string) => (await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, id) }))!
  const importRow = async (id: string) => (await db.query.sceneImports.findFirst({ where: eq(sceneImports.id, id) }))!
  const depRow = async (id: string) => (await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, id) }))!
  const grantVirvi = () => { for (const p of PARCELS) dir.rights.set(p, rights({ owner: user.wallet, updateOperator: virvi })) }

  async function parcelsDest(o: { by?: TestUser; granted?: boolean } = {}) {
    const by = o.by ?? user
    const { scene } = await createScene(by, 'Plaza')
    const [d] = await db.insert(dclWorldDestinations).values({
      sceneId: scene.id, ownerUserId: by.id, ownerWallet: by.wallet!, kind: 'parcels', worldName: null, base: BASE, parcels: PARCELS,
      mode: o.granted ? 'virvi' : 'sign', grantedAt: o.granted ? new Date() : null, adopted: true,
    }).returning()
    return d
  }

  /** A built parcel import of `sceneId`, its files in the store. */
  async function built(sceneId: string, status: 'built' = 'built') {
    const [row] = await db.insert(sceneImports).values({
      userId: user.id, sceneId, locationKind: 'parcels', base: BASE, parcels: PARCELS, kind: 'sdk7', sourceKey: 'pending', status, builtAt: new Date(),
    }).returning()
    const prefix = `imports/${row.id}/built/`
    await db.update(sceneImports).set({ sourceKey: `imports/${row.id}/source.zip`, builtKeyPrefix: prefix }).where(eq(sceneImports.id, row.id))
    for (const [path, bytes] of [['scene.json', enc(sceneJson)], ['bin/index.js', enc('owner code')]] as const) {
      await store.put(prefix + path, Buffer.from(bytes), 'application/octet-stream')
    }
    return importRow(row.id)
  }

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, by: TestUser = user, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(by)}` }, payload })

  it('the GET returns the transactions for the owner, with Virvi\'s Genesis City address', async () => {
    dir.estates.set(PARCELS[1], '77')
    const d = await parcelsDest()
    const res = await call('GET', `/api/dcl/destinations/${d.id}/parcel-grant`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ available: true, aetheria: false, canGrant: true, granted: false, operator: virvi, costNote: COST_NOTE })
    expect(virvi).not.toBe(virviSigner()!.address)
    expect(body.transactions).toEqual(grantTransactions(PARCELS, new Map([[PARCELS[0], null], [PARCELS[1], '77']]), virvi))
    expect(body.transactions).toHaveLength(2)
  })

  it('the GET gives an update operator no transactions (canGrant false)', async () => {
    const op = await createUser({ wallet: createUnsafeIdentity().address })
    for (const p of PARCELS) dir.rights.set(p, rights({ owner: user.wallet, updateOperator: op.wallet }))
    const d = await parcelsDest({ by: op })
    const res = await call('GET', `/api/dcl/destinations/${d.id}/parcel-grant`, op)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ available: true, canGrant: false, granted: false })
    expect(res.json().transactions).toBeUndefined()
  })

  it('refuses the operator grant for Aetheria parcels', async () => {
    const [aetheriaOwner] = [...AETHERIA_OWNERS]
    const holder = await createUser({ wallet: aetheriaOwner })
    for (const p of PARCELS) dir.rights.set(p, rights({ owner: aetheriaOwner }))
    const d = await parcelsDest({ by: holder })
    const res = await call('GET', `/api/dcl/destinations/${d.id}/parcel-grant`, holder)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ available: true, aetheria: true, canGrant: true })
    expect(res.json().transactions).toBeUndefined()
    // Even with Virvi named on-chain, the check refuses and the mode stays
    for (const p of PARCELS) dir.rights.set(p, rights({ owner: aetheriaOwner, updateOperator: virvi }))
    const check = await call('POST', `/api/dcl/destinations/${d.id}/parcel-grant/check`, holder)
    expect(check.statusCode).toBe(409)
    expect(check.json().error).toBe('aetheria_managed')
    expect(await destRow(d.id)).toMatchObject({ mode: 'sign', grantedAt: null })
  })

  it('also treats a parcel in the Aetheria estate as Aetheria', async () => {
    dir.estates.set(PARCELS[0], '2092')
    const d = await parcelsDest()
    const res = await call('GET', `/api/dcl/destinations/${d.id}/parcel-grant`)
    expect(res.json()).toMatchObject({ aetheria: true })
    expect(res.json().transactions).toBeUndefined()
  })

  it('check flips to virvi when the rights name Virvi\'s address', async () => {
    const d = await parcelsDest()
    const before = await call('POST', `/api/dcl/destinations/${d.id}/parcel-grant/check`)
    expect(before.statusCode).toBe(200)
    expect(before.json()).toMatchObject({ granted: false, missing: PARCELS[0] })
    expect((await destRow(d.id)).mode).toBe('sign')

    grantVirvi()
    const after = await call('POST', `/api/dcl/destinations/${d.id}/parcel-grant/check`)
    expect(after.statusCode).toBe(200)
    expect(after.json()).toMatchObject({ granted: true })
    const row = await destRow(d.id)
    expect(row.mode).toBe('virvi')
    expect(row.grantedAt).toBeInstanceOf(Date)
    const get = await call('GET', `/api/dcl/destinations/${d.id}/parcel-grant`)
    expect(get.json()).toMatchObject({ granted: true })
  })

  it('check is not fooled by the World key\'s address', async () => {
    const d = await parcelsDest()
    for (const p of PARCELS) dir.rights.set(p, rights({ owner: user.wallet, updateOperator: virviSigner()!.address }))
    const res = await call('POST', `/api/dcl/destinations/${d.id}/parcel-grant/check`)
    expect(res.json()).toMatchObject({ granted: false })
  })

  it('the key unset gives available:false and no transactions', async () => {
    cfg.virviDclParcelDeployKey = null
    const d = await parcelsDest()
    const res = await call('GET', `/api/dcl/destinations/${d.id}/parcel-grant`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ available: false, granted: false, operator: null, costNote: COST_NOTE })
    expect(res.json().transactions).toBeUndefined()
    const check = await call('POST', `/api/dcl/destinations/${d.id}/parcel-grant/check`)
    expect(check.statusCode).toBe(503)
  })

  it('the grant routes refuse a World destination (409 not_parcels) and a caller who no longer controls the parcels (403)', async () => {
    const { scene } = await createScene(user, 'World scene')
    const [w] = await db.insert(dclWorldDestinations).values({
      sceneId: scene.id, ownerUserId: user.id, ownerWallet: user.wallet!, worldName: 'mine.dcl.eth', base: '0,0', parcels: ['0,0'], mode: 'sign',
    }).returning()
    for (const url of ['parcel-grant', 'parcel-grant/revoke']) expect((await call('GET', `/api/dcl/destinations/${w.id}/${url}`)).json().error).toBe('not_parcels')
    for (const url of ['parcel-grant/check', 'parcel-grant/revoke/check']) expect((await call('POST', `/api/dcl/destinations/${w.id}/${url}`)).json().error).toBe('not_parcels')

    const d = await parcelsDest()
    dir.rights.set(PARCELS[1], rights({ owner: createUnsafeIdentity().address.toLowerCase() }))
    const res = await call('GET', `/api/dcl/destinations/${d.id}/parcel-grant`)
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('not_parcel_controller')
  })

  it('PATCH cannot switch parcels to virvi without the grant', async () => {
    const d = await parcelsDest()
    const res = await call('PATCH', `/api/dcl/destinations/${d.id}`, user, { mode: 'virvi' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('not_granted')
    expect((await destRow(d.id)).mode).toBe('sign')

    grantVirvi()
    const ok = await call('PATCH', `/api/dcl/destinations/${d.id}`, user, { mode: 'virvi' })
    expect(ok.statusCode).toBe(200)
    expect(await destRow(d.id)).toMatchObject({ mode: 'virvi', grantedAt: expect.any(Date) })
  })

  it('revoke returns zero-address transactions for the parcels Virvi holds, and revoke/check clears the mode once they are gone', async () => {
    // Only the first parcel names Virvi; clearing the second would remove someone else's update operator
    const other = createUnsafeIdentity().address.toLowerCase()
    dir.rights.set(PARCELS[0], rights({ owner: user.wallet, updateOperator: virvi }))
    dir.rights.set(PARCELS[1], rights({ owner: user.wallet, updateOperator: other }))
    const d = await parcelsDest({ granted: true })
    const res = await call('GET', `/api/dcl/destinations/${d.id}/parcel-grant/revoke`)
    expect(res.statusCode).toBe(200)
    expect(res.json().transactions).toEqual(grantTransactions([PARCELS[0]], new Map([[PARCELS[0], null]]), null))

    const still = await call('POST', `/api/dcl/destinations/${d.id}/parcel-grant/revoke/check`)
    expect(still.statusCode).toBe(200)
    expect(still.json()).toMatchObject({ revoked: false })
    expect((await destRow(d.id)).mode).toBe('virvi')

    dir.rights.set(PARCELS[0], rights({ owner: user.wallet }))
    const gone = await call('POST', `/api/dcl/destinations/${d.id}/parcel-grant/revoke/check`)
    expect(gone.json()).toMatchObject({ revoked: true })
    expect(await destRow(d.id)).toMatchObject({ mode: 'sign', grantedAt: null })
  })

  it('a granted parcels deploy is signed by the Genesis City key', async () => {
    grantVirvi()
    const d = await parcelsDest({ granted: true })
    const imp = await built(d.sceneId)
    const started = await startImportDeploy(imp, user.id)
    expect(started?.mode).toBe('virvi')
    await whenSettled(started!.deployment.id)
    expect(catalyst.deployed).toHaveLength(1)
    expect(chainSigner(catalyst.deployed[0].authChain)).toBe(virvi)
    expect((await importRow(imp.id)).status).toBe('deployed')
  })

  it('a finished build auto-deploys to granted parcels', async () => {
    grantVirvi()
    const d = await parcelsDest({ granted: true })
    const imp = await built(d.sceneId)
    await deployImport(imp.id)
    const row = await importRow(imp.id)
    await whenSettled(row.deploymentId!)
    expect(catalyst.deployed).toHaveLength(1)
    expect(chainSigner(catalyst.deployed[0].authChain)).toBe(virvi)
    expect((await importRow(imp.id)).status).toBe('deployed')
  })

  it('a finished build waits for the creator when the parcel key is unset', async () => {
    grantVirvi()
    const d = await parcelsDest({ granted: true })
    cfg.virviDclParcelDeployKey = null
    const imp = await built(d.sceneId)
    await deployImport(imp.id)
    expect((await importRow(imp.id)).status).toBe('built')
    expect(catalyst.deployed).toHaveLength(0)
  })

  describe('a revoked grant falls back to browser signing', () => {
    async function expectFellBack(destId: string, depId: string, importId: string) {
      const dest = await destRow(destId)
      expect(dest).toMatchObject({ mode: 'sign', grantedAt: null })
      expect(await depRow(depId)).toMatchObject({ status: 'failed', errorMessage: REVOKED })
      expect(await importRow(importId)).toMatchObject({ status: 'built', errorCode: 'grant_revoked', errorMessage: REVOKED })
      // The next deploy is prepared for the browser, not tried again by Virvi
      const next = await startImportDeploy(await importRow(importId), user.id)
      expect(next?.mode).toBe('sign')
    }

    it('when a fresh read before signing no longer names Virvi', async () => {
      const d = await parcelsDest({ granted: true }) // the rights don't name Virvi: revoked on-chain
      const imp = await built(d.sceneId)
      const started = await startImportDeploy(imp, user.id)
      expect(started?.mode).toBe('virvi')
      await whenSettled(started!.deployment.id)
      expect(catalyst.deployed).toHaveLength(0)
      await expectFellBack(d.id, started!.deployment.id, imp.id)
    })

    it('when the catalyst refuses Virvi\'s signature for lack of access', async () => {
      grantVirvi()
      catalyst.failNext = new CatalystError(400, JSON.stringify({ errors: ['The provided Eth Address does not have access to the following parcel: (10,10)'] }))
      const d = await parcelsDest({ granted: true })
      const imp = await built(d.sceneId)
      const started = await startImportDeploy(imp, user.id)
      await whenSettled(started!.deployment.id)
      await expectFellBack(d.id, started!.deployment.id, imp.id)
    })

    it('a catalyst refusal for another reason does not drop the grant', async () => {
      grantVirvi()
      catalyst.failNext = new CatalystError(400, JSON.stringify({ errors: ['Scene is too big'] }))
      const d = await parcelsDest({ granted: true })
      const imp = await built(d.sceneId)
      const started = await startImportDeploy(imp, user.id)
      await whenSettled(started!.deployment.id)
      expect(await destRow(d.id)).toMatchObject({ mode: 'virvi', grantedAt: expect.any(Date) })
      expect(await importRow(imp.id)).toMatchObject({ status: 'built', errorCode: 'deploy_rejected' })
    })
  })
})
