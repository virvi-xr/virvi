import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { Room } = _require('colyseus') as any
type Client = any
import { eq, and, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  scenes,
  scenePresets,
  sceneElements,
  sceneElementInstances,
  users,
} from '../db/schema.js'
import {
  serializePreset,
  serializeSingleElement,
  serializeSingleInstance,
} from '../services/scene-serializer.js'
import { dispatchPlatformCallbacks } from '../integrations/platform-hooks.js'
import { config } from '../config.js'
import { verifySessionToken, type SessionClaims } from '../auth/tokens.js'
import { pairingActive, pairingLive } from '../hyperfy/pairing.js'
import { deviceActive, deviceLive } from '../ar/devices.js'
import { ANONYMOUS, actorFromClaims, type Actor } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess, toVenueAccessMessage, type SceneAccess } from '../auth/permissions.js'
import { authorizeSceneMessage, propertiesOf, type GuardResult, type GuardTarget } from './scene-guard.js'
import { getSceneLibraryItem } from '../library/scene-library.js'
import { venueTopic, publishSceneTouched, STREAMS_TOPIC, type VenueEvent, type StreamStatusEvent } from '../realtime/bus.js'
import { normalizeUrl, withLiveStatus, withLiveVideo } from '../streaming/live-status.js'
import { FRAMEABLE_TYPES, VideoSourceType, checkFrame, type VenueAccessMessage } from '@virvixr/shared'
import { screenShowingsMessages, SHOWINGS_REFRESH_MS } from '../scenes/showings.js'
import { hold, holderOf, release, releaseAll, sweepExpired } from './draft-holds.js'
import { checkParentInstance } from '../scenes/instance-parent.js'

interface JoinOptions {
  sessionToken: string
  sceneId: string
  clientType?: 'host' | 'analytics'
  user?: { id: string; displayName?: string; connectedWallet?: string }
  [key: string]: unknown
}

interface ClientMeta {
  userId: string
  displayName: string
  clientType: 'host' | 'analytics'
  sceneId: string
}

export const DRAFT_ELEMENTS = new Set(['image', 'video', 'model', 'sound', 'ad_space'])
const isVec3 = (v: any) => !!v && typeof v === 'object' && ['x', 'y', 'z'].every((k) => Number.isFinite(v[k]) && typeof v[k] === 'number')
export function isValidDraft(m: any) {
  return !!m && DRAFT_ELEMENTS.has(m.element) && isVec3(m.position) && isVec3(m.rotation) && isVec3(m.scale)
}

/** A room client's key in the draft-hold registry. */
const roomKey = (sessionId: string) => `room:${sessionId}`

/** The scene rooms on this process, by scene, so the AR draft routes can relay into them. */
const roomsByScene = new Map<string, Set<VirviSceneRoom>>()
export function roomsForScene(sceneId: string): VirviSceneRoom[] {
  return [...(roomsByScene.get(sceneId) ?? [])]
}

/** Ends every lapsed AR hold and tells the scene's editors. Runs every 30 s; exported so tests can pass their own `now`. */
export function runDraftSweep(now = Date.now()): void {
  for (const { sceneId, sk } of sweepExpired(now)) {
    for (const room of roomsForScene(sceneId)) room.relayArDraftEnd(sk, false).catch(() => {})
  }
}
setInterval(() => runDraftSweep(), 30_000).unref()

export class VirviSceneRoom extends Room {
  private static activeRoomCount = 0

  private sceneId: string = ''
  private clientMeta: Map<string, ClientMeta> = new Map()
  private accessCache: Map<string, { access: SceneAccess; at: number }> = new Map()
  private lastAccess: Map<string, VenueAccessMessage> = new Map()
  private onVenueEventBound = (e: VenueEvent) => this.onVenueEvent(e)
  private onStreamEventBound = (e: StreamStatusEvent) => this.onStreamEvent(e)
  /** Bumped on every venue event; lookups that started under an older generation must not be cached. */
  private accessGeneration = 0
  private static ACCESS_TTL_MS = 10_000
  /** Scene passes only: when the client's pass expires (ms). After that it acts as an anonymous visitor until renewed. */
  private passExpiry: Map<string, number> = new Map()
  /** Hyperfy and AR passes only: the pairing or headset the session's pass is tied to, re-checked on every access lookup. */
  private linkedPass: Map<string, { via: 'hyperfy' | 'ar'; id: string }> = new Map()
  /** Recent draft timestamps per session, for the 20-per-second limit. */
  private draftTimes = new Map<string, number[]>()
  /** Every registry key this room has held under and not yet released everywhere, so dispose can release them all. */
  private issuedHoldKeys = new Set<string>()
  /** Per-session count of transform_draft messages, taken on arrival (before the guard's await). */
  private draftSeq = new Map<string, number>()
  /** `${sk}\n${sessionId}` -> that session's draft count when it sent transform_end for sk. Older drafts still in
   * their guard when the end arrived are dropped, so they can't re-take the hold. */
  private draftEnds = new Map<string, number>()
  /** `${sk}\n${sessionId}` -> drafts from that session for sk that arrived but haven't finished their handler. */
  private draftsInFlight = new Map<string, number>()
  private static DRAFT_LIMIT = 20
  private static DRAFT_WINDOW_MS = 1000

