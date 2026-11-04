import { describe, it, expect } from 'vitest'
import { WrongWalletError, type SignSession } from '../dcl-sign'
import {
  deployVirvi, emptyMemory, grantVirvi, GRANT_PARTIAL_MESSAGE, jumpInUrl, progressLines, publishSigned, revokeVirvi, runWizard,
  watchDeployment, wizardErrorMessage, type RevokeApi, type RunApi, type RunDeps, type RunPlan, type RunUpdate,
} from './run'

const apiError = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(String(body.error ?? `API error ${status}`)), { status, body })

const dest = (over: Record<string, unknown> = {}) => ({ id: 'dest-1', mode: 'virvi', grantedAt: null, ...over }) as any

const plan = (over: Partial<RunPlan> = {}): RunPlan => ({
  name: 'My park',
  plot: { width: 1, depth: 1, base: { x: 0, y: 0 } },
  spawn: { x: 8, z: 1 },
  items: [{ assetId: 'a1', x: 4, z: 4, rotationY: 0 }],
  dcl: { world: 'cafe.dcl.eth', wallet: '0xabc', mode: 'virvi' },
  hyperfy: null,
  ar: null,
  ...over,
})

/** A fake API recording calls; `script` overrides individual methods. */
function fakeApi(script: Partial<Record<keyof RunApi, (...args: any[]) => any>> = {}) {
  const calls: string[] = []
  let polls = 0
  const base: RunApi = {
    bootstrapWizardScene: async () => ({ sceneId: 'scene-1' }),
    createDclDestination: async () => ({ destination: dest() }),
    patchDclDestination: async (_id, { mode }) => ({ destination: dest({ mode }) }),
    getDclDestination: async () => ({ destination: dest(), lastDeployment: { id: 'dep-busy', sceneId: 'scene-1', status: 'deploying' } }),
    getDclGrant: async () => ({
      virviAddress: '0xvirvi',
      requests: (['grant', 'scope', 'rollback'] as const).map((purpose, i) => ({
        method: 'PUT' as const, path: `/p${i}`, metadata: '{}', timestamp: 1000 + polls, payload: `payload-${purpose}`, purpose,
      })),
    }),
    submitDclGrant: async () => ({ destination: dest({ grantedAt: '2026-10-25T00:00:00Z' }) }),
    deployDclDestination: async () => ({ deployment: { id: 'dep-1', sceneId: 'scene-1', status: 'building' } }),
    submitDeploySignature: async () => ({ deployment: { id: 'dep-1', sceneId: 'scene-1', status: 'deployed' } }),
    getDeployment: async (id: string) => {
      polls++
      return { deployment: { id, sceneId: 'scene-1', status: polls < 2 ? 'deploying' : 'deployed', assetBundle: { progress: { modelsTotal: 3 } } } }
    },
    createHyperfyWorld: async (d) => ({ world: { name: d.name }, key: 'key-1' }),
    createHostedHyperfyWorld: async (d) => ({ world: { name: d.name, address: 'x.hyperfy.xyz' }, adminCode: 'code' }),
    createArSpace: async () => ({}),
  }
  const api = Object.fromEntries(
    Object.entries(base).map(([k, fn]) => [k, async (...args: any[]) => {
      calls.push(k)
      return (script[k as keyof RunApi] ?? fn)(...args)
    }]),
  ) as unknown as RunApi
  return { api, calls }
}

function deps(api: RunApi, over: Partial<RunDeps> = {}) {
  const signed: string[] = []
  let sessions = 0
  const d: RunDeps = {
    api,
    wallet: () => ({ request: async () => null }),
    startSession: async () => {
      sessions++
      return { address: '0xabc', sign: (p: string) => { signed.push(p); return [{ type: 'SIGNER', payload: p, signature: '' }] as any } } as SignSession
    },
    sleep: async () => {},
    ...over,
  }
  return { deps: d, signed, sessions: () => sessions }
}

const collect = () => {
  const updates: RunUpdate[] = []
  return { updates, on: (u: RunUpdate) => updates.push(u) }
}

