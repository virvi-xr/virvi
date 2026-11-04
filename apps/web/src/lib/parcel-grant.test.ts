import { describe, it, expect } from 'vitest'
import { grantView, sendTransactions, OPERATOR_REPLACES_NOTE, type ParcelGrant } from './parcel-grant'

const grant = (over: Partial<ParcelGrant> = {}): ParcelGrant => ({
  available: true, aetheria: false, canGrant: true, granted: false, operator: '0xabc',
  transactions: [{ to: '0x1', data: '0xaa', label: 'Parcel 10,20' }], costNote: 'gas', ...over,
})

describe('grantView', () => {
  it('shows the card with no reason when the owner can grant', () => {
    expect(grantView(grant())).toEqual({ show: true, reason: null })
  })
  it('hides the card when Virvi has no parcel wallet', () => {
    expect(grantView(grant({ available: false }))).toEqual({ show: false, reason: null })
  })
  it('explains Aetheria parcels', () => {
    expect(grantView(grant({ aetheria: true }))).toEqual({
      show: true, reason: "Aetheria parcels are managed by their deed. Sign each deploy with the deed holder's wallet.",
    })
  })
  it('explains that only the owner can grant', () => {
    expect(grantView(grant({ canGrant: false }))).toEqual({ show: true, reason: "Only the parcels' owner can make Virvi an operator." })
  })
  it('warns that an existing update operator is replaced', () => {
    expect(OPERATOR_REPLACES_NOTE).toMatch(/replaces any update operator/)
  })
})

describe('sendTransactions', () => {
  const wallet = (rejectAt = -1, chain = '0x1') => {
    const calls: Array<{ method: string; params?: unknown[] }> = []
    let sent = 0
    return {
      calls,
      request: async (args: { method: string; params?: unknown[] }) => {
        calls.push(args)
        if (args.method === 'eth_requestAccounts') return ['0xAbC']
        if (args.method === 'eth_chainId') return chain
        if (args.method === 'wallet_switchEthereumChain') return null
        if (args.method === 'eth_sendTransaction') {
          if (sent++ === rejectAt) throw Object.assign(new Error('rejected'), { code: 4001 })
          return `0xhash${sent}`
        }
        throw new Error(`unexpected ${args.method}`)
      },
    }
  }
  const txs = [{ to: '0x1', data: '0xaa', label: 'a' }, { to: '0x2', data: '0xbb', label: 'b' }]

  it('sends each transaction in order from the connected account and returns the hashes', async () => {
    const w = wallet()
    expect(await sendTransactions(w, txs)).toEqual(['0xhash1', '0xhash2'])
    const sends = w.calls.filter((c) => c.method === 'eth_sendTransaction').map((c) => c.params)
    expect(sends).toEqual([[{ from: '0xAbC', to: '0x1', data: '0xaa' }], [{ from: '0xAbC', to: '0x2', data: '0xbb' }]])
  })

  it('reports each hash as it is sent, so a later rejection keeps the earlier ones', async () => {
    const w = wallet(1)
    const seen: string[] = []
    await expect(sendTransactions(w, txs, (h) => seen.push(h))).rejects.toMatchObject({ code: 4001 })
    expect(seen).toEqual(['0xhash1'])
  })

  it('stops at the first rejection', async () => {
    const w = wallet(0)
    await expect(sendTransactions(w, txs)).rejects.toMatchObject({ code: 4001 })
    expect(w.calls.filter((c) => c.method === 'eth_sendTransaction')).toHaveLength(1)
  })

  it('switches the wallet to Ethereum mainnet first', async () => {
    const w = wallet(-1, '0x89')
    await sendTransactions(w, txs)
    expect(w.calls.map((c) => c.method).slice(0, 3)).toEqual(['eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain'])
    expect(w.calls[2].params).toEqual([{ chainId: '0x1' }])
  })
})
