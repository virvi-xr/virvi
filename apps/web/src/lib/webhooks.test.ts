import { describe, expect, it } from 'vitest'
import { deliveryLine } from './webhooks'

describe('webhook deliveries (LIV-39)', () => {
  it('says how each one went', () => {
    expect(deliveryLine({ status: 'delivered', attempts: 1, responseStatus: 200, lastError: null })).toBe('Delivered (200)')
    expect(deliveryLine({ status: 'pending', attempts: 2, responseStatus: 500, lastError: 'HTTP 500' })).toBe('Retrying (try 2 failed: HTTP 500)')
    expect(deliveryLine({ status: 'pending', attempts: 0, responseStatus: null, lastError: null })).toBe('Waiting to send')
    expect(deliveryLine({ status: 'failed', attempts: 7, responseStatus: null, lastError: 'Timed out after 10 s' })).toBe('Gave up after 7 tries: Timed out after 10 s')
  })
})
