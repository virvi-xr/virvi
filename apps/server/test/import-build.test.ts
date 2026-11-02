import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { zipSync, strToU8 } from 'fflate'
import { db } from '../src/db/connection.js'
import { sceneImports } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import {
  buildsAvailable, flyBuildRunner, getBuildRunner, setBuildRunner, setOnBuildDone, startBuild, type BuildRunner,
} from '../src/services/import/build-runner.js'
import { sweepBuilds } from '../src/services/import/build-sweep.js'
import { resultWork, uploadWork } from '../src/services/import/import-work.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene } from './helpers/factories.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const B = '/api/imports/build'
const auth = (t: string) => ({ authorization: `Bearer ${t}` })
/** The built scene.json the tests' default result carries: the uploaded one's World, parcels and base. */
const SCENE_JSON = '{"main":"bin/index.js","scene":{"parcels":["0,0"],"base":"0,0"},"worldConfiguration":{"name":"moon.dcl.eth"}}'
const SOURCE = Buffer.from(zipSync({ 'scene.json': strToU8(SCENE_JSON), 'src/index.ts': strToU8('main()') }))
const b64 = (s: string) => Buffer.from(s).toString('base64')

function fakeRunner() {
  const started: { importId: string; env: Record<string, string> }[] = []
  const stopped: string[] = []
  const runner: BuildRunner & { fail?: Error } = {
    async start(importId, env) {
      if (runner.fail) throw runner.fail
      started.push({ importId, env })
      return { machineId: `m-${started.length}` }
    },
    async stop(machineId) { stopped.push(machineId) },
  }
  return { runner, started, stopped }
}

