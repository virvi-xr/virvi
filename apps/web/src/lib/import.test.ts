import { describe, it, expect } from 'vitest'
import type { SceneImportStatus, SceneImportView } from '@virvixr/shared'
import { buildLogShown, virviNote, importErrorMessage, importFailure, importLines, importPhase, placeLabel, recentImports, watchImport, IMPORT_FALLBACK_MESSAGE } from './import'

const view = (over: Partial<SceneImportView> = {}): SceneImportView => ({
  id: 'imp-1',
  sceneId: 'scene-1',
  worldName: 'cafe.dcl.eth',
  location: { kind: 'world', world: 'cafe.dcl.eth' },
  kind: 'creator-hub',
  status: 'building',
  errorCode: null,
  errorMessage: null,
  deploymentId: null,
  destinationId: null,
  canDeploy: false,
  logTail: null,
  filesExpired: false,
  virviAlreadyPresent: false,
  createdAt: '2026-11-01T00:00:00Z',
  ...over,
})

const apiError = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(String(body.error ?? `API error ${status}`)), { status, body })

describe('importPhase', () => {
  it('maps every status', () => {
    const cases: Array<[SceneImportStatus, boolean, ReturnType<typeof importPhase>]> = [
      ['uploaded', false, 'uploading'],
      ['building', false, 'building'],
      ['built', true, 'ready'],
      ['deploying', false, 'deploying'],
      ['awaiting_signature', false, 'sign'],
      ['awaiting_signature', true, 'ready'],
      ['deployed', false, 'live'],
      ['failed', false, 'failed'],
    ]
    for (const [status, canDeploy, phase] of cases) expect(importPhase(view({ status, canDeploy })), `${status} ${canDeploy}`).toBe(phase)
  })
})

describe('importErrorMessage', () => {
  // Every code the upload, build and deploy of an import can end with (services/import/*, routes/imports.ts,
  // routes/import-build.ts, services/dcl/world-deployer.ts, services/dcl/deployed-files.ts).
  const CODES = [
    // scene-zip.ts
    'not_a_zip', 'unsafe_path', 'too_many_files', 'too_big', 'no_scene_json', 'bad_scene_json', 'not_sdk7', 'bad_world_name',
    // install-virvi.ts (Ruling R8)
    'bad_package_json', 'bad_source_encoding', 'no_main',
    // routes/imports.ts, imports.ts, the owner check
    'not_parcel_controller', 'aetheria_managed', 'not_a_world', 'grant_revoked', 'catalyst_unreachable', 'parcels_in_use', 'parcels_set_up_elsewhere', 'not_world_owner', 'world_unreachable', 'world_in_use', 'world_set_up_elsewhere', 'import_in_progress',
    'superseded', 'store_failed', 'not_deployable', 'not_found', 'no_log', 'invalid_scene',
    // build-runner.ts, build-sweep.ts, import-build.ts
    'build_failed', 'build_timeout', 'build_start_failed', 'builds_unavailable', 'not_uploaded',
    // import-work.ts (I5)
    'imports_busy', 'upload_too_slow',
    // retention.ts (Ruling R27)
    'files_expired',
    // markFailed's and the sweep's codes for an import put back to built (R19)
    'interrupted', 'deploy_interrupted', 'cancelled',
    // import-deploy.ts, world-deployer.ts
    'scene_too_big', 'file_too_big', 'world_storage_full', 'world_changed', 'import_files_missing', 'virvi_deploys_unavailable',
    'expired', 'needs_review', 'over_budget', 'nothing_to_deploy', 'no_live_scene', 'deploy_failed', 'model_unavailable',
    'entity_mismatch', 'import_superseded', 'not_granted', 'deploy_in_progress', 'not_awaiting_signature', 'stale', 'deploy_rejected',
    // deployed-files.ts (what went live)
    'files_gone', 'files_unsafe', 'not_deployed',
  ]

  it('has a sentence for every code', () => {
    for (const code of CODES) {
      const m = importErrorMessage(code)
      expect(m, code).not.toBe(IMPORT_FALLBACK_MESSAGE)
      expect(m, code).toMatch(/^[A-Z].*[.]$/)
    }
  })

  it('says Virvi is busy in the same words as the server', () => {
    expect(importErrorMessage('imports_busy')).toBe('Virvi is busy with other imports. Try again in a minute.')
  })

  it('says an upload was too slow in the same words as the server (Ruling R29)', () => {
    expect(importErrorMessage('upload_too_slow')).toBe('The upload took too long. Try again on a faster connection, or remove large unused files from the scene.')
  })

  it("says Decentraland's directory being down in the catalyst's words (the grant card's GET)", () => {
    expect(importErrorMessage('directory_unavailable')).toBe(importErrorMessage('catalyst_unreachable'))
  })

  it('falls back to a plain sentence for a code it does not know', () => {
    expect(importErrorMessage('something_new')).toBe(IMPORT_FALLBACK_MESSAGE)
  })
})

describe('importFailure', () => {
  it("prefers the server's message, then the code's sentence, and keeps the import id (Ruling R18)", () => {
    expect(importFailure(apiError(502, { error: 'build_start_failed', message: 'The build machine is busy.', importId: 'imp-9' })))
      .toEqual({ message: 'The build machine is busy.', importId: 'imp-9' })
    expect(importFailure(apiError(422, { error: 'no_main' }))).toEqual({ message: importErrorMessage('no_main'), importId: null })
    expect(importFailure(apiError(409, { error: 'files_gone', message: "Some of this deploy's files are gone." })).message)
      .toBe("Some of this deploy's files are gone.")
    expect(importFailure(Object.assign(new Error('x'), { code: 4001 })).message).toMatch(/cancelled/)
  })
})

