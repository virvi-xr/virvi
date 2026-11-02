import { describe, it, expect } from 'vitest'
import type { SceneImportStatus, SceneImportView } from '@virvixr/shared'
import { importErrorMessage, importFailure, importLines, importPhase, watchImport, IMPORT_FALLBACK_MESSAGE } from './import'

const view = (over: Partial<SceneImportView> = {}): SceneImportView => ({
  id: 'imp-1',
  sceneId: 'scene-1',
  worldName: 'cafe.dcl.eth',
  kind: 'creator-hub',
  status: 'building',
  errorCode: null,
  errorMessage: null,
  deploymentId: null,
  destinationId: null,
  canDeploy: false,
  logTail: null,
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
    'parcels_not_yet', 'not_world_owner', 'world_unreachable', 'world_in_use', 'world_set_up_elsewhere', 'import_in_progress',
    'superseded', 'store_failed', 'not_deployable', 'not_found', 'no_log', 'invalid_scene',
    // build-runner.ts, build-sweep.ts, import-build.ts
    'build_failed', 'build_timeout', 'build_start_failed', 'builds_unavailable', 'not_uploaded',
    // import-work.ts (I5)
    'imports_busy',
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

describe('importLines', () => {
  it('marks the steps done up to the phase, and the failing one', () => {
    expect(importLines('building', 'cafe.dcl.eth').map((l) => l.state)).toEqual(['done', 'active', 'todo', 'todo'])
    expect(importLines('live', 'cafe.dcl.eth').map((l) => l.state)).toEqual(['done', 'done', 'done', 'done'])
    expect(importLines('failed', 'cafe.dcl.eth', view({ status: 'failed', errorCode: 'build_failed' })).map((l) => l.state))
      .toEqual(['done', 'failed', 'todo', 'todo'])
    expect(importLines('failed', 'cafe.dcl.eth', view({ status: 'failed', errorCode: 'deploy_rejected', deploymentId: 'd1' })).map((l) => l.state))
      .toEqual(['done', 'done', 'failed', 'todo'])
    // A replaced import didn't fail anywhere (review M7)
    expect(importLines('failed', 'cafe.dcl.eth', view({ status: 'failed', errorCode: 'superseded' })).map((l) => l.state))
      .toEqual(['done', 'done', 'todo', 'todo'])
    expect(importLines('ready', 'cafe.dcl.eth')[2]).toMatchObject({ label: 'Deploy to cafe.dcl.eth', state: 'active' })
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
