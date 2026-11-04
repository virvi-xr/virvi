import { describe, it, expect, afterEach, vi } from 'vitest'
import { parcelControl, grantedTo, AETHERIA_OWNERS } from '../src/services/dcl/parcel-control.js'
import { HttpDclDirectory, DirectoryUnavailableError, type ParcelRights } from '../src/analytics/dcl-directory.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

const OWNER = '0x' + '1'.repeat(40)
const UPD = '0x' + '2'.repeat(40)
const OTHER = '0x' + '3'.repeat(40)
const rights = (o: Partial<ParcelRights> = {}): ParcelRights => ({ owner: OWNER, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [], ...o })

describe('parcelControl', () => {
  it('owner controls all and can grant', async () => {
    const dir = new FakeDclDirectory()
    dir.rights.set('1,1', rights())
    dir.rights.set('1,2', rights())
    const c = await parcelControl([OTHER, OWNER.toUpperCase().replace('0X', '0x')], ['1,1', '1,2'], dir)
    expect(c).toMatchObject({ wallet: OWNER, missing: null, canGrant: true, granter: OWNER, aetheria: false })
    expect(c.rightsOf.size).toBe(2)
  })

  it('an update operator controls but cannot grant', async () => {
    const dir = new FakeDclDirectory()
    dir.rights.set('1,1', rights({ updateOperator: UPD }))
    const c = await parcelControl([UPD], ['1,1'], dir)
    expect(c).toMatchObject({ wallet: UPD, missing: null, canGrant: false })
  })

  it('reports the first parcel nobody controls', async () => {
    const dir = new FakeDclDirectory()
    dir.rights.set('1,1', rights())
    dir.rights.set('1,2', rights({ owner: OTHER }))
    const c = await parcelControl([OWNER], ['1,1', '1,2', '1,3'], dir)
    expect(c).toMatchObject({ wallet: null, missing: '1,2', canGrant: false })
  })

  it('flags Aetheria by owner', async () => {
    const dir = new FakeDclDirectory()
    const [a] = [...AETHERIA_OWNERS]
    dir.rights.set('108,105', rights({ owner: a, updateOperator: UPD }))
    const c = await parcelControl([UPD], ['108,105'], dir)
    expect(c).toMatchObject({ wallet: UPD, aetheria: true, canGrant: false })
  })

  it('the granter is the first deploying wallet that may grant on every parcel, not just the first wallet', async () => {
    const dir = new FakeDclDirectory()
    for (const p of ['1,1', '1,2']) dir.rights.set(p, rights({ updateOperator: UPD }))
    const c = await parcelControl([UPD, OWNER], ['1,1', '1,2'], dir)
    expect(c).toMatchObject({ wallet: UPD, wallets: [UPD, OWNER], granter: OWNER, canGrant: true })
    const op = await parcelControl([UPD], ['1,1', '1,2'], dir)
    expect(op).toMatchObject({ granter: null, canGrant: false })
  })

  it('reads fresh by default, cached on request, a few parcels at a time', async () => {
    const dir = new FakeDclDirectory()
    const parcels = Array.from({ length: 10 }, (_, i) => `1,${i}`)
    for (const p of parcels) dir.rights.set(p, rights())
    let inFlight = 0
    let most = 0
    dir.onRightsRead = async () => {
      most = Math.max(most, ++inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    }
    const c = await parcelControl([OWNER], parcels, dir)
    expect(c.wallet).toBe(OWNER)
    expect(dir.rightsReads.every((r) => r.fresh)).toBe(true)
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(4)
    dir.rightsReads = []
    await parcelControl([OWNER], parcels, dir, { fresh: false })
    expect(dir.rightsReads.some((r) => r.fresh)).toBe(false)
  })

  it('throws when the directory is down', async () => {
    const dir = new FakeDclDirectory()
    dir.down = true
    await expect(parcelControl([OWNER], ['1,1'], dir)).rejects.toBeInstanceOf(DirectoryUnavailableError)
  })
})

describe('grantedTo', () => {
  it('is true only when every parcel has the address', () => {
    const m = new Map([
      ['1,1', rights({ updateOperator: UPD })],
      ['1,2', rights({ updateManagers: [UPD] })],
    ])
    expect(grantedTo(UPD, m)).toBe(true)
    m.set('1,3', rights())
    expect(grantedTo(UPD, m)).toBe(false)
    expect(grantedTo(UPD, new Map())).toBe(false)
  })
})

describe('HttpDclDirectory.getParcelEstates', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('batches one subgraph request and maps estates', async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string).query).toContain('x:"108",y:"105"')
      return new Response(JSON.stringify({ data: { p0: [{ estate: { id: '2092' } }], p1: [{ estate: null }], p2: [] } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const dir = new HttpDclDirectory('https://cat', 'https://worlds', 'https://sg')
    const m = await dir.getParcelEstates(['108,105', '1,1', '2,2'])
    expect([...m]).toEqual([['108,105', '2092'], ['1,1', null], ['2,2', null]])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws on errors and rejects malformed coordinates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [{}] }), { status: 200 })))
    const dir = new HttpDclDirectory('https://cat', 'https://worlds', 'https://sg')
    await expect(dir.getParcelEstates(['1,1'])).rejects.toBeInstanceOf(DirectoryUnavailableError)
    await expect(dir.getParcelEstates(['1,1"}'])).rejects.toThrow(/bad parcel/)
  })
})
