import { describe, it, expect, afterEach } from 'vitest'
import { AbiCoder, Interface, Transaction, Wallet, getAddress, keccak256, type JsonRpcProvider } from 'ethers'
import {
  GIVEAWAY_MIN_PRIORITY_FEE_WEI, GiveawayRevert, GiveawayRpcError, collectionInterface, giveawayChainClient,
  giveawayChainClientOn, issuesIn, revertReason, setGiveawayChainClientForTests,
} from '../src/giveaways/chain.js'

/** The collection chain client against a stub provider (LIV-194). The anvil test covers the real calls. */

const CONTRACT = getAddress('0x01d871870cbbdde934526e17637c0cfef0b3b38b')
const errorData = (msg: string) => '0x08c379a0' + AbiCoder.defaultAbiCoder().encode(['string'], [msg]).slice(2)
const callException = (msg: string) => Object.assign(new Error(`execution reverted: "${msg}" (data=..., transaction={ "data": "0xdeadbeef" })`), {
  code: 'CALL_EXCEPTION', reason: msg, data: errorData(msg),
})

function stub(over: Partial<Record<keyof JsonRpcProvider, unknown>>): JsonRpcProvider {
  return over as unknown as JsonRpcProvider
}

afterEach(() => {
  setGiveawayChainClientForTests('polygon-amoy', null)
  setGiveawayChainClientForTests('polygon', null)
})

describe('revertReason', () => {
  it("maps the collection's revert strings, from an ethers error or a GiveawayRevert", () => {
    expect(revertReason(callException('_issueToken: CALLER_CAN_NOT_MINT'))).toBe('not_minter')
    expect(revertReason(callException('_issueToken: ITEM_EXHAUSTED'))).toBe('sold_out')
    expect(revertReason(callException('issueTokens: MINT_NOT_ALLOWED'))).toBe('not_approved')
    expect(revertReason(new GiveawayRevert('_issueToken: ITEM_EXHAUSTED'))).toBe('sold_out')
    // Only the revert data, as some nodes give it
    expect(revertReason({ code: 'CALL_EXCEPTION', info: { error: { data: errorData('issueTokens: MINT_NOT_ALLOWED') } } })).toBe('not_approved')
  })

  it('is null for anything else', () => {
    expect(revertReason(callException('issueTokens: LENGTH_MISMATCH'))).toBeNull()
    expect(revertReason(new GiveawayRpcError('estimate', 'NETWORK_ERROR'))).toBeNull()
    expect(revertReason(new Error('boom'))).toBeNull()
    expect(revertReason(null)).toBeNull()
  })
})

