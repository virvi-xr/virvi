import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ContractFactory, Interface, JsonRpcProvider, Network, NonceManager, Wallet } from 'ethers'
import { VIRVI_BEAT_ABI } from '../src/beats/abi.js'
import { BeatRevert, beatInterface, createBeatChainClient, type BeatChainClient } from '../src/beats/chain.js'
import { buildSafeBatchFile, planReissueCalls } from '../src/beats/reissue.js'

/** The real contract on a local anvil chain (LIV-11). Skipped when anvil isn't installed or the contract isn't built
 * (`cd contracts && forge build`). */

const ARTIFACT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/out/VirviBeat.sol/VirviBeat.json')
const hasAnvil = spawnSync('anvil', ['--version']).status === 0
const ready = hasAnvil && existsSync(ARTIFACT)

// Anvil's public development keys (accounts 0 and 1): admin and minter.
const ADMIN_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const MINTER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

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

describe.skipIf(!ready)('BEAT chain client on anvil', () => {
  let anvil: ChildProcess
  let client: BeatChainClient
  let provider: JsonRpcProvider
  let contract: string
  let admin: NonceManager
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
    admin = new NonceManager(new Wallet(ADMIN_KEY, provider))
    const minter = new Wallet(MINTER_KEY)
    const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, admin)
    const c = await factory.deploy(await admin.getAddress(), minter.address, 'https://example.test/beats/')
    await c.waitForDeployment()
    contract = await c.getAddress()
    client = createBeatChainClient({ chain: 'polygon-amoy', rpcUrl: url, contract, minterKey: MINTER_KEY })
  })

  afterAll(() => {
    anvil?.kill()
    provider?.destroy()
  })

  async function send(call: Parameters<BeatChainClient['estimate']>[0]) {
    const s = await client.sign(call, await client.nonce('pending'))
    await client.broadcast(s.raw)
    for (let i = 0; i < 50; i++) {
      const r = await client.receipt(s.hash)
      if (r) return { ...s, receipt: r }
      await new Promise((ok) => setTimeout(ok, 50))
    }
    throw new Error('no receipt')
  }

  it('money C1: reads the chain id, the contract\'s code and the minter\'s role; another address has no code or role', async () => {
    expect(await client.chainId()).toBe(80002)
    expect(await client.contractHasCode()).toBe(true)
    expect(await client.minterHasRole()).toBe(true)
    const f = await client.feeData()
    expect(f.baseFeePerGas).not.toBeNull()
    expect(f.maxFeePerGas).toBeGreaterThanOrEqual(f.maxPriorityFeePerGas)
    const empty = createBeatChainClient({ chain: 'polygon-amoy', rpcUrl: (provider as any)._getConnection().url, contract: '0x000000000000000000000000000000000000dEaD', minterKey: MINTER_KEY })
    expect(await empty.contractHasCode()).toBe(false)
    const stranger = createBeatChainClient({ chain: 'polygon-amoy', rpcUrl: (provider as any)._getConnection().url, contract, minterKey: ADMIN_KEY })
    expect(await stranger.minterHasRole()).toBe(false)
  })

  it('creates a BEAT and mints it to three wallets', async () => {
    expect(await client.exists(1n)).toBe(false)
    const created = await send({ kind: 'create', tokenId: 1n, tradeable: false })
    expect(created.receipt.ok).toBe(true)
    expect(await client.exists(1n)).toBe(true)

    const wallets = [Wallet.createRandom().address, Wallet.createRandom().address, Wallet.createRandom().address]
    // Reads just before and just after the tx (well inside ethers' default 250ms cache) must not be stale
    expect(await client.nonce('latest')).toBe(1)
    expect(await client.isMinted(1n, wallets[0])).toBe(false)
    const blockBefore = await client.latestBlock()
    const t0 = Date.now()
    const minted = await send({ kind: 'mint', tokenId: 1n, wallets })
    expect(await client.nonce('latest')).toBe(2)
    expect(await client.isMinted(1n, wallets[0])).toBe(true)
    expect(await client.latestBlock()).toBeGreaterThan(blockBefore)
    expect(Date.now() - t0).toBeLessThan(250)
    expect(minted.receipt.ok).toBe(true)
    expect(minted.receipt.blockNumber).toBeGreaterThan(0)
    for (const w of wallets) expect(await client.isMinted(1n, w)).toBe(true)
    expect(await client.nonce('latest')).toBe(2)
    expect(await client.latestBlock()).toBeGreaterThanOrEqual(minted.receipt.blockNumber)
    expect(await client.balanceWei()).toBeGreaterThan(0n)

    // Re-broadcasting the mined transaction is success ("nonce too low" for this exact hash)
    await expect(client.broadcast(minted.raw)).resolves.toBeUndefined()
  })

  it('skips a rejecting receiver with MintSkipped, minting the rest at the estimated gas limit', async () => {
    // A contract whose code is just revert(0, 0): it rejects every ERC-1155 receiver hook
    const tx = await admin.sendTransaction({ data: '0x6460006000fd6000526005601bf3' })
    const r = (await tx.wait())!
    const bad = r.contractAddress!
    expect(await client.codeAt(bad)).toBe(true)
    const good = Wallet.createRandom().address
    expect(await client.codeAt(good)).toBe(false)

    const minted = await send({ kind: 'mint', tokenId: 1n, wallets: [good, bad] })
    expect(minted.receipt.ok).toBe(true)
    expect(client.skippedIn(minted.receipt.logs)).toEqual([bad])
    expect(await client.isMinted(1n, good)).toBe(true)
    expect(await client.isMinted(1n, bad)).toBe(false)
  })

  it('throws BeatRevert named UnknownBeat when estimating a mint for an unknown id', async () => {
    const err = await client.estimate({ kind: 'mint', tokenId: 999n, wallets: [Wallet.createRandom().address] }).catch((e) => e)
    expect(err).toBeInstanceOf(BeatRevert)
    expect(err.name).toBe('UnknownBeat')
    expect(err.message).not.toMatch(/0x[0-9a-f]{40}/i)
  })

  it('closes a BEAT, after which a mint reverts with BeatClosedError', async () => {
    expect((await send({ kind: 'close', tokenId: 1n })).receipt.ok).toBe(true)
    await expect(client.estimate({ kind: 'mint', tokenId: 1n, wallets: [Wallet.createRandom().address] }))
      .rejects.toMatchObject({ name: 'BeatClosedError' })
  })

  it('reads balanceOf, replacedBy (at a block too) and the Reissued logs, for calls run from a Safe batch file', async () => {
    const old = Wallet.createRandom().address
    const fresh = Wallet.createRandom().address
    for (const [id, tradeable] of [[2n, false], [3n, false], [4n, true]] as const) {
      expect((await send({ kind: 'create', tokenId: id, tradeable })).receipt.ok).toBe(true)
      expect((await send({ kind: 'mint', tokenId: id, wallets: [old] })).receipt.ok).toBe(true)
    }
    expect(await client.balanceOf(old, 4n)).toBe(1n)
    expect(await client.balanceOf(fresh, 4n)).toBe(0n)
    expect(await client.replacedBy(2n, old)).toBeNull()
    const before = await client.latestBlock()

    // The admin (anvil's account 0 here; the Safe on mainnet) runs each transaction of the file, encoded from its
    // contractMethod and contractInputsValues as Transaction Builder does
    const calls = planReissueCalls([{ tokenId: '2', tradeable: false }, { tokenId: '3', tradeable: false }, { tokenId: '4', tradeable: true }])
    expect(calls).toEqual([['2', '3'], ['4']])
    const file = buildSafeBatchFile({ id: '00000000-0000-4000-8000-00000000000a', oldWallet: old.toLowerCase(), newWallet: fresh.toLowerCase() }, 'polygon-amoy', contract, calls, new Date())
    expect(file.chainId).toBe('80002')
    const hashes: string[] = []
    for (const t of file.transactions) {
      const v = t.contractInputsValues
      const data = beatInterface.encodeFunctionData(t.contractMethod.name, [v.from, v.to, v.ids.slice(1, -1).split(',')])
      const tx = await admin.sendTransaction({ to: t.to, data })
      const r = (await tx.wait())!
      expect(r.status).toBe(1)
      hashes.push(r.hash)
    }
    const after = await client.latestBlock()
    for (const id of [2n, 3n, 4n]) {
      expect(await client.replacedBy(id, old)).toBe(fresh)
      expect(await client.isMinted(id, fresh)).toBe(true)
    }
    // At the block before the reissue, nothing was replaced (the watcher reads at the confirmation depth this way)
    expect(await client.replacedBy(2n, old, before)).toBeNull()
    const logs = await client.reissuedLogs(old, fresh, before + 1, after)
    expect(logs.map((l) => [l.tokenId, l.txHash])).toEqual([[2n, hashes[0]], [3n, hashes[0]], [4n, hashes[1]]])
    expect(await client.reissuedLogs(old, Wallet.createRandom().address, before + 1, after)).toEqual([])
    // A second reissue of the same old wallet reverts AlreadyReplaced (decoded with the ABI's new errors)
    await expect(admin.sendTransaction({ to: contract, data: beatInterface.encodeFunctionData('reissue', [old, Wallet.createRandom().address, [2n]]) }))
      .rejects.toThrow()
  })

  it("has ABI fragments that are a subset of the artifact's", () => {
    const ours = new Interface(VIRVI_BEAT_ABI).format()
    const theirs = new Set(new Interface(artifact.abi).format())
    expect(ours.filter((f) => !theirs.has(f))).toEqual([])
  })
})
