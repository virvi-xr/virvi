import { randomBytes } from 'node:crypto'
import { Transaction, getAddress, keccak256, type BaseWallet } from 'ethers'
import { GIVEAWAY_GAS_PER_ITEM, type GiveawayChain } from '@virvixr/shared'
import { config } from '../../src/config.js'
import {
  GIVEAWAY_TRANSFER_GAS, GiveawayRevert, GiveawayRpcError, collectionInterface, setGiveawayChainClientForTests,
  type GiveawayChainClient, type GiveawayFees, type GiveawayIssue, type GiveawayItemState, type GiveawayReceipt,
} from '../../src/giveaways/chain.js'
import { setCreatorItemsFetchForTests } from '../../src/giveaways/marketplace.js'

/** One signing the fake made: what it calls, from whom, at which nonce and fees. */
export type FakeSigned = {
  raw: string; hash: string; from: string; nonce: number; gasLimit: bigint; fees: GiveawayFees
  kind: 'mint' | 'transfer'; to: string; valueWei: bigint; wallets: string[]; itemIds: string[]
}

/**
 * A fake chain: balances per address, a fixed max fee, and item states per `contract:itemId` (default: ready, 100 left).
 * Signing is real (ethers signs offline), so raw transactions decode. Broadcasts go into a pool; `mine()` includes the
 * pool's next transaction per sender (moving POL, minting tokens or reverting as the items' state says) and `advance(n)`
 * adds empty blocks. Mined transactions pay their gas limit × `gasPriceWei`.
 */
export class FakeGiveawayChain {
  balances = new Map<string, bigint>()
  maxFeePerGas = 100_000_000_000n // 100 gwei
  gasPriceWei = 1_000_000_000n // what a mined transaction pays per gas
  items = new Map<string, Partial<GiveawayItemState>>()
  down = false
  signs: FakeSigned[] = []
  broadcasts: string[] = []
  pool = new Map<string, FakeSigned>()
  receipts = new Map<string, GiveawayReceipt>()
  nonces = new Map<string, number>()
  block = 100
  nextTokenId = 1n
  /** Thrown by the next broadcasts (a function decides per raw tx; null lets it through). */
  broadcastError: ((raw: string) => Error | null) | null = null

  state(contract: string, itemId: string): GiveawayItemState {
    return { approved: true, completed: true, canMint: true, remaining: 100n, rarity: 'rare', ...this.items.get(`${contract.toLowerCase()}:${itemId}`) }
  }
  setItem(contract: string, itemId: string, patch: Partial<GiveawayItemState>) {
    const key = `${contract.toLowerCase()}:${itemId}`
    this.items.set(key, { ...this.items.get(key), ...patch })
  }
  balance(address: string) { return this.balances.get(address.toLowerCase()) ?? 0n }
  latestNonce(address: string) { return this.nonces.get(address.toLowerCase()) ?? 0 }

