import { randomBytes } from 'node:crypto'
import type { GiveawayChain } from '@virvixr/shared'
import { config } from '../../src/config.js'
import { GiveawayRpcError, setGiveawayChainClientForTests, type GiveawayChainClient, type GiveawayItemState } from '../../src/giveaways/chain.js'
import { setCreatorItemsFetchForTests } from '../../src/giveaways/marketplace.js'

/** A fake chain: balances per address, a fixed max fee, and item states per `contract:itemId` (default: ready). */
export class FakeGiveawayChain {
  balances = new Map<string, bigint>()
  maxFeePerGas = 100_000_000_000n // 100 gwei
  items = new Map<string, Partial<GiveawayItemState>>()
  down = false

  client(chain: GiveawayChain): GiveawayChainClient {
    const nope = async () => { throw new Error('not in the fake') }
    const check = () => { if (this.down) throw new GiveawayRpcError('balance', 'NETWORK_ERROR') }
    return {
      chain,
      balanceWei: async (a) => { check(); return this.balances.get(a.toLowerCase()) ?? 0n },
      feeData: async () => { check(); return { maxFeePerGas: this.maxFeePerGas, maxPriorityFeePerGas: 30_000_000_000n, baseFeePerGas: 1n } },
      itemState: async (contract, itemId) => {
        check()
        return { approved: true, completed: true, canMint: true, remaining: 100n, rarity: 'rare', ...this.items.get(`${contract.toLowerCase()}:${itemId}`) }
      },
      nonce: nope, signMint: nope, signTransfer: nope, broadcast: nope, receipt: nope, latestBlock: nope,
    }
  }
  setBalance(address: string, wei: bigint) { this.balances.set(address.toLowerCase(), wei) }
}

/** Marketplace items per creator wallet, served as the Marketplace API would. */
export class FakeMarketplace {
  byCreator = new Map<string, Array<Record<string, unknown>>>()
  calls: string[] = []
  add(creator: string, item: { contractAddress: string; itemId: string; name?: string; category?: string; reviewedAt?: number | null; network?: string }) {
    const list = this.byCreator.get(creator.toLowerCase()) ?? []
    list.push({
      name: 'Prize hat', thumbnail: 'https://peer.example/thumb.png', rarity: 'rare', available: 50, category: 'wearable',
      network: 'MATIC', reviewedAt: 1_700_000_000_000, ...item, contractAddress: item.contractAddress.toLowerCase(),
    })
    this.byCreator.set(creator.toLowerCase(), list)
  }
  fetch: typeof fetch = async (input) => {
    const url = new URL(String(input))
    this.calls.push(url.toString())
    const creator = url.searchParams.get('creator') ?? ''
    const category = url.searchParams.get('category')
    const data = (this.byCreator.get(creator) ?? []).filter((i) => i.category === category)
    return new Response(JSON.stringify({ data, total: data.length }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

/** Turns giveaways on with a fake chain and Marketplace; returns them and an undo. */
export function giveawaysOn(over: Record<string, unknown> = {}) {
  const prev = config.giveaways
  ;(config as any).giveaways = { ...config.giveaways, enabled: true, walletSecret: randomBytes(32), gasKey: null, ...over }
  const chain = new FakeGiveawayChain()
  const market = new FakeMarketplace()
  setGiveawayChainClientForTests('polygon', chain.client('polygon'))
  setGiveawayChainClientForTests('polygon-amoy', chain.client('polygon-amoy'))
  setCreatorItemsFetchForTests(market.fetch)
  const off = () => {
    ;(config as any).giveaways = prev
    setGiveawayChainClientForTests('polygon', null)
    setGiveawayChainClientForTests('polygon-amoy', null)
    setCreatorItemsFetchForTests(null)
  }
  return { chain, market, off }
}