  /**
   * A Hyperfy pass lives only as long as its pairing, an AR pass only as long as its headset; a missing pairing or
   * device id fails closed.
   */
  private static async linkedPassRevoked(claims: SessionClaims | null): Promise<boolean> {
    if (claims?.via === 'hyperfy') return !(claims.pairingId && (await pairingActive(claims.pairingId)))
    if (claims?.via === 'ar') return !(claims.deviceId && (await deviceActive(claims.deviceId)))
    return false
  }

  /** The pairing or headset a Hyperfy or AR pass is tied to; null for any other token. */
  private static linkOf(claims: SessionClaims | null): { via: 'hyperfy' | 'ar'; id: string } | null {
    if (claims?.via === 'hyperfy' && claims.pairingId) return { via: 'hyperfy', id: claims.pairingId }
    if (claims?.via === 'ar' && claims.deviceId) return { via: 'ar', id: claims.deviceId }
    return null
  }

  private setLink(sessionId: string, claims: SessionClaims | null) {
    const link = VirviSceneRoom.linkOf(claims)
    if (link) this.linkedPass.set(sessionId, link)
    else this.linkedPass.delete(sessionId)
  }

  async onAuth(_client: Client, options: JoinOptions): Promise<Actor> {
    const claims = verifySessionToken(options?.sessionToken)
    // A scene pass acts as its user only in its own scene; anywhere else it's an anonymous visitor.
    // Compare against the room's own scene (set in onCreate from the creating client's options, which
    // runs before the first onAuth) — never a joining client's options.sceneId, which joinById can fake.
    if (claims?.kind === 'scene' && (!claims.sceneId || claims.sceneId !== this.sceneId)) return ANONYMOUS
    if (await VirviSceneRoom.linkedPassRevoked(claims)) return ANONYMOUS
    if (claims?.kind === 'scene') this.passExpiry.set(_client.sessionId, ((claims as { exp?: number }).exp ?? 0) * 1000)
    this.setLink(_client.sessionId, claims)
    return actorFromClaims(claims)
  }

