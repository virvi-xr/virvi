import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { Room } = _require('colyseus') as any
type Client = any
import { activeRaffle, publicRaffle } from '../raffles/service.js'
import { availableBeat } from '../beats/visitor.js'
import { availableGiveaway } from '../giveaways/visitor.js'
import { beatLiveTiming, clearBeatLive, markBeatLive } from '../beats/live.js'
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
import { claimsWalletBlocked } from '../auth/wallet-blocks.js'
import { pairingActive, pairingLive } from '../hyperfy/pairing.js'
import { deviceActive, deviceLive } from '../ar/devices.js'
import { ANONYMOUS, type Actor } from '../auth/actor.js'
import { checkedActor } from '../auth/admin.js'
import { runClickRules, withRuleClickElement, withRuleClicks } from '../rules/rules.js'
import { elementChanged } from '../routes/scenes.js'
import { checkState, deleteSceneState, getSceneState, setSceneState, stateWritesFor, STATE_ERROR_MESSAGES } from '../scenes/state.js'
import { getSceneAccess, hasScope, isFullAccess, toVenueAccessMessage, type SceneAccess } from '../auth/permissions.js'
import { authorizeSceneMessage, propertiesOf, type GuardResult, type GuardTarget } from './scene-guard.js'
import { getSceneLibraryItem } from '../library/scene-library.js'
import { venueTopic, publishSceneTouched, STREAMS_TOPIC, type VenueEvent, type StreamStatusEvent } from '../realtime/bus.js'
import { normalizeUrl, withLiveStatus, withLiveVideo } from '../streaming/live-status.js'
import { withKioskElement, withKioskPreset } from '../giveaways/kiosk.js'
import { FRAMEABLE_TYPES, KIOSK_ITEMS_KEY, VideoSourceType, checkFrame, type VenueAccessMessage } from '@virvixr/shared'
import { screenShowingsMessages, SHOWINGS_REFRESH_MS } from '../scenes/showings.js'
import { hold, holderOf, release, releaseAll, sweepExpired } from './draft-holds.js'
import { checkParentInstance } from '../scenes/instance-parent.js'
import { RelayLimiter, relayUserMessage, messageSender } from './relay-limit.js'
import { noteSceneActivity, roomActor, type SceneActivityAction } from '../scenes/activity.js'

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

/**
 * A client's scene_preset_update as the room relays it: `giveawayId` and the kiosk item list are taken out of its
 * element and instance data (flat and nested `properties`), as persistPresetUpdate's extractProperties does when
 * storing it. The client's own message is left as it was.
 */
export function withoutKioskKeys<M>(message: M): M {
  if (!message || typeof message !== 'object') return message
  const strip = (data: unknown): unknown => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data
    const out: Record<string, unknown> = { ...(data as Record<string, unknown>) }
    delete out.giveawayId
    delete out[KIOSK_ITEMS_KEY]
    if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) out.properties = strip(out.properties)
    return out
  }
  const m = { ...(message as Record<string, unknown>) }
  if ('elementData' in m) m.elementData = strip(m.elementData)
  if ('instanceData' in m) m.instanceData = strip(m.instanceData)
  return m as M
}

export class VirviSceneRoom extends Room {
  private static activeRoomCount = 0

  private sceneId: string = ''
  private clientMeta: Map<string, ClientMeta> = new Map()
  /** Open relay messages are rate-limited per client (LIV-156). */
  private relayLimit = new RelayLimiter()
  private messageChains = new Map<string, Promise<void>>()
  /** Signed-in scene-pass connections, by session: they count as live presence for BEAT check-ins (beats/live.ts). */
  private beatLive: Map<string, { userId: string; since: number }> = new Map()
  /** Whether the scene has a BEAT in its card window (paid or live): presence is only written while it does (M-9). */
  private beatOpen = false
  /** The scene has an open giveaway: its check-ins need the same live mark (LIV-194). */
  private giveawayOpen = false
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
    // A blocked wallet's pass or session is refused outright (LIV-11 reissue)
    if (await claimsWalletBlocked(claims)) throw new Error('wallet_blocked')
    // A scene pass acts as its user only in its own scene; anywhere else it's an anonymous visitor.
    // Compare against the room's own scene (set in onCreate from the creating client's options, which
    // runs before the first onAuth) — never a joining client's options.sceneId, which joinById can fake.
    if (claims?.kind === 'scene' && (!claims.sceneId || claims.sceneId !== this.sceneId)) return ANONYMOUS
    if (await VirviSceneRoom.linkedPassRevoked(claims)) return ANONYMOUS
    if (claims?.kind === 'scene') this.passExpiry.set(_client.sessionId, ((claims as { exp?: number }).exp ?? 0) * 1000)
    this.setLink(_client.sessionId, claims)
    return checkedActor(claims) // an admin claim is checked against the database
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
    if (this.sceneId) this.clock.setInterval(() => void this.refreshBeatLive(), beatLiveTiming.refreshMs)

