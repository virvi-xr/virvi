import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Contract, ContractFactory, Interface, JsonRpcProvider, Network, NonceManager, Wallet, parseEther } from 'ethers'
import { DCL_COLLECTION_ABI } from '../src/giveaways/abi.js'
import { createGiveawayChainClient, revertReason, type GiveawayChainClient } from '../src/giveaways/chain.js'

/** The giveaway chain client against the test collection (contracts/src/test/MockDclCollection.sol) on a local anvil
 * chain (LIV-194). Skipped when anvil isn't installed or the contract isn't built (`cd contracts && forge build`). */

const ARTIFACT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/out/MockDclCollection.sol/MockDclCollection.json')
const hasAnvil = spawnSync('anvil', ['--version']).status === 0
const ready = hasAnvil && existsSync(ARTIFACT)

// Anvil's public development key (account 0): the collection's creator.
const CREATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => ok(port))
    })
  })
}

describe.skipIf(!ready)('giveaway chain client on anvil', () => {
  let anvil: ChildProcess
  let client: GiveawayChainClient
  let provider: JsonRpcProvider
  let collection: Contract
  let contract: string
  let creator: NonceManager
  const giveaway = Wallet.createRandom()
  const artifact = ready ? JSON.parse(readFileSync(ARTIFACT, 'utf8')) : null

  beforeAll(async () => {
    const port = await freePort()
    anvil = spawn('anvil', ['--chain-id', '80002', '--port', String(port), '--silent'], { stdio: 'ignore' })
    const url = `http://127.0.0.1:${port}`
    provider = new JsonRpcProvider(url, Network.from(80002), { staticNetwork: true })
    for (let i = 0; ; i++) {
      try { await provider.getBlockNumber(); break } catch { if (i > 100) throw new Error('anvil did not start') }
      await new Promise((r) => setTimeout(r, 100))
    }
    creator = new NonceManager(new Wallet(CREATOR_KEY, provider))
    const c = await new ContractFactory(artifact.abi, artifact.bytecode.object, creator).deploy()
    await c.waitForDeployment()
    contract = await c.getAddress()
    collection = new Contract(contract, artifact.abi, creator)
    await (await collection.addItem(2n)).wait()
    await (await collection.completeCollection()).wait()
    await (await collection.setApproved(true)).wait()
    await (await creator.sendTransaction({ to: giveaway.address, value: parseEther('10') })).wait()
    client = createGiveawayChainClient('polygon-amoy', url)
  })

  afterAll(() => {
    anvil?.kill()
    provider?.destroy()
  })

  async function mined(hash: string) {
    for (let i = 0; i < 50; i++) {
      const r = await client.receipt(hash)
      if (r) return r
      await new Promise((ok) => setTimeout(ok, 50))
    }
    throw new Error('no receipt')
  }

  const run = async (p: Promise<{ wait(): Promise<unknown> }>) => { await (await p).wait() }
  const mintError = (wallets: string[], itemIds: string[]) =>
    client.nonce(giveaway.address, 'pending').then((n) => client.signMint(giveaway, contract, wallets, itemIds, n)).then(() => null, (e) => e)

  it('reads the item: no minter yet', async () => {
    expect(await client.itemState(contract, '0', giveaway.address)).toEqual({
      approved: true, completed: true, canMint: false, remaining: 2n, rarity: 'common',
    })
  })

  it('counts an item allowance as a minter, and a global minter after setMinters', async () => {
    await run(collection.setItemsMinters([0n], [giveaway.address], [1n]))
    expect((await client.itemState(contract, '0', giveaway.address)).canMint).toBe(true)
    await run(collection.setItemsMinters([0n], [giveaway.address], [0n]))
    expect((await client.itemState(contract, '0', giveaway.address)).canMint).toBe(false)
    await run(collection.setMinters([giveaway.address], [true]))
    expect(await client.itemState(contract, '0', giveaway.address)).toMatchObject({ canMint: true, remaining: 2n })
  })

  it('signs, broadcasts and confirms a mint to two wallets, and reads their two Issue logs', async () => {
    const wallets = [Wallet.createRandom().address, Wallet.createRandom().address]
    const nonce = await client.nonce(giveaway.address, 'pending')
    const balance = await client.balanceWei(giveaway.address)
    const s = await client.signMint(giveaway, contract, wallets, ['0', '0'], nonce)
    expect(s.fees.maxPriorityFeePerGas).toBeGreaterThanOrEqual(30_000_000_000n)
    await client.broadcast(s.raw)
    const r = await mined(s.hash)
    expect(r.ok).toBe(true)
    expect(r.blockNumber).toBeGreaterThan(0)
    expect(r.feeWei).toBeGreaterThan(0n)
    expect(r.issues).toEqual([
      { beneficiary: wallets[0], tokenId: ((0n << 216n) | 1n).toString(), itemId: '0' },
      { beneficiary: wallets[1], tokenId: '2', itemId: '0' },
    ])
    expect(await client.balanceWei(giveaway.address)).toBe(balance - r.feeWei)
    expect(await client.nonce(giveaway.address, 'latest')).toBe(nonce + 1)
    expect(await client.latestBlock()).toBeGreaterThanOrEqual(r.blockNumber)
    expect((await client.itemState(contract, '0', giveaway.address)).remaining).toBe(0n)
    // Re-broadcasting the mined transaction is success ("nonce too low" for this exact hash)
    await expect(client.broadcast(s.raw)).resolves.toBeUndefined()
  })

  it('maps a third mint, an unapproved collection and a removed minter to their reasons', async () => {
    const w = [Wallet.createRandom().address]
    expect(revertReason(await mintError(w, ['0']))).toBe('sold_out')

    await run(collection.addItem(5n))
    await run(collection.setApproved(false))
    expect((await client.itemState(contract, '1', giveaway.address)).approved).toBe(false)
    expect(revertReason(await mintError(w, ['1']))).toBe('not_approved')

    await run(collection.setApproved(true))
    await run(collection.setMinters([giveaway.address], [false]))
    const err = await mintError(w, ['1'])
    expect(revertReason(err)).toBe('not_minter')
    expect(err.message).not.toMatch(/0x[0-9a-f]{40}/i)
  })

  it('signs and sends a POL transfer', async () => {
    const to = Wallet.createRandom().address
    const s = await client.signTransfer(giveaway, to, parseEther('1.5'), await client.nonce(giveaway.address, 'pending'))
    expect(s.hash).toBeTypeOf('string')
    await client.broadcast(s.raw)
    expect((await mined(s.hash)).ok).toBe(true)
    expect(await client.balanceWei(to)).toBe(parseEther('1.5'))
  })

  it("has ABI fragments that are a subset of the artifact's", () => {
    const ours = new Interface(DCL_COLLECTION_ABI).format()
    const theirs = new Set(new Interface(artifact.abi).format())
    expect(ours.filter((f) => !theirs.has(f))).toEqual([])
  })
})
