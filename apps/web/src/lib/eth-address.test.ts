import { describe, it, expect } from 'vitest'
import { checksumAddress, keccak256Hex } from './eth-address'

describe('keccak256Hex', () => {
  it('matches the known Keccak-256 vectors', () => {
    expect(keccak256Hex('')).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
    expect(keccak256Hex('abc')).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
    // longer than one 136-byte block
    expect(keccak256Hex('a'.repeat(200))).toHaveLength(64)
  })
})

describe('checksumAddress (EIP-55)', () => {
  it('matches the EIP-55 test vectors, from any case', () => {
    for (const a of [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ]) {
      expect(checksumAddress(a.toLowerCase())).toBe(a)
      expect(checksumAddress(a.toUpperCase().replace('0X', '0x'))).toBe(a)
    }
  })
  it('is null for anything that is not a 20-byte hex address', () => {
    expect(checksumAddress('0x123')).toBeNull()
    expect(checksumAddress('preview:abc')).toBeNull()
    expect(checksumAddress('0x' + 'g'.repeat(40))).toBeNull()
  })
})
