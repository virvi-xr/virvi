import type { AuthChain } from '../../src/services/dcl/entity.js'
import { CatalystError, type ContentDest, type ContentServer } from '../../src/services/dcl/catalyst-client.js'
import type { LiveEntity } from '../../src/services/dcl/worlds-client.js'

export class FakeCatalystClient implements ContentServer {
  /** Live entities, keyed by pointer (an entity covering several parcels is listed under each). */
  entities = new Map<string, LiveEntity[]>()
  deployed: Array<{ entityId: string; authChain: AuthChain; files: Map<string, Uint8Array> }> = []
  /** Content files the server holds, by hash (deploys don't add to it on their own). */
  contents = new Map<string, Uint8Array>()
  failNext?: CatalystError
  down = false

  private hit() {
    if (this.down) throw new CatalystError(0, '', 'fake catalyst down')
  }

  async liveEntities(dest: ContentDest) {
    this.hit()
    const out = new Map<string, LiveEntity>()
    for (const p of dest.parcels) for (const e of this.entities.get(p) ?? []) out.set(e.id, e)
    return [...out.values()]
  }
  async deploy(d: { entityId: string; authChain: AuthChain; files: Map<string, Uint8Array> }) {
    this.hit()
    const e = this.failNext
    if (e) {
      this.failNext = undefined
      throw e
    }
    this.deployed.push(d)
  }
  async hasContent(hash: string) { this.hit(); return this.contents.has(hash) }
  async getContent(hash: string) { this.hit(); return this.contents.get(hash) ?? null }
  async contentSize(hash: string) { this.hit(); return this.contents.get(hash)?.byteLength ?? null }
}
