import { describe, it, expect, vi } from 'vitest'
import { WARM_EVERY_MS, createWarmer, formatElapsed, typicalHint, waitSteps } from './studio-wait'
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

describe('the elapsed time and the usual wait', () => {
  it('shows minutes and seconds', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(42.7)).toBe('0:42')
    expect(formatElapsed(65)).toBe('1:05')
    expect(formatElapsed(725)).toBe('12:05')
    expect(formatElapsed(-3)).toBe('0:00')
  })

  it('says the usual wait in round numbers, and nothing without one', () => {
    expect(typicalHint(undefined)).toBeNull()
    expect(typicalHint(null)).toBeNull()
    expect(typicalHint(2)).toBe('Usually about 5 seconds')
    expect(typicalHint(23)).toBe('Usually about 25 seconds')
    expect(typicalHint(44)).toBe('Usually about 45 seconds')
    expect(typicalHint(48)).toBe('Usually about a minute')
    expect(typicalHint(80)).toBe('Usually about a minute')
    expect(typicalHint(100)).toBe('Usually about 2 minutes')
    expect(typicalHint(310)).toBe('Usually about 5 minutes')
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
