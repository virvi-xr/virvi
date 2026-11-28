import { describe, it, expect } from 'vitest'
import { RELAY_BURST, RELAY_PER_SECOND, RelayLimiter, relayUserMessage, messageSender } from '../src/ws/relay-limit.js'

describe('room relay limits (LIV-156)', () => {
  it('lets a burst through, drops the rest, and refills over time', () => {
    let t = 1_000_000
    const l = new RelayLimiter(() => t)
    const sent = Array.from({ length: RELAY_BURST + 5 }, () => l.take('c1', 'user_message')).filter(Boolean).length
    expect(sent).toBe(RELAY_BURST)
    t += 1000
    const refilled = Array.from({ length: RELAY_PER_SECOND + 5 }, () => l.take('c1', 'user_message')).filter(Boolean).length
    expect(refilled).toBe(RELAY_PER_SECOND)
  })

  it('keeps clients and message types apart, and forgets a client that left', () => {
    let t = 0
    const l = new RelayLimiter(() => t)
    for (let i = 0; i < RELAY_BURST; i++) l.take('c1', 'user_message')
    expect(l.take('c1', 'user_message')).toBe(false)
    expect(l.take('c2', 'user_message')).toBe(true)
    expect(l.take('c1', 'scene_sound_locator')).toBe(true)
    l.forget('c1')
    expect(l.take('c1', 'user_message')).toBe(true)
  })

  it('forwards only the id and data of a well-formed user_message', () => {
    expect(relayUserMessage({ messageId: 'emoji', data: { e: 1 }, type: 'outbound', extra: 'x' })).toEqual({ messageId: 'emoji', data: { e: 1 }, type: 'inbound' })
    expect(relayUserMessage({ messageId: '' })).toBeNull()
    expect(relayUserMessage({ messageId: 'x'.repeat(129) })).toBeNull()
    expect(relayUserMessage({ data: 1 })).toBeNull()
    expect(relayUserMessage('nope')).toBeNull()
    expect(relayUserMessage(null)).toBeNull()
  })
})

describe('messageSender (LIV-158)', () => {
  it('names a checked sign-in, and treats everyone else as a guest', () => {
    expect(messageSender('s1', { userId: 'u1', wallet: '0xabc', verified: true }, true)).toEqual({ sessionId: 's1', userId: 'u1', wallet: '0xabc', guest: false, staff: true })
    expect(messageSender('s2', { userId: 'u1', wallet: '0xabc', verified: false }, false)).toEqual({ sessionId: 's2', userId: null, wallet: null, guest: true, staff: false })
    expect(messageSender('s3', null, false).guest).toBe(true)
  })
})
