import { describe, it, expect } from 'vitest'
import { trialIpKey } from '../src/auth/trial.js'

describe('trialIpKey', () => {
  it('keeps an IPv4 address as is, including one mapped into IPv6', () => {
    expect(trialIpKey('203.0.113.7')).toBe('203.0.113.7')
    expect(trialIpKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
  })
  it('counts every address in an IPv6 /64 as one', () => {
    const a = trialIpKey('2001:db8:abcd:12::1')
    expect(trialIpKey('2001:0db8:abcd:0012:ffff:1:2:3')).toBe(a)
    expect(trialIpKey('2001:db8:abcd:12:8000::')).toBe(a)
    expect(a).toBe('2001:db8:abcd:12::/64')
  })
  it('tells different /64s apart, and handles :: early in the address', () => {
    expect(trialIpKey('2001:db8:abcd:13::1')).not.toBe(trialIpKey('2001:db8:abcd:12::1'))
    expect(trialIpKey('2001::1')).toBe('2001:0:0:0::/64')
    expect(trialIpKey('::1')).toBe('0:0:0:0::/64')
  })
  it('passes anything unparseable through unchanged', () => {
    expect(trialIpKey('not-an-ip')).toBe('not-an-ip')
  })
})
