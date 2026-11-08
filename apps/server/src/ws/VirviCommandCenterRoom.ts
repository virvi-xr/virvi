/**
 * VirviCommandCenterRoom — Colyseus room for multi-world event orchestration.
 *
 * Clients join filtered by eventId (or userId for global view).
 * The room aggregates status from all scene rooms linked to the event
 * and broadcasts command_center_status updates periodically.
 *
 * Also handles cross_world_update messages that fan out preset/video changes
 * to all scenes linked to an event.
 */

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { Room } = _require('colyseus') as any
type Client = any
import { and, eq } from 'drizzle-orm'
import { liveScene } from '../scenes/live.js'
import { db } from '../db/connection.js'
import {
  events,
  eventSceneLinks,
  scenes,
  sceneDeployments,
} from '../db/schema.js'
import { dispatchPlatformCallbacks } from '../integrations/platform-hooks.js'
import { verifySessionToken } from '../auth/tokens.js'
import { actorFromClaims, type Actor } from '../auth/actor.js'
import { isUuid } from '../auth/scene-from.js'
import { accessibleSceneIds } from '../routes/command-center.js'

interface JoinOptions {
  sessionToken: string
  eventId?: string
  userId?: string
  [key: string]: unknown
}

interface WorldStatus {
  sceneId: string
  sceneName: string
  /** The scene's thumbnail (LIV-88), null when it has none. */
  sceneThumbnailUrl: string | null
  platform: string | null
  deploymentStatus: string | null
  visitorCount: number
  activePreset: string | null
}

export class VirviCommandCenterRoom extends Room {
  private eventId: string = ''
  private userId: string = ''
  private statusInterval: ReturnType<typeof setInterval> | null = null

  async onAuth(_client: Client, options: JoinOptions): Promise<Actor> {
    const claims = verifySessionToken(options?.sessionToken)
    const actor = actorFromClaims(claims)
    // Account sessions only: no anonymous visitors, no scene passes, no unverified wallets.
    if (claims?.kind !== 'account' || !actor.userId || !actor.verified) throw new Error('Unauthorized')
    return actor
  }

  onCreate(options: JoinOptions) {
    this.eventId = options.eventId || ''
    console.log(`[VirviCommandCenter] Created for event ${this.eventId || 'global'}`)

    // ── Cross-World Update ─────────────────────────────────────────────
    // Receives an action and fans it out to all scene rooms linked to this event
    this.onMessage('cross_world_update', async (client, message) => {
      const actor = client.auth as Actor
      if (!actor?.userId || !actor.verified) {
        return client.send('virvi_error', { code: 'forbidden', messageType: 'cross_world_update' })
      }
      console.log(`[VirviCommandCenter] cross_world_update from ${client.sessionId}`)

      if (!this.eventId) {
        client.send('error', { message: 'No event context for cross-world update' })
        return
      }

      try {
        // Same rule as POST /api/command-center/:eventId/broadcast: event owner or admin.
        const event = await db.query.events.findFirst({ where: eq(events.id, this.eventId), columns: { ownerId: true } })
        if (!event || (event.ownerId !== actor.userId && actor.role !== 'admin')) {
          return client.send('virvi_error', { code: 'forbidden', messageType: 'cross_world_update' })
        }

        // Get all scenes linked to this event
        const links = await db
          .select({ sceneId: eventSceneLinks.sceneId })
          .from(eventSceneLinks)
          .where(eq(eventSceneLinks.eventId, this.eventId))

        const sceneIds = await accessibleSceneIds(actor, links.map((l) => l.sceneId))
        const action = message.action || message.data

        // Fan out to HTTP callbacks for each scene
        // (WebSocket-connected scenes receive updates through their own rooms;
        //  this handles non-WS platforms like Second Life)
        for (const sceneId of sceneIds) {
          dispatchPlatformCallbacks(sceneId, {
            action: 'cross_world_update',
            eventId: this.eventId,
            ...action,
          }).catch(() => {})
        }

        // Broadcast confirmation back to all command center clients
        this.broadcast('cross_world_dispatched', {
          eventId: this.eventId,
          targetScenes: sceneIds,
          action,
        })
      } catch (err) {
        console.error('[VirviCommandCenter] Error dispatching cross-world update:', err)
        client.send('error', { message: 'Failed to dispatch cross-world update' })
      }
    })

    // ── Start periodic status broadcasts ───────────────────────────────
    this.statusInterval = setInterval(() => {
      this.broadcastStatus()
    }, 5000) // Every 5 seconds
  }

  async onJoin(client: Client, options: JoinOptions) {
    // this.eventId is the room's own event (set in onCreate); a joining client's options.eventId can be faked via joinById.
    const actor = client.auth as Actor
    if (!isUuid(this.eventId)) throw new Error('Forbidden')
    if (actor.role !== 'admin') {
      const event = await db.query.events.findFirst({ where: eq(events.id, this.eventId), columns: { ownerId: true } })
      if (!event || event.ownerId !== actor.userId) throw new Error('Forbidden')
    }
    this.userId = options.userId || client.sessionId
    console.log(`[VirviCommandCenter] Client joined: ${client.sessionId}`)

    // Send initial status immediately
    await this.broadcastStatus()
  }

  onLeave(client: Client) {
    console.log(`[VirviCommandCenter] Client left: ${client.sessionId}`)
  }

  onDispose() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval)
    }
    console.log(`[VirviCommandCenter] Disposed (event: ${this.eventId || 'global'})`)
  }

  /**
   * Gather status from all worlds linked to the event and broadcast.
   */
  private async broadcastStatus() {
    if (this.clients.length === 0) return

    try {
      let worldStatuses: WorldStatus[] = []

      if (this.eventId) {
        // Event-scoped: get scenes linked to this event
        const links = await db
          .select({
            sceneId: scenes.id,
            sceneName: scenes.name,
            sceneThumbnailUrl: scenes.thumbnailUrl,
            activePreset: scenes.activePresetId,
          })
          .from(eventSceneLinks)
          .innerJoin(scenes, eq(eventSceneLinks.sceneId, scenes.id))
          .where(and(eq(eventSceneLinks.eventId, this.eventId), liveScene()))

        worldStatuses = await Promise.all(
          links.map(async (link) => {
            // Get latest deployment for this scene
            const deployment = await db.query.sceneDeployments.findFirst({
              where: eq(sceneDeployments.sceneId, link.sceneId),
              orderBy: (d, { desc }) => [desc(d.createdAt)],
            })

            return {
              sceneId: link.sceneId,
              sceneName: link.sceneName,
              sceneThumbnailUrl: link.sceneThumbnailUrl,
              platform: deployment?.platform || null,
              deploymentStatus: deployment?.status || null,
              visitorCount: 0, // TODO: count from active Colyseus room clients
              activePreset: link.activePreset,
            }
          }),
        )
      }

      const aggregate = {
        totalVisitors: worldStatuses.reduce((sum, w) => sum + w.visitorCount, 0),
        worldCount: worldStatuses.length,
        deployedCount: worldStatuses.filter((w) => w.deploymentStatus === 'deployed').length,
      }

      this.broadcast('command_center_status', {
        eventId: this.eventId || null,
        worlds: worldStatuses,
        aggregate,
        timestamp: Date.now(),
      })
    } catch (err) {
      console.error('[VirviCommandCenter] Error broadcasting status:', err)
    }
  }
}
