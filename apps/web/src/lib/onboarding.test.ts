import { describe, expect, it } from 'vitest'
import { funnelRows, nextStep, progressLine, showChecklist, stepView, type Onboarding } from './onboarding'

const o = (done: boolean[], extra: Partial<Onboarding> = {}): Onboarding => ({
  steps: (['create', 'content', 'deploy', 'live'] as const).map((id, i) => ({ id, done: done[i] })),
  complete: done.every(Boolean), sceneId: 's1', dismissedAt: null, ...extra,
})

describe('getting-started checklist (LIV-37)', () => {
  it('shows while a step is left and it is not hidden', () => {
    expect(showChecklist(o([true, false, false, false]))).toBe(true)
    expect(showChecklist(o([true, true, true, true]))).toBe(false)
    expect(showChecklist(o([false, false, false, false], { dismissedAt: '2026-11-27T00:00:00Z' }))).toBe(false)
    expect(showChecklist(null)).toBe(false)
  })
  it('says how far along it is and what is next', () => {
    expect(progressLine(o([true, true, false, false]))).toBe('2 of 4 done')
    expect(nextStep(o([true, true, false, false]))).toBe('deploy')
    expect(nextStep(o([true, true, true, true]))).toBeNull()
  })
  it('links each step to where it is done and to its guide section', () => {
    expect(stepView('create', null)).toMatchObject({ href: '/scenes/new', docs: '/docs/getting-started/first-scene/#create-a-scene' })
    expect(stepView('content', 's1').href).toBe('/scenes/s1')
    expect(stepView('deploy', 's1').href).toBe('/sync?scene=s1')
    expect(stepView('live', null).docs).toBe('/docs/getting-started/first-scene/#see-it-live')
  })
  it('the admin funnel gives each step a share of sign-ups', () => {
    expect(funnelRows({ accounts: 4, steps: [{ id: 'create', accounts: 2 }, { id: 'live', accounts: 0 }] })).toEqual([
      { label: 'Signed up', count: 4, percent: '100%' },
      { label: 'Created a scene', count: 2, percent: '50%' },
      { label: 'Saw it live', count: 0, percent: '0%' },
    ])
    expect(funnelRows({ accounts: 0, steps: [] })[0].percent).toBe('0%')
  })
})
