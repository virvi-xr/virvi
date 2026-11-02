import type { AuthChain } from '../../src/services/dcl/entity.js'
import { WorldsError, type LiveEntity, type SignedRequest, type WorldsClient } from '../../src/services/dcl/worlds-client.js'

export class FakeWorldsClient implements WorldsClient {
  entities = new Map<string, LiveEntity[]>()
  deployed: Array<{ entityId: string; authChain: AuthChain; files: Map<string, Uint8Array> }> = []
  signed: Array<{ req: SignedRequest; chain: AuthChain }> = []
  deployers = new Map<string, { owner: string | null; deployers: string[] }>()
  stats = new Map<string, { maxAllowedBytes: number; usedBytes: number }>()
  /** Content files the server holds, by hash (deploys don't add to it on their own). */
  contents = new Map<string, Uint8Array>()
  failNext?: WorldsError
  down = false

  private hit() {
    if (this.down) throw new WorldsError(0, '', 'fake worlds server down')
  }

  private maybeFail() {
    const e = this.failNext
    if (e) {
      this.failNext = undefined
      throw e
    }
  }

  async getWorldEntities(world: string) { this.hit(); return this.entities.get(world.toLowerCase()) ?? [] }
  async deploy(d: { entityId: string; authChain: AuthChain; files: Map<string, Uint8Array> }) {
    this.hit()
    this.maybeFail()
    this.deployed.push(d)
  }
  async sendSigned(req: SignedRequest, chain: AuthChain, _timeoutMs?: number) {
    this.hit()
    this.maybeFail()
    this.signed.push({ req, chain })
  }
  async getDeployers(world: string) { this.hit(); return this.deployers.get(world.toLowerCase()) ?? { owner: null, deployers: [] } }
  async getWalletStats(address: string) { this.hit(); return this.stats.get(address.toLowerCase()) ?? null }
  async hasContent(hash: string) { this.hit(); return this.contents.has(hash) }
  async getContent(hash: string) { this.hit(); return this.contents.get(hash) ?? null }
  async contentSize(hash: string) { this.hit(); return this.contents.get(hash)?.byteLength ?? null }
}