    // ── Scene pass renewal: a fresh pass for the same user and this scene extends the session ──
    this.onMessage('auth_renew', async (client: Client, message: any) => {
      const claims = verifySessionToken(message?.sessionToken)
      const actor = client.auth as Actor
      let blocked: boolean
      let revoked: boolean
      try {
        // A wallet blocked since the join (LIV-11 reissue): the connection ends at this renewal
        blocked = await claimsWalletBlocked(claims)
        revoked = !blocked && await VirviSceneRoom.linkedPassRevoked(claims)
      } catch (err) {
        // M-9: a database error is never a silent lapse: the client is told to try again, and retries with a backoff
        // (core Virvi.ts); the pass it holds keeps working until it expires
        console.error('[VirviSceneRoom] auth_renew check failed:', err instanceof Error ? err.message : err)
        client.send('virvi_error', { code: 'auth_unavailable', messageType: 'auth_renew' })
        return
      }
      if (blocked) {
        client.send('virvi_error', { code: 'wallet_blocked', messageType: 'auth_renew' })
        client.leave(4003)
        return
      }
      const ok =
        !revoked && claims?.kind === 'scene' && claims.sceneId === this.sceneId && !!actor?.userId && claims.id === actor.userId && this.passExpiry.has(client.sessionId)
      if (!ok) {
        client.send('virvi_error', { code: 'auth_renew_refused', messageType: 'auth_renew' })
        return
      }
      this.passExpiry.set(client.sessionId, ((claims as { exp?: number }).exp ?? 0) * 1000)
      this.setLink(client.sessionId, claims)
      this.accessCache.delete(client.sessionId)
      // A renewal after the pass expired makes the visitor live again for BEAT check-ins (fix round N-3)
      // (its own database error doesn't undo the renewal: the next refresh marks it live again)
      if (!this.beatLive.has(client.sessionId)) {
        await this.markBeatLive(client, actor).catch((err: unknown) => console.error('[VirviSceneRoom] BEAT live mark at renewal failed:', err instanceof Error ? err.message : err))
      }
      client.send('auth_renew_ack', {})
    })

