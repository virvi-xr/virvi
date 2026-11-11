import { describe, it, expect, vi } from 'vitest'
import { WARM_EVERY_MS, createWarmer, waitProgress, waitSteps } from './studio-wait'
import type { StudioEvent } from './studio'

const job = (status = 'queued') => ({ id: 'j1', status })
const phase = (p: string, jobId = 'j1'): StudioEvent => ({ type: 'phase', jobId, phase: p })
const progress = (text: string, jobId = 'j1'): StudioEvent => ({ type: 'progress', jobId, text })
const taken: StudioEvent = { type: 'job', jobId: 'j1', status: 'taken' }
const states = (s: ReturnType<typeof waitSteps>) => s && s.map((x) => `${x.label}: ${x.state}`)

describe('the steps before the first reply', () => {
  it('a queued prompt is starting the studio', () => {
    expect(states(waitSteps(job(), []))).toEqual([
      'Starting your studio: current',
      'The agent is reading your request: todo',
    ])
  })

  it('a worker that checks the request shows the check, then the agent reading it', () => {
    expect(states(waitSteps(job(), [taken, phase('screening')]))).toEqual([
      'Starting your studio: done',
      'Checking your request: current',
      'The agent is reading your request: todo',
    ])
    expect(states(waitSteps(job('taken'), [taken, phase('screening'), phase('building')]))).toEqual([
      'Starting your studio: done',
      'Checking your request: done',
      'The agent is reading your request: current',
    ])
  })

  it('a worker with no screening phase: taken goes straight to the agent reading', () => {
    expect(states(waitSteps(job(), [taken]))).toEqual([
      'Starting your studio: done',
      'The agent is reading your request: current',
    ])
    // a reloaded page has no events: the job's status says it was taken
    expect(states(waitSteps(job('taken'), []))).toEqual([
      'Starting your studio: done',
      'The agent is reading your request: current',
    ])
    expect(states(waitSteps(job('taken'), [phase('building')]))).toEqual([
      'Starting your studio: done',
      'The agent is reading your request: current',
    ])
  })

  it('gives way to the agent’s progress once its first line shows', () => {
    expect(waitSteps(job('taken'), [phase('screening'), phase('building'), progress('Shaping the brim.')])).toBeNull()
    // its commands don't show, so they don't end the wait
    expect(waitSteps(job('taken'), [phase('building'), progress('Running: blender -b'), progress('  ')])).not.toBeNull()
  })

  it('gives way to the later phases too (an agent that never wrote a line)', () => {
    expect(waitSteps(job('taken'), [phase('screening'), phase('building'), phase('checking')])).toBeNull()
    expect(waitSteps(job('taken'), [phase('building'), phase('rendering')])).toBeNull()
  })

  it('reads only its own job’s events', () => {
    expect(states(waitSteps(job(), [progress('Other job', 'j2'), phase('screening', 'j2')]))).toEqual([
      'Starting your studio: current',
      'The agent is reading your request: todo',
    ])
  })
})

describe('the progress bar: how much of the usual wait is left', () => {
  const steps = (done: number) => (['start', 'check', 'read'] as const).map((key, i) => ({
    key, label: key, state: i < done ? 'done' as const : i === done ? 'current' as const : 'todo' as const,
  }))
  it('counts the time left down, never the time gone', () => {
    expect(waitProgress(0, 60, steps(0))).toMatchObject({ left: 'About a minute left' })
    expect(waitProgress(10, 60, steps(0))).toMatchObject({ left: 'About 50 seconds left' })
    expect(waitProgress(33, 60, steps(1))).toMatchObject({ left: 'About 30 seconds left' })
    expect(waitProgress(52, 60, steps(2))).toMatchObject({ left: 'A few seconds left' })
    expect(waitProgress(0, 200, steps(0))).toMatchObject({ left: 'About 3 minutes left' })
    expect(waitProgress(130, 200, steps(0))).toMatchObject({ left: 'About a minute left' })
  })
  it('fills with the time, but never reaches the end before the agent answers', () => {
    const at = (sec: number) => waitProgress(sec, 60, steps(0)).fraction
    expect(at(0)).toBe(0)
    expect(at(30)).toBeCloseTo(0.45)
    expect(at(30)).toBeLessThan(at(45))
    expect(at(60)).toBeCloseTo(0.9)
    expect(at(600)).toBeLessThan(1)
    expect(at(600)).toBeGreaterThan(at(90))
  })
  it('past the usual wait it says so, without a clock', () => {
    expect(waitProgress(75, 60, steps(2))).toMatchObject({ left: 'Almost there, taking a little longer than usual' })
  })
  it('with no usual wait known, it moves with the steps and gives no time', () => {
    expect(waitProgress(20, null, steps(0))).toEqual({ fraction: 0, left: null })
    expect(waitProgress(20, undefined, steps(2)).fraction).toBeCloseTo(0.6)
    expect(waitProgress(20, null, steps(2)).left).toBeNull()
  })
  it('a step already done holds the bar up even when the clock is behind', () => {
    expect(waitProgress(1, 60, steps(2)).fraction).toBeCloseTo(0.6)
  })
})

describe('warming the machine while the person writes', () => {
  it('asks once per design every 5 minutes, and never minds a failure', async () => {
    let now = 1_000_000
    const send = vi.fn().mockRejectedValue(new Error('offline'))
    const warm = createWarmer(send, () => now)
    expect(warm('d1')).toBe(true)
    expect(warm('d1')).toBe(false)
    expect(warm('d2')).toBe(true)
    now += WARM_EVERY_MS - 1
    expect(warm('d1')).toBe(false)
    now += 1
    expect(warm('d1')).toBe(true)
    expect(send.mock.calls.map((c) => c[0])).toEqual(['d1', 'd2', 'd1'])
    await Promise.resolve() // the rejection is swallowed, not left unhandled
  })

  it('a send that throws at once is swallowed too', () => {
    const warm = createWarmer(() => { throw new Error('no api') }, () => 0)
    expect(() => warm('d1')).not.toThrow()
  })
})

describe('the admin card', () => {
  it('shows whole seconds, or a dash', async () => {
    const { secondsLabel } = await import('./studio-wait')
    expect(secondsLabel(null)).toBe('–')
    expect(secondsLabel(44.5)).toBe('45 s')
  })
})