describe('placeLabel', () => {
  it('names a World, one parcel, or several', () => {
    expect(placeLabel({ kind: 'world', world: 'my.dcl.eth' })).toBe('my.dcl.eth')
    expect(placeLabel({ kind: 'parcels', base: '10,20', parcels: ['10,20'] })).toBe('Genesis City 10,20')
    expect(placeLabel({ kind: 'parcels', base: '10,20', parcels: ['10,20', '10,21', '11,20', '11,21'] })).toBe('Genesis City 10,20 (4 parcels)')
  })
})

describe('importLines', () => {
  const world = { kind: 'world', world: 'cafe.dcl.eth' } as const
  it('labels the deploy step with the place', () => {
    expect(importLines('ready', { kind: 'parcels', base: '1,2', parcels: ['1,2'] })[2].label).toBe('Deploy to Genesis City 1,2')
  })
  it('marks the steps done up to the phase, and the failing one', () => {
    expect(importLines('building', world).map((l) => l.state)).toEqual(['done', 'active', 'todo', 'todo'])
    expect(importLines('live', world).map((l) => l.state)).toEqual(['done', 'done', 'done', 'done'])
    expect(importLines('failed', world, view({ status: 'failed', errorCode: 'build_failed' })).map((l) => l.state))
      .toEqual(['done', 'failed', 'todo', 'todo'])
    expect(importLines('failed', world, view({ status: 'failed', errorCode: 'deploy_rejected', deploymentId: 'd1' })).map((l) => l.state))
      .toEqual(['done', 'done', 'failed', 'todo'])
    // A replaced import didn't fail anywhere (review M7)
    expect(importLines('failed', world, view({ status: 'failed', errorCode: 'superseded' })).map((l) => l.state))
      .toEqual(['done', 'done', 'todo', 'todo'])
    expect(importLines('ready', world)[2]).toMatchObject({ label: 'Deploy to cafe.dcl.eth', state: 'active' })
  })
})

describe('watchImport', () => {
  const run = async (statuses: SceneImportStatus[], cancelled?: () => boolean) => {
    let i = 0
    const seen: string[] = []
    const sleeps: number[] = []
    const api = { getSceneImport: async () => ({ import: view({ status: statuses[Math.min(i++, statuses.length - 1)] }) }) }
    const last = await watchImport('imp-1', { api, sleep: async (ms) => { sleeps.push(ms) }, cancelled }, (v) => seen.push(v.status))
    return { seen, sleeps, last, polls: i }
  }

  it('stops at deployed and at failed', async () => {
    const live = await run(['building', 'built', 'deploying', 'deployed', 'deployed'])
    expect(live.seen).toEqual(['building', 'built', 'deploying', 'deployed'])
    expect(live.last?.status).toBe('deployed')
    expect(live.sleeps).toEqual([2000, 2000, 2000])

    const failed = await run(['building', 'failed', 'built'])
    expect(failed.seen).toEqual(['building', 'failed'])
    expect(failed.polls).toBe(2)
  })

  it('stops when cancelled', async () => {
    let n = 0
    const r = await run(['building'], () => ++n > 2)
    expect(r.seen).toEqual(['building', 'building'])
    expect(r.last).toBeNull()
  })
})

describe('recentImports', () => {
  const now = new Date('2026-11-02T12:00:00Z')
  it('lists each import with its World, a status label and how long ago, linking to its view, newest first', () => {
    const items = recentImports([
      view({ id: 'a', worldName: 'old.dcl.eth', location: { kind: 'world', world: 'old.dcl.eth' }, status: 'deployed', createdAt: '2026-11-01T12:00:00Z' }),
      view({ id: 'b', worldName: 'new.dcl.eth', location: { kind: 'world', world: 'new.dcl.eth' }, status: 'built', canDeploy: true, createdAt: '2026-11-02T11:55:00Z' }),
      view({ id: 'c', worldName: 'gone.dcl.eth', location: { kind: 'world', world: 'gone.dcl.eth' }, status: 'failed', createdAt: '2026-11-02T09:00:00Z' }),
    ], now)
    expect(items).toEqual([
      { id: 'b', place: 'new.dcl.eth', label: 'Ready to deploy', tone: 'warning', when: '5 min ago', href: '/import/?id=b' },
      { id: 'c', place: 'gone.dcl.eth', label: 'Failed', tone: 'danger', when: '3 h ago', href: '/import/?id=c' },
      { id: 'a', place: 'old.dcl.eth', label: 'Live', tone: 'success', when: '1 day ago', href: '/import/?id=a' },
    ])
  })

  it('keeps at most 10', () => {
    const many = Array.from({ length: 12 }, (_, i) => view({ id: `i${i}`, createdAt: new Date(now.getTime() - i * 60_000).toISOString() }))
    expect(recentImports(many, now).map((i) => i.id)).toEqual(many.slice(0, 10).map((v) => v.id))
  })
})

describe('buildLogShown', () => {
  it("shows the log of a failed import, says its files are gone after 30 days, and shows nothing for a replaced one", () => {
    expect(buildLogShown(view({ status: 'failed', errorCode: 'build_failed' }))).toBe('log')
    expect(buildLogShown(view({ status: 'failed', errorCode: 'build_failed', filesExpired: true }))).toBe('expired')
    expect(buildLogShown(view({ status: 'failed', errorCode: 'superseded' }))).toBeNull()
    expect(importErrorMessage('files_expired')).toBe("This import's files were deleted after 30 days.")
  })
})

describe('virviNote', () => {
  it('says Virvi was already in the scene, and nothing otherwise', () => {
    expect(virviNote(view({ virviAlreadyPresent: true }))).toBe("Virvi was already in your scene, so it wasn't added again.")
    expect(virviNote(view())).toBeNull()
  })
})