  onCreate(options: JoinOptions) {
    VirviSceneRoom.activeRoomCount++

    if (VirviSceneRoom.activeRoomCount > config.maxRoomsPerServer) {
      VirviSceneRoom.activeRoomCount--
      throw new Error('Server room limit reached')
    }

    this.sceneId = options.sceneId || ''
    if (this.sceneId) {
      if (!roomsByScene.has(this.sceneId)) roomsByScene.set(this.sceneId, new Set())
      roomsByScene.get(this.sceneId)!.add(this)
    }
    console.log(`[VirviSceneRoom] Created for scene ${this.sceneId} (active rooms: ${VirviSceneRoom.activeRoomCount})`)
    if (this.sceneId) this.presence.subscribe(venueTopic(this.sceneId), this.onVenueEventBound)
    if (this.sceneId) this.presence.subscribe(STREAMS_TOPIC, this.onStreamEventBound)
    // Players hold SHOWINGS_WINDOW_MS of showings: top them up well before they run out
    if (this.sceneId) this.clock.setInterval(() => void this.sendShowings(), SHOWINGS_REFRESH_MS)

    // ── Scene pass renewal: a fresh pass for the same user and this scene extends the session ──
    this.onMessage('auth_renew', async (client: Client, message: any) => {
      const claims = verifySessionToken(message?.sessionToken)
      const actor = client.auth as Actor
      const revoked = await VirviSceneRoom.linkedPassRevoked(claims)
      const ok =
        !revoked && claims?.kind === 'scene' && claims.sceneId === this.sceneId && !!actor?.userId && claims.id === actor.userId && this.passExpiry.has(client.sessionId)
      if (!ok) {
        client.send('virvi_error', { code: 'auth_renew_refused', messageType: 'auth_renew' })
        return
      }
      this.passExpiry.set(client.sessionId, ((claims as { exp?: number }).exp ?? 0) * 1000)
      this.setLink(client.sessionId, claims)
      this.accessCache.delete(client.sessionId)
      client.send('auth_renew_ack', {})
    })

    // ── Scene Preset Updates (create/update/delete elements) ──────────────
    this.guarded('scene_preset_update', async (client, message, result) => {
      console.log(`[VirviSceneRoom] scene_preset_update from ${client.sessionId}`, message.action)

      await this.persistPresetUpdate(message, result.target)
      if (result.broadcast && this.sceneId) await publishSceneTouched(this.sceneId)
      client.send('scene_preset_update_ack', { action: message.action, id: message.elementData?.sk || message.id, sk: message.instanceData?.sk })

      // Edits to a non-active preset (e.g. a booking clone during setup) are not broadcast
      if (!result.broadcast) return

      // Broadcast to all OTHER clients in the room
      this.broadcast('scene_preset_update', message, { except: client })

      // Push to HTTP callbacks (Second Life, etc.)
      if (this.sceneId) {
        dispatchPlatformCallbacks(this.sceneId, {
          action: 'config_update',
          elementId: result.target?.elementId || message.elementData?.sk || message.elementData?.id || message.id,
          element: message.element,
          ...this.extractCompactPayload(message),
        }).catch(() => {})
      }
    })

    // ── Transform drafts (editor-only live preview of an unsaved drag) ────
    this.guarded(
      'transform_draft',
      async (client, message, _result, seq) => {
        if (!isValidDraft(message)) {
          client.send('virvi_error', { code: 'bad_request', messageType: 'transform_draft' })
          return
        }
        const sk: string = message.sk
        const endKey = `${sk}\n${client.sessionId}`
        const ended = this.draftEnds.get(endKey)
        if (ended !== undefined) {
          if ((seq as number) <= ended) return // sent before this client's end for sk: stale
          this.draftEnds.delete(endKey)
        }
        const holder = holderOf(this.sceneId, sk)
        if (holder && holder.key !== roomKey(client.sessionId)) {
          client.send('transform_held', { sk, holderName: holder.name })
          return
        }
        const now = Date.now()
        const times = (this.draftTimes.get(client.sessionId) ?? []).filter((t) => now - t < VirviSceneRoom.DRAFT_WINDOW_MS)
        if (times.length >= VirviSceneRoom.DRAFT_LIMIT) {
          this.draftTimes.set(client.sessionId, times)
          return // over the limit: drop silently
        }
        times.push(now)
        this.draftTimes.set(client.sessionId, times)
        // Left during the guard's await: onLeave has already released this client's holds.
        if (!this.clientMeta.has(client.sessionId)) return
        // Free or ours (checked above, no await since); a lapsed headset hold replaced here gets its end relayed, to
        // everyone but the new holder: hearing it, the holder's client would snap its own drag back.
        const { lapsed } = hold(this.sceneId, sk, { key: roomKey(client.sessionId), name: this.holderName(client.sessionId) })
        this.issuedHoldKeys.add(roomKey(client.sessionId))
        if (lapsed) await this.relayToEditors('transform_draft_end', { sk, saved: false }, client)
        await this.relayToEditors(
          'transform_draft',
          {
            element: message.element,
            sk,
            position: message.position,
            rotation: message.rotation,
            scale: message.scale,
            holderName: this.holderName(client.sessionId),
            holderSessionId: client.sessionId,
          },
          client,
        )
      },
      {
        arrive: (client, message) => {
          const n = (this.draftSeq.get(client.sessionId) ?? 0) + 1
          this.draftSeq.set(client.sessionId, n)
          if (typeof message?.sk === 'string') {
            const key = `${message.sk}\n${client.sessionId}`
            this.draftsInFlight.set(key, (this.draftsInFlight.get(key) ?? 0) + 1)
          }
          return n
        },
        done: (client, message) => {
          if (typeof message?.sk !== 'string') return
          const key = `${message.sk}\n${client.sessionId}`
          const left = (this.draftsInFlight.get(key) ?? 1) - 1
          if (left > 0) this.draftsInFlight.set(key, left)
          else this.draftsInFlight.delete(key)
        },
      },
    )

    // The holder can always end its own draft, even if its scope was revoked or the instance was deleted since.
    this.onMessage('transform_end', async (client: Client, message: any) => {
      try {
        const sk = message?.sk
        // Recorded when this client holds sk, or has a draft for sk still in its guard (it may not hold it yet)
        const endKey = `${sk}\n${client.sessionId}`
        const isHolder = typeof sk === 'string' && holderOf(this.sceneId, sk)?.key === roomKey(client.sessionId)
        if (typeof sk === 'string' && (isHolder || this.draftsInFlight.has(endKey))) {
          this.draftEnds.set(endKey, this.draftSeq.get(client.sessionId) ?? 0)
        }
        if (isHolder && release(this.sceneId, sk, roomKey(client.sessionId))) {
          await this.relayToEditors('transform_draft_end', { sk, saved: !!message.saved }, client)
          return
        }
        // Non-holder: ignored, but a client that may not edit this scene still hears why.
        const result = await authorizeSceneMessage(await this.getAccess(client), this.sceneId, 'transform_end', message)
        if (!result.ok) client.send('virvi_error', { code: result.code, messageType: 'transform_end' })
      } catch (err) {
        console.error('[VirviSceneRoom] transform_end failed:', err)
        client.send('virvi_error', { code: 'server_error', messageType: 'transform_end' })
      }
    })

    // ── Preset Switching ──────────────────────────────────────────────────
    this.guarded('scene_change_preset', async (client, message) => {
      console.log(`[VirviSceneRoom] scene_change_preset`, message.presetId || message.id)

      const presetId = message.presetId || message.id
      if (presetId && this.sceneId) {
        try {
          await db
            .update(scenes)
            .set({ activePresetId: presetId, updatedAt: new Date() })
            .where(eq(scenes.id, this.sceneId))
          await publishSceneTouched(this.sceneId)

          // Load the new preset with all elements and instances
          const preset = await db.query.scenePresets.findFirst({
            where: eq(scenePresets.id, presetId),
            with: { elements: { with: { instances: true } } },
          })

          if (preset) {
            const serialized = await withLiveStatus(serializePreset(preset))
            this.broadcast('scene_change_preset', {
              scenePreset: serialized,
              user: this.getClientMeta(client),
            })

            // Push preset change to HTTP callbacks
            dispatchPlatformCallbacks(this.sceneId, {
              action: 'preset_change',
              presetId,
            }).catch(() => {})
          }
        } catch (err) {
          console.error('[VirviSceneRoom] Error changing preset:', err)
        }
      }
    })

    // ── Scene Settings ────────────────────────────────────────────────────
    this.guarded('scene_setting_update', (client, message) => {
      this.broadcast('scene_setting_update', message, { except: client })
    })

    // ── Video Status Updates ──────────────────────────────────────────────
    this.guarded('scene_video_update', (client, message) => {
      this.broadcast('scene_video_status', message, { except: client })

      // Push video status to HTTP callbacks
      if (this.sceneId) {
        dispatchPlatformCallbacks(this.sceneId, {
          action: 'video_status',
          sk: message.sk || message.id,
          isLive: message.isLive ?? message.status,
          url: message.url || message.src,
        }).catch(() => {})
      }
    })

    // ── Sound Locators ────────────────────────────────────────────────────
    this.onMessage('scene_sound_locator', (client, message) => {
      this.broadcast('scene_sound_locator', message, { except: client })
    })

    // ── User Messaging ────────────────────────────────────────────────────
    this.onMessage('user_message', (client, message) => {
      this.broadcast('user_message', { ...message, type: 'inbound' }, { except: client })
    })

    // ── Moderator Actions ─────────────────────────────────────────────────
    this.guarded('scene_moderator_message', (client, message) => {
      this.broadcast('scene_moderator_message', message, { except: client })
    })

    this.guarded('scene_moderator_crash', (client, message) => {
      this.broadcast('scene_moderator_crash', message, { except: client })
    })
  }

