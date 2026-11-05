import { getAddress, JsonRpcProvider, zeroPadValue } from 'ethers'
import { config } from '../../config.js'

/**
 * Reading MANA transfers on Polygon PoS through JSON-RPC (the server only reads; it never signs). Tests replace the
 * reader with setPolygon.
 */

/** keccak256("Transfer(address,address,uint256)"), an ERC-20 Transfer log's first topic */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export type PolygonLog = {
  address: string; topics: string[]; data: string; logIndex: number
  transactionHash?: string; blockNumber?: number // set on logs from getLogs; a receipt's caller knows its own
}

export type ManaTransfer = { txHash: string; logIndex: number; from: string; to: string; amountWei: bigint; blockNumber: number }

export interface PolygonReader {
  latestBlock(): Promise<number>
  receipt(txHash: string): Promise<{ status: 0 | 1; blockNumber: number; logs: PolygonLog[] } | null>
  blockTime(blockNumber: number): Promise<Date>
  transfersTo(token: string, to: string, fromBlock: number, toBlock: number): Promise<ManaTransfer[]>
}

const topicAddress = (t: string) => getAddress('0x' + t.slice(-40))

/** The token's ERC-20 Transfer logs among these, decoded; any other contract's or event's log, or a malformed one, is skipped. */
export function parseTransfers(token: string, logs: PolygonLog[]): ManaTransfer[] {
  const out: ManaTransfer[] = []
  for (const l of logs) {
    if (l.address.toLowerCase() !== token.toLowerCase()) continue
    if (l.topics.length !== 3 || l.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue
    if (!/^0x[0-9a-fA-F]{64}$/.test(l.data) || !l.topics.slice(1).every((t) => /^0x[0-9a-fA-F]{64}$/.test(t))) continue
    out.push({
      txHash: l.transactionHash ?? '', logIndex: l.logIndex, from: topicAddress(l.topics[1]), to: topicAddress(l.topics[2]),
      amountWei: BigInt(l.data), blockNumber: l.blockNumber ?? 0,
    })
  }
  return out
}

class RpcPolygon implements PolygonReader {
  constructor(private provider: JsonRpcProvider) {}

  latestBlock() { return this.provider.getBlockNumber() }

  async receipt(txHash: string) {
    const r = await this.provider.getTransactionReceipt(txHash)
    if (!r) return null
    return {
      status: (r.status === 1 ? 1 : 0) as 0 | 1,
      blockNumber: r.blockNumber,
      logs: r.logs.map((l) => ({
        address: l.address, topics: [...l.topics], data: l.data, logIndex: l.index, transactionHash: l.transactionHash, blockNumber: l.blockNumber,
      })),
    }
  }

  async blockTime(blockNumber: number) {
    const b = await this.provider.getBlock(blockNumber)
    if (!b) throw new Error(`block ${blockNumber} not found`)
    return new Date(b.timestamp * 1000)
  }

  async transfersTo(token: string, to: string, fromBlock: number, toBlock: number) {
    const logs = await this.provider.getLogs({ address: token, topics: [TRANSFER_TOPIC, null, zeroPadValue(to, 32)], fromBlock, toBlock })
    return parseTransfers(token, logs.map((l) => ({
      address: l.address, topics: [...l.topics], data: l.data, logIndex: l.index, transactionHash: l.transactionHash, blockNumber: l.blockNumber,
    })))
  }
}

let rpc: PolygonReader | null = null
let override: PolygonReader | null = null

/** Tests replace the reader with a fake; null puts the JSON-RPC one back. */
export function setPolygon(r: PolygonReader | null): void {
  override = r
}

/** The Polygon reader: JSON-RPC (ethers JsonRpcProvider) on POLYGON_RPC_URL, on chain 137 only. */
export function getPolygon(): PolygonReader {
  if (override) return override
  if (!rpc) {
    rpc = new RpcPolygon(new JsonRpcProvider(config.studioMana.rpcUrl, config.studioMana.chainId, { staticNetwork: true }))
  }
  return rpc
}
