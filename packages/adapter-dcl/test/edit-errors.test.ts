import { describe, it, expect, vi } from 'vitest'
import {
  friendlyEditError,
  friendlyRenameError,
  editBlockedMessage,
  createReconnector,
  SIGNED_OUT,
  NO_PERMISSION,
  DISCONNECTED,
  NOT_FOUND,
  SOMETHING_WRONG,
} from '../src/edit-errors.js'

// @virvixr/client's error shape
const http = (status: number, body = '{"error":"x"}') => new Error(`HTTP ${status}: ${body}`)

describe('friendlyEditError', () => {
  it('401 says signed out, not permission', () => {
    expect(friendlyEditError(http(401, '{"error":"Unauthorized","message":"Session expired — sign in again"}'))).toBe(
      "You're signed out. Sign in again to edit.",
    )
    expect(friendlyEditError(http(401))).toBe(SIGNED_OUT)
  })

  it('403 says no permission (a real server refusal is never reworded)', () => {
    expect(friendlyEditError(http(403, '{"error":"Forbidden"}'))).toBe("You don't have permission to edit this scene.")
    expect(friendlyEditError(http(403, '{"error":"scene_pass_not_allowed"}'))).toBe(NO_PERMISSION)
    // Even while disconnected: the server answered, so its answer stands
    expect(friendlyEditError(http(403), { connected: false })).toBe(NO_PERMISSION)
  })

  it('a request that never got an answer says disconnected', () => {
    expect(friendlyEditError(new TypeError('Failed to fetch'))).toBe('Disconnected from Virvi. Reconnecting…')
    expect(friendlyEditError(new Error('network error'))).toBe(DISCONNECTED)
    expect(friendlyEditError(new Error('Request timed out'))).toBe(DISCONNECTED)
  })

  it('a 401 while the room is down says disconnected (the pass ran out while offline)', () => {
    expect(friendlyEditError(http(401), { connected: false })).toBe(DISCONNECTED)
  })

  it('any failure while the room is down without an HTTP answer says disconnected', () => {
    expect(friendlyEditError(new Error('boom'), { connected: false })).toBe(DISCONNECTED)
  })

  it('keeps 404 and the generic message', () => {
    expect(friendlyEditError(http(404))).toBe(NOT_FOUND)
    expect(friendlyEditError(http(500))).toBe(SOMETHING_WRONG)
    expect(friendlyEditError(new Error('boom'))).toBe(SOMETHING_WRONG)
  })
})

describe('friendlyRenameError', () => {
  it('keeps the rename-only wording and falls back to the edit messages', () => {
    expect(friendlyRenameError(http(400))).toBe('Names need 1-120 characters, without slashes')
    expect(friendlyRenameError(http(409))).toBe("That file isn't ready yet")
    expect(friendlyRenameError(http(401))).toBe(SIGNED_OUT)
    expect(friendlyRenameError(http(403))).toBe(NO_PERMISSION)
    expect(friendlyRenameError(new TypeError('Failed to fetch'))).toBe(DISCONNECTED)
  })
})

describe('editBlockedMessage', () => {
  it('lets an editor through without fetching the role', async () => {
    const refreshRole = vi.fn(async () => {})
    expect(await editBlockedMessage({ connected: true, canEdit: () => true, refreshRole })).toBeNull()
    expect(refreshRole).not.toHaveBeenCalled()
  })

  it('says disconnected, not permission, while the room is down', async () => {
    const refreshRole = vi.fn(async () => {})
    expect(await editBlockedMessage({ connected: false, canEdit: () => false, refreshRole })).toBe(DISCONNECTED)
    expect(refreshRole).not.toHaveBeenCalled()
  })

  it('fetches the role again before a stale viewer role can block an edit', async () => {
    let role = 'viewer'
    const refreshRole = vi.fn(async () => { role = 'editor' })
    expect(await editBlockedMessage({ connected: true, canEdit: () => role !== 'viewer', refreshRole })).toBeNull()
    expect(refreshRole).toHaveBeenCalledOnce()
  })

  it('says no permission when the fresh role is still viewer', async () => {
    expect(await editBlockedMessage({ connected: true, canEdit: () => false, refreshRole: async () => {} })).toBe(NO_PERMISSION)
  })

  it('a failed role fetch keeps the current role', async () => {
    const refreshRole = async () => { throw new Error('network error') }
    expect(await editBlockedMessage({ connected: true, canEdit: () => false, refreshRole })).toBe(NO_PERMISSION)
  })
})

describe('createReconnector', () => {
  /** A fake clock: `schedule` queues, `tick` runs the next timer. */
  const fakeTimers = () => {
    const queue: { fn: () => void; ms: number }[] = []
    return {
      queue,
      schedule: (fn: () => void, ms: number) => {
        const t = { fn, ms }
        queue.push(t)
        return () => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1) }
      },
      async tick() {
        const t = queue.shift()
        t?.fn()
        await new Promise((r) => setTimeout(r, 0))
      },
    }
  }

  it('reconnects after a drop and fetches the role again once connected', async () => {
    const t = fakeTimers()
    const order: string[] = []
    const r = createReconnector({
      connect: async () => { order.push('connect') },
      onReconnected: async () => { order.push('role') },
      schedule: t.schedule,
      delaysMs: [100, 200],
    })
    r.lost()
    expect(r.reconnecting).toBe(true)
    expect(t.queue.map((q) => q.ms)).toEqual([100])
    await t.tick()
    expect(order).toEqual(['connect', 'role'])
    expect(r.reconnecting).toBe(false)
    expect(t.queue).toHaveLength(0)
  })

  it('backs off after failures and holds at the last delay', async () => {
    const t = fakeTimers()
    let fails = 3
    const onFailed = vi.fn()
    const r = createReconnector({
      connect: async () => { if (fails-- > 0) throw new Error('down') },
      onReconnected: async () => {},
      onFailed,
      schedule: t.schedule,
      delaysMs: [100, 200],
    })
    r.lost()
    const delays: number[] = []
    while (t.queue.length) { delays.push(t.queue[0].ms); await t.tick() }
    expect(delays).toEqual([100, 200, 200, 200])
    expect(onFailed).toHaveBeenCalledTimes(3)
    expect(r.reconnecting).toBe(false)
  })

  it('a second drop while reconnecting does not start a second loop', () => {
    const t = fakeTimers()
    const r = createReconnector({ connect: async () => {}, onReconnected: async () => {}, schedule: t.schedule, delaysMs: [100] })
    r.lost()
    r.lost()
    expect(t.queue).toHaveLength(1)
  })

  it('stop() cancels a pending attempt', () => {
    const t = fakeTimers()
    const connect = vi.fn(async () => {})
    const r = createReconnector({ connect, onReconnected: async () => {}, schedule: t.schedule, delaysMs: [100] })
    r.lost()
    r.stop()
    expect(t.queue).toHaveLength(0)
    expect(r.reconnecting).toBe(false)
  })
})