  async onJoin(client: Client, options: JoinOptions) {
    const requested = options.clientType || 'analytics'
    let canHost = false
    try {
      const access = await this.getAccess(client)
      canHost = isFullAccess(access) || access.level === 'editor'
    } catch {
      canHost = false
    }
    const clientType = requested === 'host' && canHost ? 'host' : 'analytics'
    const actor = client.auth as Actor
    const userId = actor.userId || client.sessionId
    // Prefer the account's name from the database; the client-supplied name is only for tokens with no user.
    let accountName: string | null = null
    if (actor.userId) {
      try {
        const u = await db.query.users.findFirst({ where: eq(users.id, actor.userId), columns: { displayName: true } })
        accountName = u?.displayName || null
      } catch {
        accountName = null
      }
    }
    const displayName = accountName || options.user?.displayName || 'Guest'

    this.clientMeta.set(client.sessionId, {
      userId,
      displayName,
      clientType,
      sceneId: this.sceneId,
    })

    console.log(`[VirviSceneRoom] ${clientType} joined: ${displayName} (${client.sessionId})`)

    // Notify hosts that someone joined
    if (clientType === 'host') {
      this.broadcast('host_joined', { displayName, connectedWallet: options.user?.connectedWallet })
    }

    // Load the active preset and send init data
    await this.sendInitData(client)

    await this.sendShowings(client)

    // Sent after init so existing clients that wait for init are unaffected
    client.send('auth_status', { authenticated: !!actor.userId && actor.verified })
    await this.sendVenueAccess(client)
  }