  /** Why a mint of these items would revert now, or null. */
  #mintProblem(contract: string, itemIds: string[]): string | null {
    const counts = new Map<string, bigint>()
    for (const i of itemIds) counts.set(i, (counts.get(i) ?? 0n) + 1n)
    for (const [itemId, n] of counts) {
      const s = this.state(contract, itemId)
      if (!s.approved || !s.completed) return '_issueToken: MINT_NOT_ALLOWED'
      if (!s.canMint) return '_issueToken: CALLER_CAN_NOT_MINT'
      if (s.remaining < n) return '_issueToken: ITEM_EXHAUSTED'
    }
    return null
  }

  async #sign(signer: BaseWallet, s: Omit<FakeSigned, 'raw' | 'hash' | 'from'>, data: string): Promise<FakeSigned> {
    const raw = await signer.signTransaction({
      type: 2, chainId: 137n, to: s.to, data, value: s.valueWei, gasLimit: s.gasLimit, nonce: s.nonce,
      maxFeePerGas: s.fees.maxFeePerGas, maxPriorityFeePerGas: s.fees.maxPriorityFeePerGas,
    })
    const out = { ...s, raw, hash: keccak256(raw), from: signer.address.toLowerCase() }
    this.signs.push(out)
    return out
  }

  #check(op = 'balance') { if (this.down) throw new GiveawayRpcError(op, 'NETWORK_ERROR') }

  /** Includes the pool's next transaction of each sender in a new block. */
  mine() {
    this.block++
    const next = new Map<string, FakeSigned>()
    for (const t of this.pool.values()) if (t.nonce === this.latestNonce(t.from) && !next.has(t.from)) next.set(t.from, t)
    for (const t of next.values()) {
      const fee = t.gasLimit * this.gasPriceWei
      if (this.balance(t.from) < fee + t.valueWei) continue
      let ok = true
      const issues: GiveawayIssue[] = []
      if (t.kind === 'mint') {
        ok = this.#mintProblem(t.to, t.itemIds) === null
        if (ok) {
          t.wallets.forEach((w, i) => {
            const s = this.state(t.to, t.itemIds[i])
            this.setItem(t.to, t.itemIds[i], { remaining: s.remaining - 1n })
            issues.push({ beneficiary: getAddress(w), tokenId: String(this.nextTokenId++), itemId: t.itemIds[i] })
          })
        }
      }
      this.setBalance(t.from, this.balance(t.from) - fee - (ok ? t.valueWei : 0n))
      if (ok && t.valueWei) this.setBalance(t.to, this.balance(t.to) + t.valueWei)
      this.nonces.set(t.from, t.nonce + 1)
      this.receipts.set(t.hash, { ok, blockNumber: this.block, feeWei: fee, issues })
      for (const [h, p] of this.pool) if (p.from === t.from && p.nonce === t.nonce) this.pool.delete(h)
    }
  }
  /** Adds n empty blocks. */
  advance(n: number) { this.block += n }

  client(chain: GiveawayChain): GiveawayChainClient {
    return {
      chain,
      balanceWei: async (a) => { this.#check(); return this.balance(a) },
      feeData: async () => { this.#check('fees'); return { maxFeePerGas: this.maxFeePerGas, maxPriorityFeePerGas: 30_000_000_000n, baseFeePerGas: 1n } },
      itemState: async (contract, itemId) => { this.#check('items'); return this.state(contract, itemId) },
      nonce: async (a, tag) => {
        this.#check('nonce')
        const latest = this.latestNonce(a)
        if (tag === 'latest') return latest
        const pending = new Set([...this.pool.values()].filter((t) => t.from === a.toLowerCase()).map((t) => t.nonce))
        return latest + pending.size
      },
      signMint: async (signer, contract, wallets, itemIds, nonce, fees, gasLimit) => {
        this.#check('estimate')
        if (gasLimit === undefined) {
          const problem = this.#mintProblem(contract, itemIds)
          if (problem) throw new GiveawayRevert(problem)
        }
        const f = fees ?? { maxFeePerGas: this.maxFeePerGas, maxPriorityFeePerGas: 30_000_000_000n }
        const data = collectionInterface.encodeFunctionData('issueTokens', [wallets, itemIds.map((i) => BigInt(i))])
        const s = await this.#sign(signer, {
          kind: 'mint', to: getAddress(contract), valueWei: 0n, wallets: wallets.map((w) => w.toLowerCase()), itemIds,
          nonce, fees: f, gasLimit: gasLimit ?? GIVEAWAY_GAS_PER_ITEM * BigInt(wallets.length),
        }, data)
        return { raw: s.raw, hash: s.hash, gasLimit: s.gasLimit, fees: f }
      },
      signTransfer: async (signer, to, valueWei, nonce, fees) => {
        this.#check('fees')
        const f = fees ?? { maxFeePerGas: this.maxFeePerGas, maxPriorityFeePerGas: 30_000_000_000n }
        const s = await this.#sign(signer, {
          kind: 'transfer', to: getAddress(to), valueWei, wallets: [], itemIds: [], nonce, fees: f, gasLimit: GIVEAWAY_TRANSFER_GAS,
        }, '0x')
        return { raw: s.raw, hash: s.hash, fees: f }
      },
      broadcast: async (raw) => {
        this.#check('broadcast')
        const err = this.broadcastError?.(raw)
        if (err) throw err
        const hash = keccak256(raw)
        const signed = this.signs.find((s) => s.hash === hash)
        if (!signed) throw new Error('the fake never signed this')
        this.broadcasts.push(raw)
        if (this.receipts.has(hash)) return
        if (signed.nonce < this.latestNonce(signed.from)) throw new GiveawayRpcError('broadcast', 'NONCE_EXPIRED')
        // A replacement (same sender and nonce) takes the earlier one's place
        for (const [h, p] of this.pool) if (p.from === signed.from && p.nonce === signed.nonce) this.pool.delete(h)
        this.pool.set(hash, signed)
      },
      receipt: async (hash) => { this.#check('receipt'); return this.receipts.get(hash) ?? null },
      latestBlock: async () => { this.#check('block'); return this.block },
    }
  }
  setBalance(address: string, wei: bigint) { this.balances.set(address.toLowerCase(), wei) }
}

/** Decodes a raw transaction's sender (the fake's tests check who signed). */
export const senderOf = (raw: string) => Transaction.from(raw).from!.toLowerCase()

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