describe('runWizard, mode virvi', () => {
  it('creates, grants with one session, deploys and polls until live', async () => {
    const { api, calls } = fakeApi()
    const d = deps(api)
    const mem = emptyMemory()
    const { updates, on } = collect()
    await runWizard(plan(), mem, d.deps, on)
    expect(calls).toEqual([
      'bootstrapWizardScene', 'createDclDestination', 'getDclGrant', 'submitDclGrant', 'deployDclDestination', 'getDeployment', 'getDeployment',
    ])
    expect(d.signed).toEqual(['payload-grant', 'payload-scope', 'payload-rollback'])
    expect(d.sessions()).toBe(1)
    expect(mem).toMatchObject({ sceneId: 'scene-1', deploymentId: 'dep-1' })
    expect(updates.at(-1)).toMatchObject({ phase: 'live', models: 3 })
  })

  it('submits the chains with requests[0].timestamp', async () => {
    let body: any
    const { api } = fakeApi({ submitDclGrant: async (_id: string, b: any) => { body = b; return { destination: dest({ grantedAt: 'x' }) } } })
    await runWizard(plan(), emptyMemory(), deps(api).deps, () => {})
    expect(body.timestamp).toBe(1000)
    expect(body.chains).toHaveLength(3)
  })

  it('re-fetches and re-signs an expired grant without asking the wallet again', async () => {
    let tries = 0
    const { api, calls } = fakeApi({
      submitDclGrant: async () => {
        if (tries++ === 0) throw apiError(400, { error: 'expired', message: 'too slow' })
        return { destination: dest({ grantedAt: 'x' }) }
      },
    })
    const d = deps(api)
    await runWizard(plan(), emptyMemory(), d.deps, () => {})
    expect(calls.filter((c) => c === 'getDclGrant')).toHaveLength(2)
    expect(d.signed).toHaveLength(6)
    expect(d.sessions()).toBe(1)
  })

  it('polls the running deploy on deploy_in_progress', async () => {
    const { api, calls } = fakeApi({ deployDclDestination: async () => { throw apiError(409, { error: 'deploy_in_progress', message: 'busy' }) } })
    const mem = emptyMemory()
    await runWizard(plan(), mem, deps(api).deps, () => {})
    expect(calls).toContain('getDclDestination')
    expect(mem.deploymentId).toBe('dep-busy')
  })

  it('turns grant_partial into the plain World-wide warning', async () => {
    const { api } = fakeApi({ submitDclGrant: async () => { throw apiError(502, { error: 'grant_partial', message: 'server text' }) } })
    const err = await runWizard(plan(), emptyMemory(), deps(api).deps, () => {}).catch((e) => e)
    expect(err.partial).toBe(true)
    expect(err.message).toBe(GRANT_PARTIAL_MESSAGE)
  })

  it('says world_unreachable plainly', async () => {
    const { api } = fakeApi({ createDclDestination: async () => { throw apiError(502, { error: 'world_unreachable' }) } })
    const err = await runWizard(plan(), emptyMemory(), deps(api).deps, () => {}).catch((e) => e)
    expect(err.message).toBe("Decentraland didn't answer just now. Try again in a minute.")
  })

  it('reports a failed deployment with the server message', async () => {
    const { api } = fakeApi({ getDeployment: async () => ({ deployment: { id: 'dep-1', status: 'failed', errorMessage: 'Decentraland rejected the deploy: bad' } }) })
    const err = await runWizard(plan(), emptyMemory(), deps(api).deps, () => {}).catch((e) => e)
    expect(err.message).toBe('Decentraland rejected the deploy: bad')
  })

  it('try again reuses the scene, destination and grant', async () => {
    let fail = true
    const { api, calls } = fakeApi({
      deployDclDestination: async () => {
        if (fail) { fail = false; throw apiError(502, { error: 'world_unreachable' }) }
        return { deployment: { id: 'dep-2', status: 'building' } }
      },
    })
    const d = deps(api)
    const mem = emptyMemory()
    await expect(runWizard(plan(), mem, d.deps, () => {})).rejects.toThrow()
    calls.length = 0
    await runWizard(plan(), mem, d.deps, () => {})
    expect(calls).not.toContain('bootstrapWizardScene')
    expect(calls).not.toContain('createDclDestination')
    expect(calls).not.toContain('getDclGrant')
    expect(d.sessions()).toBe(1)
    expect(mem.deploymentId).toBe('dep-2')
  })

  it('switches the destination mode on a retry with the other mode', async () => {
    const { api, calls } = fakeApi()
    const mem = emptyMemory()
    mem.sceneId = 'scene-1'
    mem.destination = dest({ mode: 'virvi' })
    await runWizard(plan({ dcl: { world: 'cafe.dcl.eth', wallet: '0xabc', mode: 'sign' } }), mem, deps(api, {
      api: { ...api, deployDclDestination: async () => ({ deployment: { id: 'dep-3', sceneId: 's', status: 'awaiting_signature' }, payload: 'entity' }) },
    }).deps, () => {})
    expect(calls[0]).toBe('patchDclDestination')
    expect(mem.destination?.mode).toBe('sign')
  })
})