describe('the giveaway chain client on a stub provider', () => {
  it("parses a receipt's Issue logs from the called contract into beneficiaries, token ids and item ids", async () => {
    const issue = collectionInterface.getEvent('Issue')!
    const a = Wallet.createRandom().address
    const b = Wallet.createRandom().address
    const caller = Wallet.createRandom().address
    const log = (address: string, to: string, itemId: bigint, issued: bigint) => {
      const tokenId = (itemId << 216n) | issued
      const enc = collectionInterface.encodeEventLog(issue, [to, tokenId, itemId, issued, caller])
      return { address, topics: enc.topics, data: enc.data }
    }
    const other = Wallet.createRandom().address
    const transfer = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'])
    const t = transfer.encodeEventLog(transfer.getEvent('Transfer')!, [caller, a, 1n])
    const receipt = {
      status: 1, blockNumber: 42, to: CONTRACT, fee: 21_000n * 7n,
      logs: [
        { address: CONTRACT, topics: t.topics, data: t.data },
        log(CONTRACT, a, 3n, 1n),
        log(CONTRACT.toLowerCase(), b, 0n, 5n),
        log(other, b, 9n, 9n), // another contract's Issue is ignored
      ],
    }
    const c = giveawayChainClientOn('polygon-amoy', stub({ getTransactionReceipt: async () => receipt }))
    expect(await c.receipt('0x' + '11'.repeat(32))).toEqual({
      ok: true, blockNumber: 42, feeWei: 147_000n,
      issues: [
        { beneficiary: a, tokenId: ((3n << 216n) | 1n).toString(), itemId: '3' },
        { beneficiary: b, tokenId: '5', itemId: '0' },
      ],
    })
    expect(issuesIn(CONTRACT, receipt.logs)).toHaveLength(2)
  })

  it('gives null for a receipt not yet mined, and ok false for a failed one', async () => {
    const none = giveawayChainClientOn('polygon', stub({ getTransactionReceipt: async () => null }))
    expect(await none.receipt('0x' + '22'.repeat(32))).toBeNull()
    const failed = giveawayChainClientOn('polygon', stub({
      getTransactionReceipt: async () => ({ status: 0, blockNumber: 7, to: CONTRACT, fee: 5n, logs: [] }),
    }))
    expect(await failed.receipt('0x' + '22'.repeat(32))).toEqual({ ok: false, blockNumber: 7, feeWei: 5n, issues: [] })
  })

  it('raises the tip to the floor and maxFee to 2 × base fee + tip', async () => {
    const c = giveawayChainClientOn('polygon', stub({
      getFeeData: async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, gasPrice: 5n }),
      getBlock: async () => ({ baseFeePerGas: 100n }),
    }))
    expect(await c.feeData()).toEqual({
      maxFeePerGas: 200n + GIVEAWAY_MIN_PRIORITY_FEE_WEI, maxPriorityFeePerGas: GIVEAWAY_MIN_PRIORITY_FEE_WEI, baseFeePerGas: 100n,
    })
  })

  it('signs a mint with the estimate plus 20%, from the signer, and never puts calldata or wallets in errors', async () => {
    const signer = Wallet.createRandom()
    const wallets = [Wallet.createRandom().address, Wallet.createRandom().address]
    let from = ''
    const c = giveawayChainClientOn('polygon', stub({
      estimateGas: async (tx: { from: string }) => { from = tx.from; return 100_000n },
    }))
    const fees = { maxFeePerGas: 90n * 10n ** 9n, maxPriorityFeePerGas: 30n * 10n ** 9n }
    const s = await c.signMint(signer, CONTRACT, wallets, ['3', '3'], 4, fees)
    expect(from).toBe(signer.address)
    expect(s.gasLimit).toBe(120_000n)
    expect(s.hash).toBe(keccak256(s.raw))
    const tx = Transaction.from(s.raw)
    expect(tx.chainId).toBe(137n)
    expect(tx.nonce).toBe(4)
    expect(tx.to).toBe(CONTRACT)
    expect(tx.from).toBe(signer.address)
    expect(collectionInterface.decodeFunctionData('issueTokens', tx.data).map((x: any) => [...x])).toEqual([wallets, [3n, 3n]])

    const reverting = giveawayChainClientOn('polygon', stub({ estimateGas: async () => { throw callException('_issueToken: ITEM_EXHAUSTED') } }))
    const err = await reverting.signMint(signer, CONTRACT, wallets, ['3', '3'], 4, fees).catch((e) => e)
    expect(err).toBeInstanceOf(GiveawayRevert)
    expect(revertReason(err)).toBe('sold_out')
    const down = giveawayChainClientOn('polygon', stub({ estimateGas: async () => { throw Object.assign(new Error(`bad ${wallets[0]}`), { code: 'NETWORK_ERROR' }) } }))
    const err2 = await down.signMint(signer, CONTRACT, wallets, ['3', '3'], 4, fees).catch((e) => e)
    expect(err2).toBeInstanceOf(GiveawayRpcError)
    for (const e of [err, err2]) {
      expect(String(e.message)).not.toMatch(/0x[0-9a-f]{40}/i)
      expect(JSON.stringify(e)).not.toMatch(/0x[0-9a-f]{40}|deadbeef/i)
    }
  })

  it('signs a POL transfer at gas limit 21000, and a mint at a given gas limit without estimating', async () => {
    const signer = Wallet.createRandom()
    const to = Wallet.createRandom().address
    const c = giveawayChainClientOn('polygon-amoy', stub({}))
    const fees = { maxFeePerGas: 90n * 10n ** 9n, maxPriorityFeePerGas: 30n * 10n ** 9n }
    const s = await c.signTransfer(signer, to, 123n, 0, fees)
    const tx = Transaction.from(s.raw)
    expect([tx.to, tx.value, tx.gasLimit, tx.chainId, tx.data]).toEqual([to, 123n, 21_000n, 80002n, '0x'])
    expect(s.fees).toEqual(fees)
    const m = await c.signMint(signer, CONTRACT, [to], ['1'], 1, fees, 77_000n)
    expect(m.gasLimit).toBe(77_000n)
  })

  it('treats "already known" and "nonce too low" for this exact transaction as a sent broadcast', async () => {
    const signer = Wallet.createRandom()
    const fees = { maxFeePerGas: 90n * 10n ** 9n, maxPriorityFeePerGas: 30n * 10n ** 9n }
    const raw = (await giveawayChainClientOn('polygon', stub({})).signTransfer(signer, signer.address, 1n, 0, fees)).raw
    const known = giveawayChainClientOn('polygon', stub({
      broadcastTransaction: async () => { throw Object.assign(new Error('x'), { code: 'UNKNOWN_ERROR', error: { message: 'already known' } }) },
    }))
    await expect(known.broadcast(raw)).resolves.toBeUndefined()
    const mined = giveawayChainClientOn('polygon', stub({
      broadcastTransaction: async () => { throw Object.assign(new Error('x'), { code: 'NONCE_EXPIRED' }) },
      getTransaction: async (h: string) => ({ hash: h }),
    }))
    await expect(mined.broadcast(raw)).resolves.toBeUndefined()
    const other = giveawayChainClientOn('polygon', stub({
      broadcastTransaction: async () => { throw Object.assign(new Error('x'), { code: 'NONCE_EXPIRED' }) },
      getTransaction: async () => null,
    }))
    await expect(other.broadcast(raw)).rejects.toMatchObject({ code: 'NONCE_EXPIRED', down: false })
    const offline = giveawayChainClientOn('polygon', stub({
      broadcastTransaction: async () => { throw Object.assign(new Error(`down ${raw}`), { code: 'NETWORK_ERROR' }) },
    }))
    const err = await offline.broadcast(raw).catch((e) => e)
    expect(err).toMatchObject({ code: 'NETWORK_ERROR', down: true })
    expect(err.message).not.toContain(raw.slice(2, 40))
  })

  it('is built once per chain from config, and tests can replace it', () => {
    expect(giveawayChainClient('polygon-amoy')).toBe(giveawayChainClient('polygon-amoy'))
    expect(giveawayChainClient('polygon')).not.toBe(giveawayChainClient('polygon-amoy'))
    const fake = giveawayChainClientOn('polygon-amoy', stub({}))
    setGiveawayChainClientForTests('polygon-amoy', fake)
    expect(giveawayChainClient('polygon-amoy')).toBe(fake)
  })
})
