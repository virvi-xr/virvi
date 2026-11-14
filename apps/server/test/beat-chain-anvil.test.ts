import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ContractFactory, Interface, JsonRpcProvider, Network, NonceManager, Wallet } from 'ethers'
import { VIRVI_BEAT_ABI } from '../src/beats/abi.js'
import { BeatRevert, createBeatChainClient, type BeatChainClient } from '../src/beats/chain.js'

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

  it('creates a BEAT and mints it to three wallets', async () => {
    expect(await client.exists(1n)).toBe(false)
    const created = await send({ kind: 'create', tokenId: 1n, tradeable: false })
    expect(created.receipt.ok).toBe(true)
    expect(await client.exists(1n)).toBe(true)

    const wallets = [Wallet.createRandom().address, Wallet.createRandom().address, Wallet.createRandom().address]
    const minted = await send({ kind: 'mint', tokenId: 1n, wallets })
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

  it("has ABI fragments that are a subset of the artifact's", () => {
    const ours = new Interface(VIRVI_BEAT_ABI).format()
    const theirs = new Set(new Interface(artifact.abi).format())
    expect(ours.filter((f) => !theirs.has(f))).toEqual([])
  })
})
