import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { db } from '../src/db/connection.js'
import { userAuthMethods, users } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'

/** Apple 5.1.1(v): every account can be deleted, however it signs in. */
describe('deleting an account', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const del = (u: TestUser, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'DELETE', url: '/api/auth/account', payload, headers: { authorization: `Bearer ${tokenFor(u)}` } })
  const gone = async (u: TestUser) => !(await db.query.users.findFirst({ where: eq(users.id, u.id) }))
  const withPassword = async () => {
    const u = await createUser()
    await db.insert(userAuthMethods).values({ userId: u.id, type: 'email', identifier: u.email!, credentialHash: await bcrypt.hash('pw-1234', 4) })
    return u
  }

  it('a wallet-only account is deleted once DELETE is typed', async () => {
    const u = await createUser({ wallet: '0x' + 'a'.repeat(40) })
    const r = await del(u, { confirm: 'DELETE' })
    expect(r.statusCode).toBe(204)
    expect(await gone(u)).toBe(true)
  })

  it('an OAuth-only account is deleted once DELETE is typed', async () => {
    const u = await createUser()
    await db.insert(userAuthMethods).values({ userId: u.id, type: 'oauth', identifier: 'google:1', metadata: { provider: 'google' } })
    expect((await del(u, { confirm: 'DELETE' })).statusCode).toBe(204)
    expect(await gone(u)).toBe(true)
  })

  it('a passwordless account without the confirmation is refused and kept', async () => {
    const u = await createUser({ wallet: '0x' + 'b'.repeat(40) })
    for (const payload of [{}, { confirm: 'delete' }, { confirm: 'yes' }]) {
      const r = await del(u, payload)
      expect(r.statusCode).toBe(400)
      expect(r.json()).toEqual({ error: 'confirm_required', message: 'Type DELETE to confirm.' })
    }
    expect(await gone(u)).toBe(false)
  })

  it('an account with a password still needs the password, not the typed word', async () => {
    const u = await withPassword()
    expect((await del(u, { confirm: 'DELETE' })).statusCode).toBe(400)
    expect((await del(u, { password: 'wrong-pw' })).statusCode).toBe(401)
    expect(await gone(u)).toBe(false)
    expect((await del(u, { password: 'pw-1234' })).statusCode).toBe(204)
    expect(await gone(u)).toBe(true)
  })

  it('tells the signed-in account whether it has a password', async () => {
    const get = (u: TestUser) => app.inject({ method: 'GET', url: '/api/auth/account', headers: { authorization: `Bearer ${tokenFor(u)}` } })
    expect((await get(await withPassword())).json()).toEqual({ hasPassword: true })
    expect((await get(await createUser({ wallet: '0x' + 'c'.repeat(40) }))).json()).toEqual({ hasPassword: false })
    expect((await app.inject({ method: 'GET', url: '/api/auth/account' })).statusCode).toBe(401)
  })
})
