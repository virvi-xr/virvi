import { describe, it, expect } from 'vitest'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { isContractWallet, startSignSession, WrongWalletError } from './dcl-sign'

/** A fake EIP-1193 wallet: signs personal_sign with a throwaway identity; `code` is what eth_getCode returns. */
function fakeWallet(code = '0x') {
  const identity = createUnsafeIdentity()
  const address = identity.address
  const calls: string[] = []
  const provider = {
    calls,
    async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
      calls.push(method)
      if (method === 'eth_requestAccounts') return [address]
      if (method === 'eth_getCode') return code
      if (method === 'personal_sign') {
        const hex = String(params?.[0])
        const message = Buffer.from(hex.slice(2), 'hex').toString('utf8')
        return Authenticator.createSignature(identity, message)
      }
      throw new Error(`unexpected ${method}`)
    },
  }
  return { provider, address }
}

describe('startSignSession', () => {
  it('signs payloads with a chain rooted at the wallet that validates', async () => {
    const { provider, address } = fakeWallet()
    const session = await startSignSession(provider)
    expect(session.address.toLowerCase()).toBe(address.toLowerCase())
    const chain = session.sign('abc')
    expect(chain[0].payload.toLowerCase()).toBe(address.toLowerCase())
    expect(Authenticator.ownerAddress(chain).toLowerCase()).toBe(address.toLowerCase())
    const result = await Authenticator.validateSignature('abc', chain, null as never)
    expect(result.ok).toBe(true)
  })

  it('asks the wallet to sign exactly once, however many payloads are signed', async () => {
    const { provider } = fakeWallet()
    const session = await startSignSession(provider)
    session.sign('a')
    session.sign('b')
    session.sign('c')
    expect(provider.calls.filter((m) => m === 'personal_sign')).toHaveLength(1)
  })

  it('rejects with WrongWalletError when the connected wallet is not the expected one', async () => {
    const { provider } = fakeWallet()
    const expected = '0x' + '1'.repeat(40)
    const err = await startSignSession(provider, { expectedAddress: expected }).catch((e) => e)
    expect(err).toBeInstanceOf(WrongWalletError)
    expect(err.expected).toBe(expected)
    expect(provider.calls).not.toContain('personal_sign')
  })

  it('accepts any one of several expected addresses, and rejects a wallet outside them', async () => {
    const { provider, address } = fakeWallet()
    const other = '0x' + '1'.repeat(40)
    expect((await startSignSession(provider, { expectedAddress: [other, address] })).address).toBe(address.toLowerCase())
    const err = await startSignSession(fakeWallet().provider, { expectedAddress: [other] }).catch((e) => e)
    expect(err).toBeInstanceOf(WrongWalletError)
  })

  it('accepts the expected address in any letter case', async () => {
    const { provider, address } = fakeWallet()
    const session = await startSignSession(provider, { expectedAddress: address.toUpperCase().replace('0X', '0x') })
    expect(session.address.toLowerCase()).toBe(address.toLowerCase())
  })
})

describe('isContractWallet', () => {
  it('is false for an ordinary account and true when there is code', async () => {
    expect(await isContractWallet(fakeWallet('0x').provider, '0xabc')).toBe(false)
    expect(await isContractWallet(fakeWallet('0x6080').provider, '0xabc')).toBe(true)
  })
})