    // ── Scene Preset Updates (create/update/delete elements) ──────────────
    this.guarded('scene_preset_update', async (client, message, result) => {
      console.log(`[VirviSceneRoom] scene_preset_update from ${client.sessionId}`, message.action)

      const activity = await this.presetActivity(message, result.target).catch(() => null)
      await this.persistPresetUpdate(message, result.target)
      if (activity && this.sceneId) noteSceneActivity(this.sceneId, roomActor(client.auth as Actor), activity.action, activity.subject)
      if (result.broadcast && this.sceneId) await publishSceneTouched(this.sceneId)
      client.send('scene_preset_update_ack', { action: message.action, id: message.elementData?.sk || message.id, sk: message.instanceData?.sk })

      // Edits to a non-active preset (e.g. a booking clone during setup) are not broadcast
      if (!result.broadcast) return

      // Broadcast to all OTHER clients in the room, without what the room never stores (a kiosk's giveaway and items)
      const relayed = withoutKioskKeys(message)
      this.broadcast('scene_preset_update', relayed, { except: client })

      // Push to HTTP callbacks (Second Life, etc.)
      if (this.sceneId) {
        dispatchPlatformCallbacks(this.sceneId, {
          action: 'config_update',
          elementId: result.target?.elementId || message.elementData?.sk || message.elementData?.id || message.id,
          element: message.element,
          ...this.extractCompactPayload(relayed),
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
          noteSceneActivity(this.sceneId, roomActor(client.auth as Actor), 'preset.activated', { type: 'preset', id: presetId, name: preset?.name ?? null })

          if (preset) {
            const serialized = await withRuleClicks(await withKioskPreset(await withLiveStatus(serializePreset(preset))))
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
      if (!this.relayLimit.take(client.sessionId, 'scene_sound_locator')) return
      this.broadcast('scene_sound_locator', message, { except: client })
    })

    // ── User Messaging ────────────────────────────────────────────────────
    // Open to everyone in the room by design (Multiplayer Events); limited per client, and only its id and data go on
    // LIV-158: the server stamps who sent it (`from`), so scene code can't be fooled by a claimed sender. A client's
    // messages stay in order while its access is looked up.
    this.onMessage('user_message', (client, message) => {
      const relay = relayUserMessage(message)
      if (!relay || !this.relayLimit.take(client.sessionId, 'user_message')) return
      const prev = this.messageChains.get(client.sessionId) ?? Promise.resolve()
      const next = prev.then(async () => {
        const actor = (client.auth ?? null) as Actor | null
        let staff = false
        try { staff = hasScope(await this.getAccess(client), 'scene.edit') } catch { /* not staff */ }
        this.broadcast('user_message', { ...relay, from: messageSender(client.sessionId, actor, staff) }, { except: client })
      }).catch(() => {})
      this.messageChains.set(client.sessionId, next)
      void next.then(() => { if (this.messageChains.get(client.sessionId) === next) this.messageChains.delete(client.sessionId) })
    })

    // ── Scene state (LIV-158) ─────────────────────────────────────────────
    // Editors write; with the scene's state_writes 'everyone', any visitor's scene code may too. Limited per client.
    // The change reaches every copy of the scene through the venue bus (scene_state); the sender also gets an ack.
    for (const type of ['scene_state_set', 'scene_state_delete'] as const) {
      this.onMessage(type, async (client, message) => {
        const ref = typeof message?.ref === 'string' ? message.ref.slice(0, 64) : null
        const ack = (error?: string, text?: string) => client.send('scene_state_ack', { ref, ok: !error, ...(error ? { error, message: text } : {}) })
        try {
          if (!this.sceneId) return ack('no_scene', 'This room has no scene')
          if (!this.relayLimit.take(client.sessionId, 'scene_state')) return ack('rate_limited', 'Too many state changes; slow down')
          const bad = checkState(message?.key, message?.value, type === 'scene_state_set')
          if (bad) return ack(bad, STATE_ERROR_MESSAGES[bad])
          if ((await stateWritesFor(this.sceneId)) !== 'everyone' && !hasScope(await this.getAccess(client), 'scene.edit')) {
            return ack('forbidden', "Only the scene's editors can change its state")
          }
          if (type === 'scene_state_delete') {
            await deleteSceneState(this.sceneId, message.key)
            return ack()
          }
          const r = await setSceneState(this.sceneId, message.key, message.value)
          return r.ok ? ack() : ack(r.error, STATE_ERROR_MESSAGES[r.error])
        } catch (err) {
          console.error(`[VirviSceneRoom] ${type} failed:`, err)
          ack('server_error', 'Could not save the state')
        }
      })
    }

    // ── Click rules (LIV-196) ─────────────────────────────────────────────
    // Anyone in the scene may click a placed item; the item's click rules run on the server, shared with everyone.
    // Limited per client; only items of the live preset count.
    this.onMessage('rule_click', async (client, message) => {
      const elementId = typeof message?.elementId === 'string' ? message.elementId : null
      if (!elementId || !this.sceneId || !this.relayLimit.take(client.sessionId, 'rule_click')) return
      try {
        const presetId = await this.getActivePresetId()
        if (!presetId) return
        const el = await db.query.sceneElements.findFirst({ where: and(eq(sceneElements.id, elementId), eq(sceneElements.presetId, presetId)), columns: { id: true } })
        if (!el) return
        const actor = roomActor(client.auth as Actor)
        await runClickRules({
          sceneId: this.sceneId, presetId, elementId, actor,
          elementChanged: async (e, name, rule) => {
            await elementChanged(e)
            noteSceneActivity(e.sceneId, actor, 'element.updated', { type: e.elementType, id: e.elementId, name }, { changed: ['enabled'], rule })
          },
        })
      } catch (err) {
        console.error('[VirviSceneRoom] rule_click failed:', err)
      }
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
      canHost = isFullAccess(access) || access.level === 'editor' || access.level === 'tenant'
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
    await this.sendSceneState(client)

    await this.sendShowings(client)

    // Sent after init so existing clients that wait for init are unaffected
    client.send('auth_status', { authenticated: !!actor.userId && actor.verified })
    await this.sendVenueAccess(client)
    await this.sendCurrentRaffle(client)
    await this.sendBeatAvailable(client)
    await this.sendGiveawayAvailable(client)
    await this.markBeatLive(client, actor)
  }

  /** Live presence backs BEAT and giveaway check-ins alike: tracked while either is switched on. */
  private liveTracked() {
    return config.beats.enabled || config.giveaways.enabled
  }

  /** A signed-in visitor on a scene pass for this scene counts as live in the scene for BEAT and giveaway check-ins from now on. */
  private async markBeatLive(client: Client, actor: Actor) {
    if (!this.sceneId || !this.liveTracked() || !actor?.userId || !this.passExpiry.has(client.sessionId)) return
    if (!this.clientMeta.has(client.sessionId)) return // left while joining
    const entry = { userId: actor.userId, since: Date.now() }
    this.beatLive.set(client.sessionId, entry)
    // Tracked, but only written once the scene has a BEAT or a giveaway open (the refresh looks again)
    if (!this.beatOpen && !this.giveawayOpen) return
    try {
      await markBeatLive(this.sceneId, entry.userId, entry.since)
    } catch (err) {
      console.error('[VirviSceneRoom] BEAT live mark failed:', err)
    }
  }

  /**
   * Keeps each live user's mark from expiring, with the time their oldest open connection here opened. Only while the
   * scene has a BEAT or a giveaway open (M-9), and never for a connection whose scene pass expired without a renewal: it
   * stops counting.
   */
  private async refreshBeatLive() {
    if (!this.liveTracked() || !this.beatLive.size) return
    const now = Date.now()
    for (const sessionId of [...this.beatLive.keys()]) {
      const exp = this.passExpiry.get(sessionId)
      if (!exp || exp <= now) this.dropBeatLive(sessionId)
    }
    try {
      this.beatOpen = config.beats.enabled && (await availableBeat(this.sceneId)) !== null
      this.giveawayOpen = config.giveaways.enabled && (await availableGiveaway(this.sceneId)) !== null
    } catch {
      return
    }
    if (!this.beatOpen && !this.giveawayOpen) return
    const oldest = new Map<string, number>()
    for (const { userId, since } of this.beatLive.values()) oldest.set(userId, Math.min(since, oldest.get(userId) ?? since))
    for (const [userId, since] of oldest) {
      try {
        await markBeatLive(this.sceneId, userId, since)
      } catch (err) {
        console.error('[VirviSceneRoom] BEAT live refresh failed:', err)
      }
    }
  }

  /** The session closed: its user stops being live here once none of their connections in this room is left. */
  private dropBeatLive(sessionId: string) {
    const entry = this.beatLive.get(sessionId)
    if (!entry) return
    this.beatLive.delete(sessionId)
    const others = [...this.beatLive.values()].filter((e) => e.userId === entry.userId)
    if (others.length) {
      void markBeatLive(this.sceneId, entry.userId, Math.min(...others.map((e) => e.since))).catch(() => {})
      return
    }
    void clearBeatLive(this.sceneId, entry.userId).catch((err) => console.error('[VirviSceneRoom] BEAT live clear failed:', err))
  }

  /** Guests can't use REST: tell them on join whether the scene has a BEAT (name and test flag only) to connect a wallet for. */
  private async sendBeatAvailable(client: Client) {
    if (!this.sceneId || !config.beats.enabled) return
    try {
      const beat = await availableBeat(this.sceneId)
      this.beatOpen = beat !== null
      client.send('beat_available', { beat })
    } catch (err) {
      console.error('[VirviSceneRoom] beat availability failed:', err)
    }
  }

  /** Guests can't use REST: tell them on join whether the scene has an open giveaway (name and test flag only). */
  private async sendGiveawayAvailable(client: Client) {
    if (!this.sceneId || !config.giveaways.enabled) return
    try {
      const giveaway = await availableGiveaway(this.sceneId)
      this.giveawayOpen = giveaway !== null
      client.send('giveaway_available', { giveaway })
    } catch (err) {
      console.error('[VirviSceneRoom] giveaway availability failed:', err)
    }
  }

  /** Guests and late joiners can't use REST for this: hand them the scene's running raffle (or null) on join. */
  private async sendCurrentRaffle(client: Client) {
    if (!this.sceneId) return
    try {
      const row = await activeRaffle(this.sceneId)
      client.send('raffle_changed', { raffle: row ? publicRaffle(row) : null })
    } catch (err) {
      console.error('[VirviSceneRoom] current raffle failed:', err)
    }
  }

  onLeave(client: Client, consented: boolean) {
    this.relayLimit.forget(client.sessionId)
    this.messageChains.delete(client.sessionId)
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

    this.dropBeatLive(client.sessionId)
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
      if (e.type === 'scene_deleted') {
        // Everyone connected sees the scene empty, then the room closes; a client that joins again gets nothing
        this.broadcast('scene_preset_update', {
          action: 'init',
          scenePreset: { videos: [], images: [], sounds: [], models: [], widgets: [], nfts: [], claimPoints: [], adSpaces: [] },
          sceneSettings: [],
        })
        await this.disconnect()
        return
      }
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
          this.broadcast('scene_change_preset', { scenePreset: await withRuleClicks(await withKioskPreset(await withLiveStatus(serializePreset(preset)))), user: null })
          await this.sendShowings()
        }
        return
      }
      if (e.type === 'state_changed') {
        this.broadcast('scene_state', { key: e.key, value: e.deleted ? null : e.value, deleted: e.deleted })
        return
      }
      if (e.type === 'raffle_changed') {
        this.broadcast('raffle_changed', { raffle: e.raffle })
        return
      }
      if (e.type === 'raffle_draw') {
        this.broadcast('raffle_draw', e.draw)
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
      elementData: await withRuleClickElement(e.presetId, element.type, element.type === 'video' ? await withLiveVideo(serializeSingleElement(element)) : await withKioskElement(element.type, serializeSingleElement(element))),
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

  /** The scene's state (LIV-158), right after the preset. */
  private async sendSceneState(client: Client) {
    if (!this.sceneId) return
    try {
      client.send('scene_state_init', { state: await getSceneState(this.sceneId) })
    } catch (err) {
      console.error('[VirviSceneRoom] scene state failed:', err)
    }
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

      // A deleted scene (LIV-83) sends nothing: a deployment left up shows an empty scene
      if (!scene?.activePresetId || scene.deletedAt) {
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

      const serialized = await withRuleClicks(await withKioskPreset(await withLiveStatus(serializePreset(preset))))

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

  /** What a preset update will do, for the scene's activity log (LIV-32): read before the write, so a delete still has its name. */
  private async presetActivity(message: any, target: GuardTarget = {}): Promise<{ action: SceneActivityAction; subject: { type: string | null; id: string | null; name: string | null } } | null> {
    const { action, instance, elementData } = message
    const of = (el: { id: string; type: string; name: string } | undefined) => (el ? { type: el.type, id: el.id, name: el.name } : null)
    if (action === 'create' && !instance && elementData) {
      const id = elementData.sk || elementData.id
      return { action: 'element.created', subject: { type: message.element || 'custom', id: typeof id === 'string' ? id : null, name: elementData.name || message.element || 'Untitled' } }
    }
    if (!instance && target.elementId && (action === 'update' || action === 'delete')) {
      const subject = of(await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, target.elementId), columns: { id: true, type: true, name: true } }))
      return subject && { action: action === 'update' ? 'element.updated' : 'element.deleted', subject }
    }
    if (instance && action === 'create' && target.elementId) {
      const subject = of(await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, target.elementId), columns: { id: true, type: true, name: true } }))
      return subject && { action: 'instance.added', subject }
    }
    if (instance && target.instanceId && (action === 'update' || action === 'delete')) {
      const row = await db.query.sceneElementInstances.findFirst({ where: eq(sceneElementInstances.id, target.instanceId), columns: { id: true }, with: { element: { columns: { id: true, type: true, name: true } } } })
      const subject = of(row?.element)
      return subject && { action: action === 'update' ? 'instance.updated' : 'instance.removed', subject }
    }
    return null
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
    // A giveaway kiosk's giveaway is picked in the dashboard only, where the server checks the caller manages it; the
    // item list is the server's own (see giveaways/kiosk.ts). No element type takes either through the room.
    delete out.giveawayId
    delete out[KIOSK_ITEMS_KEY]
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
    return (!scene?.deletedAt && scene?.activePresetId) || null
  }
}