describe('runWizard, mode sign', () => {
  const signPlan = plan({ dcl: { world: 'cafe.dcl.eth', wallet: '0xabc', mode: 'sign' } })
  const prepared = (id: string) => ({ deployment: { id, sceneId: 'scene-1', status: 'awaiting_signature', assetBundle: { added: ['a', 'b'] } }, payload: `entity-${id}` })

  it('prepares, signs the entity id and finishes without polling', async () => {
    const { api, calls } = fakeApi({ deployDclDestination: async () => prepared('dep-1') })
    const d = deps(api)
    const { updates, on } = collect()
    await runWizard(signPlan, emptyMemory(), d.deps, on)
    expect(calls).toEqual(['bootstrapWizardScene', 'createDclDestination', 'deployDclDestination', 'submitDeploySignature'])
    expect(d.signed).toEqual(['entity-dep-1'])
    expect(updates).toContainEqual({ phase: 'uploading', models: 2 })
    expect(updates.at(-1)).toMatchObject({ phase: 'live' })
  })

  it('prepares again and signs once more on 409 expired', async () => {
    let n = 0
    let first = true
    const { api } = fakeApi({
      deployDclDestination: async () => prepared(`dep-${++n}`),
      submitDeploySignature: async (id: string) => {
        if (first) { first = false; throw apiError(409, { error: 'expired', message: 'late' }) }
        return { deployment: { id, status: 'deployed' } }
      },
    })
    const d = deps(api)
    const mem = emptyMemory()
    await runWizard(signPlan, mem, d.deps, () => {})
    expect(d.signed).toEqual(['entity-dep-1', 'entity-dep-2'])
    expect(d.sessions()).toBe(1)
    expect(mem.deploymentId).toBe('dep-2')
  })

  it('stops with the wrong-wallet message', async () => {
    const { api } = fakeApi()
    const err = await runWizard(signPlan, emptyMemory(), deps(api, { startSession: async () => { throw new WrongWalletError('0xabc') } }).deps, () => {}).catch((e) => e)
    expect(err.message).toBe('Switch your wallet to 0xabc and try again.')
  })
})

describe('runWizard, other destinations', () => {
  it('tells the bootstrap whether Decentraland limits apply', async () => {
    const bodies: any[] = []
    const { api } = fakeApi({ bootstrapWizardScene: async (b: any) => { bodies.push(b); return { sceneId: 's' } } })
    await runWizard(plan({ dcl: null, ar: { name: 'A' } }), emptyMemory(), deps(api).deps, () => {})
    await runWizard(plan(), emptyMemory(), deps(api).deps, () => {})
    expect(bodies.map((b) => b.dcl)).toEqual([false, true])
  })

  it('sends the room set with the scene', async () => {
    const bodies: any[] = []
    const { api } = fakeApi({ bootstrapWizardScene: async (b: any) => { bodies.push(b); return { sceneId: 's' } } })
    const options = { style: 'house' as const, wallColor: '#E8E6E1', floorColor: '#B9A68C', ceiling: false, furniture: true }
    await runWizard(plan({ dcl: null, ar: { name: 'A' }, roomSet: { scanId: 'scan-1', options } }), emptyMemory(), deps(api).deps, () => {})
    await runWizard(plan({ dcl: null, ar: { name: 'A' } }), emptyMemory(), deps(api).deps, () => {})
    expect(bodies[0].roomSet).toEqual({ scanId: 'scan-1', options })
    expect('roomSet' in bodies[1]).toBe(false)
  })

  it('Hyperfy and AR only: no wallet, no deploy', async () => {
    const { api, calls } = fakeApi()
    const mem = emptyMemory()
    const d = deps(api)
    const { updates, on } = collect()
    await runWizard(plan({ dcl: null, hyperfy: { kind: 'self', name: 'My world' }, ar: { name: 'Lobby' } }), mem, d.deps, on)
    expect(calls).toEqual(['bootstrapWizardScene', 'createHyperfyWorld', 'createArSpace'])
    expect(d.sessions()).toBe(0)
    expect(mem.hyperfy).toEqual({ kind: 'self', worldName: 'My world', key: 'key-1' })
    expect(updates.at(-1)).toMatchObject({ phase: 'live' })
  })

  it('a Hyperfy failure is reported but does not stop the World deploy, and is retried once', async () => {
    let fail = true
    const { api, calls } = fakeApi({
      createHyperfyWorld: async (d: any) => {
        if (fail) { fail = false; throw apiError(403, { error: 'upgrade_required' }) }
        return { world: { name: d.name }, key: 'k' }
      },
    })
    const mem = emptyMemory()
    const { updates, on } = collect()
    await runWizard(plan({ hyperfy: { kind: 'self', name: 'W' } }), mem, deps(api).deps, on)
    expect(updates.find((u) => u.hyperfyError)?.hyperfyError).toMatch(/Upgrade/)
    expect(mem.hyperfy).toBeNull()
    calls.length = 0
    await runWizard(plan({ hyperfy: { kind: 'self', name: 'W' } }), mem, deps(api).deps, () => {})
    expect(calls).toContain('createHyperfyWorld')
    expect(mem.hyperfy?.kind).toBe('self')
  })
})

