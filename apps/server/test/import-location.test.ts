import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneImports } from '../src/db/schema.js'
import { createImport, importView, locationKeyOf } from '../src/services/import/imports.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, type TestUser } from './helpers/factories.js'

describe('import locations', () => {
  let user: TestUser
  let sceneId: string
  beforeEach(async () => {
    await resetDb()
    user = await createUser()
    sceneId = (await createScene(user)).scene.id
  })
  const parcels = (ps: string[]) => createImport({
    userId: user.id, location: { kind: 'parcels', base: ps[0]!, parcels: ps }, kind: 'sdk7', scene: { id: sceneId },
  })

  it('locationKeyOf gives both key forms', () => {
    expect(locationKeyOf({ kind: 'world', world: 'moon.dcl.eth' })).toBe('world:moon.dcl.eth')
    expect(locationKeyOf({ kind: 'parcels', base: '0,0', parcels: ['0,0', '0,1'] })).toBe('gc:0,0')
  })

  it('importView reports the location of World and parcel rows', async () => {
    const w = await createImport({ userId: user.id, world: 'moon.dcl.eth', kind: 'sdk7', scene: { id: sceneId } })
    expect(importView(w, null)).toMatchObject({ worldName: 'moon.dcl.eth', location: { kind: 'world', world: 'moon.dcl.eth' } })
    const p = await parcels(['5,5', '5,6'])
    expect(importView(p, null)).toMatchObject({ worldName: null, location: { kind: 'parcels', base: '5,5', parcels: ['5,5', '5,6'] } })
  })

  it('refuses overlapping parcels while another import is under way, and allows them once it failed', async () => {
    const first = await parcels(['0,1', '0,2'])
    await db.update(sceneImports).set({ status: 'building' }).where(eq(sceneImports.id, first.id))
    await expect(parcels(['0,0', '0,1'])).rejects.toMatchObject({ status: 409, code: 'import_in_progress' })
    await expect(parcels(['3,3'])).resolves.toBeTruthy()
    await db.update(sceneImports).set({ status: 'failed' }).where(eq(sceneImports.id, first.id))
    await expect(parcels(['0,0', '0,1'])).resolves.toBeTruthy()
  })
})