describe('scene import builds', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let store: ReturnType<typeof memoryPrivateStore>
  let fake: ReturnType<typeof fakeRunner>
  let done: string[]
  const prevRunner = config.sceneBuildRunner
  const prevMode = config.mode

  beforeEach(async () => {
    await resetDb()
    store = memoryPrivateStore()
    setImportStore(store)
    fake = fakeRunner()
    setBuildRunner(fake.runner)
    done = []
    setOnBuildDone(async (id) => { done.push(id) })
    app = await testApp()
  })
  afterEach(async () => {
    setImportStore(null)
    setBuildRunner(null)
    setOnBuildDone(null)
    ;(config as any).sceneBuildRunner = prevRunner
    ;(config as any).mode = prevMode
    await app.close()
  })

  async function uploaded() {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const [row] = await db.insert(sceneImports).values({
      userId: owner.id, sceneId: scene.id, worldName: 'moon.dcl.eth', kind: 'sdk7', sourceKey: 'pending',
    }).returning()
    const sourceKey = `imports/${row.id}/source.zip`
    await db.update(sceneImports).set({ sourceKey }).where(eq(sceneImports.id, row.id))
    await store.put(sourceKey, SOURCE, 'application/zip')
    return row.id
  }
  /** An import in `building` and the token its box holds. */
  async function building() {
    const id = await uploaded()
    await startBuild(id)
    const env = fake.started.at(-1)!.env
    return { id, token: env.BUILD_TOKEN }
  }
  const row = async (id: string) => (await db.select().from(sceneImports).where(eq(sceneImports.id, id)))[0]
  const builtZip = (files: Record<string, string> = { 'scene.json': SCENE_JSON, 'bin/index.js': 'main()' }) =>
    Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))))
  const postResult = (id: string, token: string, zip: Buffer, log: string | null = b64('build ok')) =>
    app.inject({
      method: 'POST', url: `${B}/${id}/result`, payload: zip,
      headers: { ...auth(token), 'content-type': 'application/zip', ...(log !== null ? { 'x-build-log': log } : {}) },
    })
  const postFailed = (id: string, token: string, log: string) =>
    app.inject({ method: 'POST', url: `${B}/${id}/failed`, payload: log, headers: { ...auth(token), 'content-type': 'text/plain' } })

  it('startBuild stores only the token hash and passes no Virvi secret in env', async () => {
    const id = await uploaded()
    await startBuild(id)
    expect(fake.started).toHaveLength(1)
    const { importId, env } = fake.started[0]
    expect(importId).toBe(id)
    expect(Object.keys(env).sort()).toEqual(['BUILD_FAILED_URL', 'BUILD_RESULT_URL', 'BUILD_SOURCE_URL', 'BUILD_TOKEN', 'VIRVI_API_HOST'])
    expect(env.BUILD_SOURCE_URL).toBe(`${config.publicUrl}/api/imports/build/${id}/source`)
    expect(env.BUILD_RESULT_URL).toBe(`${config.publicUrl}/api/imports/build/${id}/result`)
    expect(env.BUILD_FAILED_URL).toBe(`${config.publicUrl}/api/imports/build/${id}/failed`)
    expect(env.VIRVI_API_HOST).toBe(new URL(config.publicUrl).hostname)
    // 32 bytes, base64url
    expect(Buffer.from(env.BUILD_TOKEN, 'base64url')).toHaveLength(32)
    for (const v of Object.values(env)) expect(v).not.toContain(config.jwtSecret)
    const r = await row(id)
    expect(r.status).toBe('building')
    expect(r.buildTokenHash).toBe(sha(env.BUILD_TOKEN))
    expect(JSON.stringify(r)).not.toContain(env.BUILD_TOKEN)
    expect(r.machineId).toBe('m-1')
  })

  it('startBuild refuses an import that is not uploaded, and starts no second machine', async () => {
    const { id } = await building()
    await expect(startBuild(id)).rejects.toThrow()
    expect(fake.started).toHaveLength(1)
  })

  it('a machine that will not start fails the import and forgets the token', async () => {
    const id = await uploaded()
    fake.runner.fail = new Error('fly is down')
    await startBuild(id)
    const r = await row(id)
    expect(r.status).toBe('failed')
    expect(r.errorCode).toBe('build_failed')
    expect(r.buildTokenHash).toBeNull()
    expect((await store.get(`imports/${id}/build.log`))?.body.toString()).toMatch(/could not start/)
  })

  it('the fly runner starts a 2-CPU, 4 GB build machine from SCENE_BUILD_IMAGE in the build app', async () => {
    const calls: unknown[] = []
    const fly = {
      createBuildMachine: async (app: string, spec: unknown) => { calls.push([app, spec]); return { id: 'f1' } },
      deleteMachine: async (app: string, id: string) => { calls.push(['delete', app, id]) },
    }
    const r = flyBuildRunner(fly as any, 'virvi-scene-builds', 'registry.fly.io/virvi-scene-builds:abc')
    expect(await r.start('i1', { A: 'b' })).toEqual({ machineId: 'f1' })
    await r.stop('f1')
    expect(calls).toEqual([
      ['virvi-scene-builds', { name: 'build-i1', image: 'registry.fly.io/virvi-scene-builds:abc', env: { A: 'b' }, cpus: 2, memoryMb: 4096 }],
      ['delete', 'virvi-scene-builds', 'f1'],
    ])
  })

  it('off has no runner, and local is refused in cloud mode', async () => {
    setBuildRunner(null)
    ;(config as any).sceneBuildRunner = 'off'
    expect(getBuildRunner()).toBeNull()
    expect(buildsAvailable()).toBe(false)
    ;(config as any).sceneBuildRunner = 'local'
    expect(getBuildRunner()).not.toBeNull()
    ;(config as any).mode = 'cloud'
    expect(getBuildRunner()).toBeNull()
    expect(buildsAvailable()).toBe(false)
  })

  it('source needs the build token', async () => {
    const { id, token } = await building()
    const url = `${B}/${id}/source`
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url, headers: auth('x'.repeat(43)) })).statusCode).toBe(401)
    const other = await building()
    expect((await app.inject({ method: 'GET', url, headers: auth(other.token) })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: `${B}/not-a-uuid/source`, headers: auth(token) })).statusCode).toBe(401)
    const res = await app.inject({ method: 'GET', url, headers: auth(token) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/zip/)
    expect(res.rawPayload.equals(SOURCE)).toBe(true)
    // Not building any more (the token still matches): 409
    await db.update(sceneImports).set({ status: 'uploaded' }).where(eq(sceneImports.id, id))
    expect((await app.inject({ method: 'GET', url, headers: auth(token) })).statusCode).toBe(409)
  })

  it('result stores the built files and calls onBuildDone', async () => {
    const { id, token } = await building()
    const res = await postResult(id, token, builtZip())
    expect(res.statusCode).toBe(204)
    expect((await store.get(`imports/${id}/built/scene.json`))?.body.toString()).toBe(SCENE_JSON)
    expect((await store.get(`imports/${id}/built/bin/index.js`))?.body.toString()).toBe('main()')
    expect((await store.get(`imports/${id}/build.log`))?.body.toString()).toBe('build ok')
    const r = await row(id)
    expect(r.status).toBe('built')
    expect(r.builtAt).toBeInstanceOf(Date)
    expect(r.builtKeyPrefix).toBe(`imports/${id}/built/`)
    expect(r.logKey).toBe(`imports/${id}/build.log`)
    expect(r.buildTokenHash).toBeNull()
    await vi.waitFor(() => expect(done).toEqual([id]))
  })

  it('a result while two imports are being processed answers 503 imports_busy, and the build is not failed', async () => {
    const { id, token } = await building()
    const held = [resultWork.tryTake()!, resultWork.tryTake()!]
    const busy = await postResult(id, token, builtZip())
    expect([busy.statusCode, busy.json().error]).toEqual([503, 'imports_busy'])
    expect(await row(id)).toMatchObject({ status: 'building' })
    expect((await row(id)).buildTokenHash).not.toBeNull()
    held.forEach((release) => release())
    expect((await postResult(id, token, builtZip())).statusCode).toBe(204)
    expect(resultWork.inUse()).toBe(0)
    // A request without the token never takes a slot
    expect((await postResult(id, 'nope', builtZip())).statusCode).toBe(401)
    expect(resultWork.inUse()).toBe(0)
  })

  it('a build result goes through while two uploads hold the upload pool (results have their own)', async () => {
    const { id, token } = await building()
    const held = [uploadWork.tryTake(), uploadWork.tryTake()]
    expect(held.every(Boolean)).toBe(true)
    try {
      expect((await postResult(id, token, builtZip())).statusCode).toBe(204)
      expect(resultWork.inUse()).toBe(0)
    } finally {
      held.forEach((release) => release!())
    }
  })

  it('a missing or malformed X-Build-Log does not fail a good build', async () => {
    for (const log of [null, '%%%not base64%%%']) {
      const { id, token } = await building()
      expect((await postResult(id, token, builtZip(), log)).statusCode).toBe(204)
      const r = await row(id)
      expect(r.status).toBe('built')
      expect(r.logKey).toBeNull()
      expect(await store.get(`imports/${id}/build.log`)).toBeNull()
    }
  })

  it.each([
    ['an unsafe path', () => builtZip({ 'scene.json': '{}', '../evil.js': 'x' })],
    ['an absolute path', () => builtZip({ 'scene.json': '{}', '/etc/evil': 'x' })],
    ['a backslash path', () => builtZip({ 'scene.json': '{}', 'bin\\evil.js': 'x' })],
    ['a duplicate path', () => builtZip({ 'scene.json': '{}', 'a/./b.js': 'x', 'a/b.js': 'y' })],
    ['no scene.json', () => builtZip({ 'bin/index.js': 'x' })],
    ['not a zip', () => Buffer.from('not a zip at all')],
  ])('a refused result (%s) fails the import and stores nothing built', async (_name, zip) => {
    const { id, token } = await building()
    const res = await postResult(id, token, zip())
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
    expect(res.body).not.toContain(token)
    const r = await row(id)
    expect(r.status).toBe('failed')
    expect(r.errorCode).toBe('build_failed')
    expect(r.buildTokenHash).toBeNull()
    expect(store.keys().filter((k) => k.includes('/built/'))).toEqual([])
    const log = (await store.get(`imports/${id}/build.log`))?.body.toString() ?? ''
    expect(log).toContain('build ok')
    expect(log).toMatch(/refused/)
    // The box's failure report that follows is 401 and changes nothing
    expect((await postFailed(id, token, 'box log')).statusCode).toBe(401)
    expect((await store.get(`imports/${id}/build.log`))?.body.toString()).toBe(log)
    expect(done).toEqual([])
  })

  it('a result over the size limit fails the import', async () => {
    const { id, token } = await building()
    const res = await app.inject({
      method: 'POST', url: `${B}/${id}/result`, payload: builtZip(),
      headers: { ...auth(token), 'content-type': 'application/zip', 'content-length': String(201 * 1024 * 1024) },
    })
    expect(res.statusCode).toBe(413)
    const r = await row(id)
    expect(r.status).toBe('failed')
    expect(r.errorCode).toBe('build_failed')
    expect(r.buildTokenHash).toBeNull()
  })

  it('failed stores the log and fails the import', async () => {
    const { id, token } = await building()
    const res = await postFailed(id, token, 'npm ERR! missing script: build')
    expect(res.statusCode).toBe(204)
    const r = await row(id)
    expect(r.status).toBe('failed')
    expect(r.errorCode).toBe('build_failed')
    expect(r.errorMessage).toBe("The scene didn't build. The build log says why.")
    expect(r.buildTokenHash).toBeNull()
    expect(r.finishedAt).toBeInstanceOf(Date)
    expect(r.logKey).toBe(`imports/${id}/build.log`)
    expect((await store.get(`imports/${id}/build.log`))?.body.toString()).toBe('npm ERR! missing script: build')
    expect(done).toEqual([])
  })

  it("a used token can't post twice", async () => {
    const { id, token } = await building()
    expect((await postResult(id, token, builtZip())).statusCode).toBe(204)
    expect((await postResult(id, token, builtZip({ 'scene.json': '{}', 'other.js': 'x' }))).statusCode).toBe(401)
    // A failure report after the result was taken changes nothing
    expect((await postFailed(id, token, 'late failure')).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: `${B}/${id}/source`, headers: auth(token) })).statusCode).toBe(401)
    const r = await row(id)
    expect(r.status).toBe('built')
    expect(r.errorCode).toBeNull()
    expect((await store.get(`imports/${id}/build.log`))?.body.toString()).toBe('build ok')
    expect(await store.get(`imports/${id}/built/other.js`)).toBeNull()

    const second = await building()
    expect((await postFailed(second.id, second.token, 'first')).statusCode).toBe(204)
    expect((await postFailed(second.id, second.token, 'second')).statusCode).toBe(401)
    expect((await store.get(`imports/${second.id}/build.log`))?.body.toString()).toBe('first')
  })

  it('a build silent for 15 minutes fails and its machine goes', async () => {
    const stuck = await building()
    const recent = await building()
    const now = new Date()
    await db.update(sceneImports).set({ updatedAt: new Date(now.getTime() - 16 * 60_000) }).where(eq(sceneImports.id, stuck.id))
    await db.update(sceneImports).set({ updatedAt: new Date(now.getTime() - 5 * 60_000) }).where(eq(sceneImports.id, recent.id))
    expect(await sweepBuilds(now)).toBe(1)
    const r = await row(stuck.id)
    expect(r.status).toBe('failed')
    expect(r.errorCode).toBe('build_timeout')
    expect(r.errorMessage).toBe('The build took longer than 15 minutes and was stopped.')
    expect(r.buildTokenHash).toBeNull()
    expect(fake.stopped).toEqual(['m-1'])
    expect((await row(recent.id)).status).toBe('building')
    // Its late result is refused
    expect((await postResult(stuck.id, stuck.token, builtZip())).statusCode).toBe(401)
    expect(await sweepBuilds(now)).toBe(0)
  })

  it('an upload whose build never started fails after 15 minutes, with no machine to stop', async () => {
    const stuck = await uploaded()
    const recent = await uploaded()
    const now = new Date()
    await db.update(sceneImports).set({ updatedAt: new Date(now.getTime() - 16 * 60_000) }).where(eq(sceneImports.id, stuck))
    await db.update(sceneImports).set({ updatedAt: new Date(now.getTime() - 5 * 60_000) }).where(eq(sceneImports.id, recent))
    expect(await sweepBuilds(now)).toBe(1)
    const r = await row(stuck)
    expect(r).toMatchObject({ status: 'failed', errorCode: 'build_timeout', errorMessage: 'The build took longer than 15 minutes and was stopped.' })
    expect(r.finishedAt).toBeTruthy()
    expect(fake.stopped).toEqual([])
    expect((await row(recent)).status).toBe('uploaded')
  })
})