describe('wizardErrorMessage', () => {
  it('prefers the server message, maps codes, and never shows a raw code', () => {
    expect(wizardErrorMessage(apiError(400, { error: 'over_budget', message: 'This plot fits 10,000 triangles' }))).toBe('This plot fits 10,000 triangles')
    expect(wizardErrorMessage(apiError(403, { error: 'not_world_owner' }))).toMatch(/wallet that owns the name/)
    expect(wizardErrorMessage(apiError(400, { error: 'some_new_code' }))).toBe('Something went wrong. Try again in a moment.')
    expect(wizardErrorMessage(apiError(422, { error: 'over_budget' }))).toMatch(/past Decentraland's limits/)
    expect(wizardErrorMessage(apiError(409, { error: 'nothing_to_deploy' }))).toMatch(/already has everything/)
    expect(wizardErrorMessage(apiError(500, { error: 'HTTP 500' }))).toBe('Something went wrong on our side. Try again in a moment.')
    expect(wizardErrorMessage(apiError(400, { error: 'name is required (up to 120 characters)' }))).toBe('name is required (up to 120 characters)')
    expect(wizardErrorMessage(Object.assign(new Error('User rejected'), { code: 4001 }))).toMatch(/cancelled/)
  })
})

describe('progress and Jump in', () => {
  it('marks lines done up to the phase', () => {
    expect(progressLines('uploading', 14).map((l) => [l.label, l.state])).toEqual([
      ['Packing your scene', 'done'],
      ['Uploading 14 models', 'active'],
      ['Decentraland is checking it', 'todo'],
      ['Live', 'todo'],
    ])
    expect(progressLines('live', 1).every((l) => l.state === 'done')).toBe(true)
    expect(progressLines('packing', null, true)[0].state).toBe('failed')
  })

  it('opens the World in the web explorer', () => {
    expect(jumpInUrl('cafe.dcl.eth')).toBe('https://decentraland.org/play/?realm=cafe.dcl.eth')
    expect(jumpInUrl({ kind: 'world', world: 'cafe.dcl.eth' })).toBe('https://decentraland.org/play/?realm=cafe.dcl.eth')
    expect(jumpInUrl({ kind: 'parcels', base: '10,20', parcels: ['10,20'] })).toBe('https://decentraland.org/play/?position=10,20')
  })
})

describe('signing helpers (deploy and publish pages)', () => {
  const signer = () => {
    const signed: string[] = []
    return { signed, s: { address: '0xabc', sign: (p: string) => { signed.push(p); return [{ type: 'SIGNER', payload: p, signature: '' }] as any } } as SignSession }
  }

  it('grantVirvi signs every request in order and submits requests[0].timestamp', async () => {
    let body: any
    const { api, calls } = fakeApi({ submitDclGrant: async (_id: string, b: any) => { body = b; return { destination: dest({ grantedAt: 'x' }) } } })
    const { s, signed } = signer()
    const out = await grantVirvi('dest-1', s, api)
    expect(out.grantedAt).toBe('x')
    expect(calls).toEqual(['getDclGrant', 'submitDclGrant'])
    expect(signed).toEqual(['payload-grant', 'payload-scope', 'payload-rollback'])
    expect(body).toMatchObject({ timestamp: 1000, chains: [expect.any(Array), expect.any(Array), expect.any(Array)] })
  })

  it('revokeVirvi fetches, signs and submits, re-fetching once on expired', async () => {
    const calls: string[] = []
    let tries = 0
    const api: RevokeApi = {
      getDclRevoke: async () => { calls.push('get'); return { requests: [{ method: 'DELETE', path: '/p', metadata: '{}', timestamp: 7 + tries, payload: `revoke-${tries}` }] } },
      submitDclRevoke: async (_id, b) => {
        calls.push(`post:${b.timestamp}`)
        if (tries++ === 0) throw apiError(400, { error: 'expired' })
        return { destination: dest({ mode: 'sign' }) }
      },
    }
    const { s, signed } = signer()
    expect((await revokeVirvi('dest-1', s, api)).mode).toBe('sign')
    expect(calls).toEqual(['get', 'post:7', 'get', 'post:8'])
    expect(signed).toEqual(['revoke-0', 'revoke-1'])
  })

  it('revokeVirvi gives up after repeated expiry', async () => {
    const api: RevokeApi = {
      getDclRevoke: async () => ({ requests: [{ method: 'DELETE', path: '/p', metadata: '{}', timestamp: 1, payload: 'x' }] }),
      submitDclRevoke: async () => { throw apiError(400, { error: 'expired' }) },
    }
    await expect(revokeVirvi('dest-1', signer().s, api)).rejects.toMatchObject({ body: { error: 'expired' } })
  })

  it('publishSigned prepares, signs and submits; prepares once more on expired', async () => {
    let n = 0
    const { api, calls } = fakeApi({
      deployDclDestination: async () => ({ deployment: { id: `dep-${++n}`, sceneId: 's', status: 'awaiting_signature', assetBundle: { added: [1, 2, 3] } }, payload: `entity-${n}` }),
      submitDeploySignature: async (id: string) => {
        if (id === 'dep-1') throw apiError(409, { error: 'expired' })
        return { deployment: { id, sceneId: 's', status: 'deploying' } }
      },
    })
    const { s, signed } = signer()
    const { updates, on } = collect()
    const out = await publishSigned('dest-1', s, api, on)
    expect(out).toMatchObject({ deploymentId: 'dep-2', settled: { status: 'deploying' } })
    expect(calls).toEqual(['deployDclDestination', 'submitDeploySignature', 'deployDclDestination', 'submitDeploySignature'])
    expect(signed).toEqual(['entity-1', 'entity-2'])
    expect(updates).toContainEqual({ phase: 'uploading', models: 3 })
  })

  it('publishSigned follows a deploy already running', async () => {
    const { api } = fakeApi({ deployDclDestination: async () => { throw apiError(409, { error: 'deploy_in_progress' }) } })
    expect(await publishSigned('dest-1', signer().s, api)).toEqual({ deploymentId: 'dep-busy', settled: null })
  })

  it('deployVirvi starts a deploy, or follows the running one', async () => {
    expect(await deployVirvi('dest-1', fakeApi().api)).toBe('dep-1')
    const busy = fakeApi({ deployDclDestination: async () => { throw apiError(409, { error: 'deploy_in_progress' }) } })
    expect(await deployVirvi('dest-1', busy.api)).toBe('dep-busy')
  })

  it('watchDeployment polls to live, and throws the refusal on failed', async () => {
    const { api } = fakeApi()
    const { updates, on } = collect()
    await watchDeployment('dep-1', null, { api, sleep: async () => {} }, on)
    expect(updates.at(-1)).toMatchObject({ phase: 'live', models: 3 })

    const failed = fakeApi({ getDeployment: async (id: string) => ({ deployment: { id, status: 'failed', errorMessage: 'Decentraland rejected the deploy: too big' } }) })
    await expect(watchDeployment('dep-1', null, { api: failed.api, sleep: async () => {} }, () => {}))
      .rejects.toMatchObject({ name: 'RunError', message: 'Decentraland rejected the deploy: too big' })
  })
})
