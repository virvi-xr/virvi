/**
 * VirviStudioRoom — live progress for one Design Studio design.
 *
 * Clients join filtered by designId; only someone on the design (owner, collaborator or viewer: studio/members.ts), or a
 * Virvi admin helping on it (the role read from the database), on a verified account session, may join. The room
 * relays the design's bus topic (studio/events.ts) as `studio_event` messages. Clients send nothing. A `member_removed`
 * event disconnects that user's clients first.
 */

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { Room } = _require('colyseus') as any
type Client = any
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns } from '../db/schema.js'
import { config } from '../config.js'
import { verifySessionToken } from '../auth/tokens.js'
import { type Actor } from '../auth/actor.js'
import { checkedActor } from '../auth/admin.js'
import { isUuid } from '../auth/scene-from.js'
import { studioTopic, type StudioEvent } from '../studio/events.js'
import { isVirviAdmin } from '../studio/pricing.js'
import { designRole } from '../studio/members.js'

/** The close code a removed member's client sees. */
const REMOVED = 4403

interface JoinOptions {
  sessionToken?: string
  designId?: string
}

export class VirviStudioRoom extends Room {
  private designId = ''
  private relay: ((e: StudioEvent) => void) | null = null

  async onAuth(_client: Client, options: JoinOptions): Promise<Actor> {
    const claims = verifySessionToken(options?.sessionToken)
    const actor = await checkedActor(claims)
    // Account sessions only: no anonymous visitors, no scene passes, no unverified wallets.
    if (!config.studioEnabled || claims?.kind !== 'account' || !actor.userId || !actor.verified) throw new Error('Unauthorized')
    if (!options?.designId || !isUuid(options.designId) || options.designId !== this.designId) throw new Error('Unauthorized')
    const [design] = await db.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.id, options.designId))
    if (!design || (!(await designRole(design.id, actor.userId)) && !(await isVirviAdmin(actor.userId)))) throw new Error('Unauthorized')
    // Colyseus keeps it as client.auth: who each client is, for member_removed
    return actor
  }

  async onCreate(options: JoinOptions) {
    this.designId = typeof options?.designId === 'string' ? options.designId : ''
    if (!isUuid(this.designId)) return
    this.relay = (e) => {
      if (e.type === 'member_removed') {
        for (const c of this.clients.filter((c: Client) => (c.auth as Actor | undefined)?.userId === e.userId)) c.leave(REMOVED)
      }
      this.broadcast('studio_event', e)
    }
    await this.presence.subscribe(studioTopic(this.designId), this.relay)
  }

  async onDispose() {
    if (this.relay) await this.presence.unsubscribe(studioTopic(this.designId), this.relay)
  }
}