  onLeave(client: Client, consented: boolean) {
    const meta = this.clientMeta.get(client.sessionId)
    console.log(`[VirviSceneRoom] ${meta?.clientType || 'unknown'} left: ${meta?.displayName || client.sessionId}`)

    if (meta?.clientType === 'host') {
      this.broadcast('host_left', { displayName: meta.displayName })
    }

    this.draftTimes.delete(client.sessionId)
    this.draftSeq.delete(client.sessionId)
    for (const key of [...this.draftEnds.keys()]) if (key.endsWith(`\n${client.sessionId}`)) this.draftEnds.delete(key)
    for (const key of [...this.draftsInFlight.keys()]) if (key.endsWith(`\n${client.sessionId}`)) this.draftsInFlight.delete(key)
    for (const { sk } of releaseAll(roomKey(client.sessionId))) {
      this.relayToEditors('transform_draft_end', { sk, saved: false }, client).catch(() => {})
    }
    this.issuedHoldKeys.delete(roomKey(client.sessionId))

    this.clientMeta.delete(client.sessionId)
    this.passExpiry.delete(client.sessionId)
    this.linkedPass.delete(client.sessionId)
    this.accessCache.delete(client.sessionId)
    this.lastAccess.delete(client.sessionId)
  }

  onDispose() {
    VirviSceneRoom.activeRoomCount--
    console.log(`[VirviSceneRoom] Disposed (scene: ${this.sceneId}, active rooms: ${VirviSceneRoom.activeRoomCount})`)
    if (this.sceneId) this.presence.unsubscribe(venueTopic(this.sceneId), this.onVenueEventBound)
    if (this.sceneId) this.presence.unsubscribe(STREAMS_TOPIC, this.onStreamEventBound)
    const mine = roomsByScene.get(this.sceneId)
    mine?.delete(this)
    if (mine && !mine.size) roomsByScene.delete(this.sceneId)
    for (const key of this.issuedHoldKeys) releaseAll(key)
    this.issuedHoldKeys.clear()
    this.draftTimes.clear()
    this.clientMeta.clear()
    this.accessCache.clear()
    this.lastAccess.clear()
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  private async getAccess(client: Client): Promise<SceneAccess> {
    const passExp = this.passExpiry.get(client.sessionId)
    if (passExp !== undefined && Date.now() >= passExp) return this.lookupAccess(ANONYMOUS)
    // A revoked pairing or headset (or an ended shared session) ends the session's access within the 10 s live cache.
    const link = this.linkedPass.get(client.sessionId)
    if (link && !(await (link.via === 'ar' ? deviceLive(link.id) : pairingLive(link.id)))) return this.lookupAccess(ANONYMOUS)
    const cached = this.accessCache.get(client.sessionId)
    if (cached && Date.now() - cached.at < VirviSceneRoom.ACCESS_TTL_MS) return cached.access
    const generation = this.accessGeneration
    const access = await this.lookupAccess(client.auth as Actor)
    // A venue event during the lookup may have made this result stale: use it once, don't cache it.
    if (generation === this.accessGeneration) this.accessCache.set(client.sessionId, { access, at: Date.now() })
    return access
  }

  /** Uncached access lookup (a seam for tests). */
  protected lookupAccess(actor: Actor): Promise<SceneAccess> {
    return getSceneAccess(actor, this.sceneId)
  }

  private holderName(sessionId: string): string {
    const name = this.clientMeta.get(sessionId)?.displayName
    return name && name !== 'Guest' ? name : 'Another editor'
  }

  /** A headset's draft (POST /api/ar/drafts), relayed to this scene's editors as a room draft would be. */
  async relayArDraft(msg: { element: string; sk: string; position: unknown; rotation: unknown; scale: unknown; holderName: string }) {
    await this.relayToEditors('transform_draft', { ...msg, holderSessionId: 'headset' })
  }

  /** A headset's draft ended (saved, reverted, lapsed or its session over). */
  async relayArDraftEnd(sk: string, saved: boolean) {
    await this.relayToEditors('transform_draft_end', { sk, saved })
  }

  /** Send to every client (but `except`, when given) whose access includes scene.edit. */
  private async relayToEditors(type: string, msg: unknown, except?: Client) {
    await Promise.all(
      (this.clients as Client[]).map(async (c) => {
        if (except && c.sessionId === except.sessionId) return
        try {
          if (hasScope(await this.getAccess(c), 'scene.edit')) c.send(type, msg)
        } catch {
          /* client gone or access lookup failed: skip */
        }
      }),
    )
  }

  /** Register a handler that runs only if the sender is authorized for this message. */
  /**
   * `hooks.arrive` runs synchronously when the message arrives, before the guard's await, and its value reaches the
   * handler; `hooks.done` runs once the message is finished with (refused, handled or failed).
   */
  private guarded(
    type: string,
    handler: (client: Client, message: any, result: Extract<GuardResult, { ok: true }>, arrival?: unknown) => unknown,
    hooks: { arrive?: (client: Client, message: any) => unknown; done?: (client: Client, message: any) => void } = {},
  ) {
    this.onMessage(type, async (client: Client, message: any) => {
      const arrival = hooks.arrive?.(client, message)
      try {
        const result = await authorizeSceneMessage(await this.getAccess(client), this.sceneId, type, message)
        if (!result.ok) {
          client.send('virvi_error', { code: result.code, messageType: type })
          return
        }
        await handler(client, message, result, arrival)
      } catch (err) {
        console.error(`[VirviSceneRoom] ${type} failed:`, err)
        client.send('virvi_error', { code: 'server_error', messageType: type })
      } finally {
        hooks.done?.(client, message)
      }
    })
  }

  /** Send the client's current venue access; returns the previous booking access if it was just lost. */
  private async sendVenueAccess(client: Client) {
    const msg = toVenueAccessMessage(await this.getAccess(client))
    const prev = this.lastAccess.get(client.sessionId)
    this.lastAccess.set(client.sessionId, msg)
    if (prev?.bookingId && !msg.bookingId) return prev
    client.send('venue_access', msg)
    return null
  }

  private async onVenueEvent(e: VenueEvent) {
    try {
      if (e.type === 'element_changed') {
        await this.broadcastElementChange(e)
        // A screen just switched to Schedule mode needs its showings
        if (!e.deleted && e.elementType === 'video') await this.sendShowings(undefined, [e.elementId])
        return
      }
      if (e.type === 'showings_changed') {
        await this.sendShowings(undefined, [e.elementId])
        return
      }
      if (e.type === 'library_changed') {
        // Editors only: viewers don't use the library and shouldn't see the owner's file names
        if (e.removed) {
          await this.relayToEditors('scene_library_changed', { action: 'remove', id: e.linkId })
          return
        }
        const item = await getSceneLibraryItem(this.sceneId, e.linkId)
        if (item) await this.relayToEditors('scene_library_changed', { action: 'upsert', item })
        return
      }
      if (e.type === 'presets_changed') {
        // Editors only: viewers don't manage presets and shouldn't see unpublished preset names
        const { type: _t, sceneId: _s, ...change } = e
        await this.relayToEditors('scene_presets_changed', change)
        return
      }
      if (e.type === 'preset_changed') {
        const preset = await db.query.scenePresets.findFirst({
          where: eq(scenePresets.id, e.presetId),
          with: { elements: { with: { instances: true } } },
        })
        if (preset) {
          this.broadcast('scene_change_preset', { scenePreset: await withLiveStatus(serializePreset(preset)), user: null })
          await this.sendShowings()
        }
        return
      }
      this.accessGeneration++
      this.accessCache.clear()
      for (const client of this.clients) {
        const lost = await this.sendVenueAccess(client)
        if (lost) {
          const reason = e.type === 'booking_ended' && e.bookingId === lost.bookingId ? e.reason : 'revoked'
          client.send('access_revoked', { bookingId: lost.bookingId, reason })
          client.send('venue_access', this.lastAccess.get(client.sessionId))
        }
      }
    } catch (err) {
      console.error('[VirviSceneRoom] venue event failed:', err)
    }
  }

  /** A REST edit landed: push the element's full current state (or its deletion) if it is live here. */
  private async broadcastElementChange(e: Extract<VenueEvent, { type: 'element_changed' }>) {
    if (e.presetId !== (await this.getActivePresetId())) return
    if (e.deleted) {
      this.broadcast('scene_preset_update', { action: 'delete', element: e.elementType, id: e.elementId })
      return
    }
    const element = await db.query.sceneElements.findFirst({
      where: eq(sceneElements.id, e.elementId),
      with: { instances: true },
    })
    // Gone already (deleted after this event) or moved: the later event carries the truth.
    if (!element || element.presetId !== e.presetId) return
    this.broadcast('scene_preset_update', {
      action: 'upsert',
      element: element.type,
      elementData: element.type === 'video' ? await withLiveVideo(serializeSingleElement(element)) : serializeSingleElement(element),
    })
  }

  /** A Virvi stream went live/offline: tell clients about each active-preset screen that plays it. */
  private async onStreamEvent(e: StreamStatusEvent) {
    try {
      if (e?.type !== 'stream_status') return
      const presetId = await this.getActivePresetId()
      if (!presetId) return
      const url = normalizeUrl(e.playlistUrl)
      const videos = await db
        .select()
        .from(sceneElements)
        .where(and(eq(sceneElements.presetId, presetId), eq(sceneElements.type, 'video')))
      for (const v of videos) {
        if (normalizeUrl(serializeSingleElement(v).liveSrc) !== url) continue
        this.broadcast('scene_video_status', { elementId: v.id, status: e.live ? 'live' : 'offline', url: e.playlistUrl })
      }
    } catch (err) {
      console.error('[VirviSceneRoom] stream event failed:', err)
    }
  }

  private getClientMeta(client: Client): ClientMeta | undefined {
    return this.clientMeta.get(client.sessionId)
  }

  private async sendInitData(client: Client) {
    if (!this.sceneId) {
      // Always send init even if there's no scene — client needs this to unblock
      client.send('scene_preset_update', {
        action: 'init',
        scenePreset: { videos: [], images: [], sounds: [], models: [], widgets: [], nfts: [], claimPoints: [], adSpaces: [] },
        sceneSettings: [],
      })
      return
    }

    try {
      const scene = await db.query.scenes.findFirst({
        where: eq(scenes.id, this.sceneId),
      })

      if (!scene?.activePresetId) {
        console.log(`[VirviSceneRoom] No active preset for scene ${this.sceneId}`)
        // Still send init with empty preset so client doesn't hang
        client.send('scene_preset_update', {
          action: 'init',
          scenePreset: { videos: [], images: [], sounds: [], models: [], widgets: [], nfts: [], claimPoints: [], adSpaces: [] },
          sceneSettings: [],
        })
        return
      }

      const preset = await db.query.scenePresets.findFirst({
        where: eq(scenePresets.id, scene.activePresetId),
        with: {
          elements: {
            with: { instances: true },
          },
        },
      })

      if (!preset) {
        console.log(`[VirviSceneRoom] Active preset not found: ${scene.activePresetId}`)
        client.send('scene_preset_update', {
          action: 'init',
          scenePreset: { videos: [], images: [], sounds: [], models: [], widgets: [], nfts: [], claimPoints: [], adSpaces: [] },
          sceneSettings: [],
        })
        return
      }

      const serialized = await withLiveStatus(serializePreset(preset))

      client.send('scene_preset_update', {
        action: 'init',
        scenePreset: serialized,
        sceneSettings: [], // TODO: load scene settings
      })

      console.log(
        `[VirviSceneRoom] Sent init data: ${serialized.videos.length} videos, ` +
          `${serialized.images.length} images, ${serialized.sounds.length} sounds, ` +
          `${serialized.models.length} models`,
      )
    } catch (err) {
      console.error('[VirviSceneRoom] Error loading init data:', err)
      // Send empty init so client doesn't hang
      client.send('scene_preset_update', {
        action: 'init',
        scenePreset: { videos: [], images: [], sounds: [], models: [], widgets: [], nfts: [], claimPoints: [], adSpaces: [] },
        sceneSettings: [],
      })
    }
  }

  /**
   * Persist a guarded preset update. Existing elements/instances are addressed only by the
   * ids the guard authorized (`target`), never re-derived from the message.
   */
  private async persistPresetUpdate(message: any, target: GuardTarget = {}) {
    const { action, element, instance, elementData, instanceData } = message

    if (action === 'create' && !instance && elementData) {
      // Create a new element
      const activePresetId = await this.getActivePresetId()
      if (!activePresetId) return

      await db.insert(sceneElements).values({
        id: elementData.sk || elementData.id || undefined,
        presetId: activePresetId,
        type: element || 'custom',
        name: elementData.name || element || 'Untitled',
        enabled: elementData.enabled ?? true,
        customId: elementData.customId || null,
        customRendering: elementData.customRendering ?? false,
        clickEvent: elementData.clickEvent || null,
        properties: this.extractProperties(elementData, element || 'custom'),
      })
    } else if (action === 'create' && instance && instanceData) {
      // Create a new instance
      const elementId = target.elementId
      if (!elementId) return
      // Same parent rule as the REST routes (LIV-138); the copy is already broadcast, so a bad parent is dropped, not refused
      const owner = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, elementId), columns: { presetId: true } })
      if (!owner) return
      const parent = await checkParentInstance(owner.presetId, instanceData.parent)

