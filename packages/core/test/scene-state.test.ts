import { describe, it, expect, vi } from 'vitest'
import { SceneState, SceneStateError } from '../src/state/SceneState.js'

/** LIV-158: the scene state client: init, changes, listeners, and its writes' answers and timeouts. */
function setup(connected = true) {
  const sent: { type: string; message: any }[] = []
  const systems = new Set<(dt: number) => void>()
  let t = 1000
  const s = new SceneState({
    send: (type, message) => { if (!connected) return false; sent.push({ type, message }); return true },
    registerSystem: (fn) => systems.add(fn),
    unregisterSystem: (fn) => systems.delete(fn),
    now: () => t,
  })
  const tick = (ms: number) => { t += ms; for (const fn of [...systems]) fn(ms / 1000) }
  return { s, sent, systems, tick }
}

describe('SceneState', () => {
  it('takes the state on join and follows changes; listeners hear their key and *', () => {
    const { s } = setup()
    const round = vi.fn(), any = vi.fn()
    s.on('round', round)
    s.on('*', any)
    expect(s.ready).toBe(false)
    s.handleInit({ state: { round: 1, doors: 'open' } })
    expect(s.ready).toBe(true)
    expect(s.all()).toEqual({ round: 1, doors: 'open' })
    expect(round).toHaveBeenCalledWith(1, 'round', false)
    expect(any).toHaveBeenCalledTimes(2)
    s.handleChange({ key: 'round', value: 2, deleted: false })
    s.handleChange({ key: 'doors', value: null, deleted: true })
    expect(s.get('round')).toBe(2)
    expect(s.has('doors')).toBe(false)
    expect(any).toHaveBeenLastCalledWith(undefined, 'doors', true)
    // A rejoin's init only reports what changed while away
    round.mockClear()
    s.handleInit({ state: { round: 2, lights: true } })
    expect(round).not.toHaveBeenCalled()
    expect(any).toHaveBeenLastCalledWith(true, 'lights', false)
  })

  it('set and delete resolve on the server ack and reject with its reason', async () => {
    const { s, sent, systems } = setup()
    const ok = s.set('round', 3)
    const bad = s.delete('x')
    expect(sent.map((m) => m.type)).toEqual(['scene_state_set', 'scene_state_delete'])
    expect(sent[0].message).toEqual({ ref: 's1', key: 'round', value: 3 })
    s.handleAck({ ref: 's1', ok: true })
    s.handleAck({ ref: 's2', ok: false, error: 'forbidden', message: "Only the scene's editors can change its state" })
    await expect(ok).resolves.toBeUndefined()
    await expect(bad).rejects.toMatchObject({ code: 'forbidden', name: 'SceneStateError' })
    expect(systems.size).toBe(0)
  })

  it('rejects when not connected, on a timeout, and when the room is lost', async () => {
    const off = setup(false)
    await expect(off.s.set('a', 1)).rejects.toBeInstanceOf(SceneStateError)
    const { s, tick, systems } = setup()
    const late = s.set('a', 1)
    tick(SceneState.TIMEOUT_MS + 1)
    await expect(late).rejects.toMatchObject({ code: 'state_timeout' })
    const lost = s.set('b', 1)
    s.failAll('not_connected')
    await expect(lost).rejects.toMatchObject({ code: 'not_connected' })
    expect(systems.size).toBe(0)
  })
})
