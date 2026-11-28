import { describe, it, expect, vi } from 'vitest'
import { Virvi } from '../src/Virvi.js'

/** LIV-158: messages carry the server-stamped sender, onMessage returns a remover, and offMessage exists. */
const adapter: any = { capabilities: { platformName: 'test' }, registerSystem: vi.fn(), unregisterSystem: vi.fn() }

function setup() {
  const virvi = new Virvi(adapter)
  const handlers = new Map<string, (m: unknown) => void>()
  vi.spyOn((virvi as any).colyseus, 'onMessage').mockImplementation(((type: string, cb: (m: unknown) => void) => { handlers.set(type, cb) }) as any)
  ;(virvi as any).registerMessageHandlers()
  const deliver = (m: unknown) => handlers.get('user_message')!(m)
  return { virvi, deliver }
}

const from = { sessionId: 's1', userId: 'u1', wallet: '0xabc', guest: false, staff: true }

describe('user messages', () => {
  it('passes data and the sender; an older server sends no sender', () => {
    const { virvi, deliver } = setup()
    const cb = vi.fn()
    virvi.onMessage('door', cb)
    deliver({ messageId: 'door', data: { open: true }, type: 'inbound', from })
    deliver({ messageId: 'door', data: 1, type: 'inbound' })
    deliver({ messageId: 'other', data: 2, from })
    expect(cb.mock.calls).toEqual([[{ open: true }, from], [1, null]])
  })

  it('onMessage returns a remover; offMessage removes only the callback still listening', () => {
    const { virvi, deliver } = setup()
    const a = vi.fn(), b = vi.fn()
    const offA = virvi.onMessage('x', a)
    virvi.onMessage('x', b) // replaces a
    offA() // a is no longer the listener: b stays
    deliver({ messageId: 'x', data: 1, from })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    virvi.offMessage('x')
    deliver({ messageId: 'x', data: 2, from })
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("a throwing handler doesn't break later messages", () => {
    const { virvi, deliver } = setup()
    const cb = vi.fn(() => { throw new Error('scene bug') })
    virvi.onMessage('x', cb)
    deliver({ messageId: 'x', data: 1 })
    deliver({ messageId: 'x', data: 2 })
    expect(cb).toHaveBeenCalledTimes(2)
  })
})