      await db.insert(sceneElementInstances).values({
        id: instanceData.sk || instanceData.id || undefined,
        elementId,
        enabled: instanceData.enabled ?? true,
        customId: instanceData.customId || null,
        customRendering: instanceData.customRendering ?? false,
        position: instanceData.position || null,
        rotation: instanceData.rotation || null,
        scale: instanceData.scale || null,
        clickEvent: instanceData.clickEvent || null,
        parentInstanceId: parent.ok ? parent.parentInstanceId : null,
        withCollisions: instanceData.withCollisions ?? false,
        properties: this.extractProperties(instanceData, null),
      })
    } else if (action === 'update' && !instance) {
      // Update an element
      const elementId = target.elementId
      if (!elementId) return

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (elementData) {
        if (elementData.name !== undefined) updates.name = elementData.name
        if (elementData.enabled !== undefined) updates.enabled = elementData.enabled
        if (elementData.customId !== undefined) updates.customId = elementData.customId
        if (elementData.clickEvent !== undefined) updates.clickEvent = elementData.clickEvent
        if (Object.keys(propertiesOf(elementData)).length > 0) {
          const row = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, elementId) })
          // The stored type decides whether a frame is kept, never the message's
          const extracted = this.extractProperties(elementData, row?.type ?? null)
          if (Object.keys(extracted).length > 0) updates.properties = { ...((row?.properties as Record<string, unknown> | null) ?? {}), ...extracted }
        }
      }

      await db.update(sceneElements).set(updates).where(eq(sceneElements.id, elementId))
    } else if (action === 'update' && instance) {
      // Update an instance
      const instanceId = target.instanceId
      if (!instanceId) return

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (instanceData) {
        if (instanceData.position !== undefined) updates.position = instanceData.position
        if (instanceData.rotation !== undefined) updates.rotation = instanceData.rotation
        if (instanceData.scale !== undefined) updates.scale = instanceData.scale
        if (instanceData.enabled !== undefined) updates.enabled = instanceData.enabled
        if (instanceData.clickEvent !== undefined) updates.clickEvent = instanceData.clickEvent
        if (instanceData.withCollisions !== undefined) updates.withCollisions = instanceData.withCollisions
        const extracted = this.extractProperties(instanceData, null)
        if (Object.keys(extracted).length > 0) {
          const row = await db.query.sceneElementInstances.findFirst({ where: eq(sceneElementInstances.id, instanceId) })
          updates.properties = { ...((row?.properties as Record<string, unknown> | null) ?? {}), ...extracted }
        }
      }

      await db
        .update(sceneElementInstances)
        .set(updates)
        .where(eq(sceneElementInstances.id, instanceId))
    } else if (action === 'delete' && !instance) {
      const elementId = target.elementId
      if (elementId) {
        await db.delete(sceneElements).where(eq(sceneElements.id, elementId))
      }
    } else if (action === 'delete' && instance) {
      const instanceId = target.instanceId
      if (instanceId) {
        await db.delete(sceneElementInstances).where(eq(sceneElementInstances.id, instanceId))
      }
    }
  }

  /**
   * Extract type-specific properties from an element/instance data object.
   * Known structural fields (sk, name, enabled, position, etc.) are removed.
   * Everything else goes into the properties JSONB column.
   */
  private extractProperties(data: Record<string, unknown>, elementType: string | null): Record<string, unknown> {
    const out = propertiesOf(data)
    // A frame (LIV-129) is stored tidied, as the REST routes store it, and only on an image or video screen's element
    // (`elementType` null: an instance, which has none); one no runtime could draw is dropped
    if ('frame' in out) {
      const c = elementType && FRAMEABLE_TYPES.has(elementType) ? checkFrame(out.frame) : null
      if (c?.ok) out.frame = c.value
      else delete out.frame
    }
    return out
  }

  /**
   * Extract a compact payload from a preset update message for HTTP callbacks.
   * Strips instance arrays and structural fields, keeps only rendering config.
   */
  private extractCompactPayload(message: any): Record<string, unknown> {
    const data = message.elementData || {}
    const result: Record<string, unknown> = { action: message.action }
    // Include type-specific rendering properties
    const props = data as Record<string, unknown>
    for (const [key, value] of Object.entries(props)) {
      if (
        value !== undefined &&
        !['sk', 'id', 'pk', 'instances', 'instanceIds', 'services', 'entity'].includes(key)
      ) {
        result[key] = value
      }
    }
    return result
  }

  /**
   * `screen_showings` for the live preset's screens in Schedule mode (LIV-87), to one client or everyone; `only`
   * narrows it to those elements (each still has to be a live scheduled screen). Never throws.
   */
  private async sendShowings(client?: Client, only?: string[]) {
    try {
      const presetId = await this.getActivePresetId()
      if (!presetId) return
      const screens = await db.select({ id: sceneElements.id }).from(sceneElements).where(and(
        eq(sceneElements.presetId, presetId),
        eq(sceneElements.type, 'video'),
        eq(sceneElements.enabled, true),
        sql`(${sceneElements.properties}->>'offType') = ${String(VideoSourceType.SCHEDULED)}`,
      ))
      const ids = screens.map((r) => r.id).filter((id) => !only || only.includes(id))
      for (const msg of await screenShowingsMessages(ids)) {
        if (client) client.send('screen_showings', msg)
        else this.broadcast('screen_showings', msg)
      }
    } catch (err) {
      console.error('[VirviSceneRoom] sending showings failed:', err)
    }
  }

  private async getActivePresetId(): Promise<string | null> {
    if (!this.sceneId) return null
    const scene = await db.query.scenes.findFirst({
      where: eq(scenes.id, this.sceneId),
    })
    return scene?.activePresetId || null
  }
}
