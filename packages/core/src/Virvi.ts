import type { PublicDraw, PublicRaffle, SceneLibraryChangeData, TransformData, TransformDraftData, VirviPlatformAdapter, VirviInitConfig, VirviStorage as VirviStorageType, HUDRenderer, BudgetLimits, Scene } from '@virvixr/shared'
import { HUD_PROTOCOL_HEADER, HUD_VERSION_HEADER, RAFFLE_CONSENT_VERSION } from '@virvixr/shared'
import { VirviHttpClient, ColyseusManager, type RafflePatch } from '@virvixr/client'
import { SceneManager } from './SceneManager.js'
import { VirviStorageImpl } from './storage.js'
import type { Selected } from './transform/session.js'
import { EventBus } from './events/EventBus.js'
import { AdHost } from './ads/host.js'

// Default API URLs by environment
const API_URLS: Record<string, string> = {
  dev: 'http://localhost:3010',
  staging: 'https://api.staging.virvi.io',
  prod: 'https://api.virvi.io',
}
export function resolveApiUrl(config: Partial<VirviInitConfig> = {}): string {
  const env = config.env || 'prod'
  return config.apiUrl || API_URLS[env] || API_URLS.prod
}

const WSS_URLS: Record<string, string> = {
  dev: 'ws://localhost:3010',
  staging: 'wss://api.staging.virvi.io',
  prod: 'wss://api.virvi.io',
}

export type VirviConnectionState =
  | 'idle'
  | 'authenticating'
  | 'authenticated'
  | 'discovering_scene'
  | 'scene_ready'
  | 'connecting'
  | 'connected'
  | 'error'

export interface VirviStateListener {
  (state: VirviConnectionState, detail?: Record<string, unknown>): void
}

export class Virvi {
  private adapter: VirviPlatformAdapter
  private http: VirviHttpClient
  private colyseus: ColyseusManager
  private sceneManager: SceneManager
  /** Serves and measures the scene's ads; started once the scene has loaded. */
  private ads: AdHost
  /** Core event emitter (also carries transform_draft / transform_draft_end / transform_held). */
  public readonly events: EventBus
  private userMessageHandlers: Map<string, (data: unknown) => void> = new Map()
  private stateListeners: Set<VirviStateListener> = new Set()
  private handlersRegistered = false
  private _connectionState: VirviConnectionState = 'idle'
  private _sceneId: string | null = null
  private _user: { id: string; displayName?: string; email?: string; role: string } | null = null
  private _scenes: Scene[] = []
  private wssUrl: string = ''
  /** Saves waiting for the server's scene_preset_update_ack, by instance sk. */
  private pendingSaves = new Map<string, { resolve: () => void; reject: (err: Error) => void; deadline: number }>()
  /** Frame system timing pending saves out (platforms have no timers here); null when none are pending. */
  private saveTimeoutSystem: ((dt: number) => void) | null = null
  private static SAVE_TIMEOUT_MS = 5000
  public storage: VirviStorageType
  public hud: any | null = null // HUDManager — typed as any to avoid hard dep on @virvixr/hud

  constructor(adapter: VirviPlatformAdapter) {
    this.adapter = adapter
    this.http = new VirviHttpClient('')
    this.colyseus = new ColyseusManager()
    this.events = new EventBus()
    this.storage = VirviStorageImpl.create()
    // Reads this.http at call time: authenticate() replaces the client
    this.ads = new AdHost({
      adapter,
      getAds: (elementIds) => this.http.getAds(adapter, { elementIds }),
      postEvents: (batch) => this.http.sendAdEvents(adapter, batch),
    })
    this.sceneManager = new SceneManager(adapter, this.storage, this.events, this.ads)
  }

  private _binding: { sceneId: string | null; locationId: string | null } | null = null
  private analytics: import('./analytics/collector.js').Collector | null = null

  get connectionState(): VirviConnectionState { return this._connectionState }
  get sceneId(): string | null { return this._sceneId }
  get user(): typeof this._user { return this._user }
  get scenes(): Scene[] { return this._scenes }
  get httpClient(): VirviHttpClient { return this.http }
  /** The scene the server bound this sign-in to (in-world scene pass), or null when unbound / not signed in. */
  get binding(): { sceneId: string | null; locationId: string | null } | null { return this._binding }

  onStateChange(listener: VirviStateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private setState(state: VirviConnectionState, detail?: Record<string, unknown>): void {
    this._connectionState = state
    for (const listener of this.stateListeners) {
      try { listener(state, detail) } catch { /* swallow */ }
    }
  }

  /**
   * Full initialization — authenticate, discover/create scene, connect Colyseus.
   * If sceneId is provided, connects directly. If not, discovers or creates one.
   */
  async init(config: VirviInitConfig): Promise<VirviStorageType> {
    // Phase 1: Authenticate (also sets up http client and wssUrl)
    await this.authenticate(config)

    // Phase 2: Discover or use provided sceneId
    if (config.sceneId) {
      this._sceneId = config.sceneId
      this.setState('scene_ready', { sceneId: config.sceneId })
    } else {
      await this.discoverOrCreateScene()
    }

    if (!this._sceneId) {
      throw new Error('No scene available — could not discover or create one')
    }

    // Phase 3: Connect to Colyseus and load scene
    return this.connectToScene(this._sceneId)
  }

  /** Renew the 15 min scene pass a little before it expires, while this sign-in is current; retry soon after a failure. */
  private static RENEW_MS = 10 * 60_000
  private static RENEW_RETRY_MS = 30_000
  /** Frame system checking the clock (platforms have no timers here); null when nothing is scheduled. */
  private renewSystem: ((dt: number) => void) | null = null

  private async signInWithPlatform(http: VirviHttpClient, config: VirviInitConfig, renew = false): Promise<void> {
    const [platformUser, sceneInfo, environment] = await Promise.all([
      this.adapter.getPlatformUser(),
      this.adapter.getSceneInfo(),
      this.adapter.getEnvironment(),
    ])

    const authProof = await this.adapter.getAuthProof()
    const authResponse = await http.authenticateWithPlatform(authProof, {
      sceneId: config.sceneId || sceneInfo.sceneId || undefined,
      user: platformUser as unknown as Record<string, unknown>,
      world: this.adapter.capabilities.platformName,
      location: sceneInfo as unknown as Record<string, unknown>,
      environment: environment as unknown as Record<string, unknown>,
    }, this.adapter, renew ? { signedOnly: true, keepSceneId: this._binding?.sceneId ?? undefined } : {})

    // A sign-in on a replaced client (authenticate() ran again) must not overwrite the newer one.
    if (http !== this.http) return
    this._user = authResponse.user as any
    this._binding = authResponse.scene ?? null
    if (!renew) return
    // The room checks the pass's expiry too: hand it the new one.
    try {
      if (this.colyseus.getRoom()) this.colyseus.send('auth_renew', { sessionToken: http.auth.token })
    } catch {}
  }

  /** Re-sign the pass: signed request only, and only a pass for the same scene replaces it (see the HTTP client's keepSceneId). */
  private renewPass(http: VirviHttpClient, config: VirviInitConfig): Promise<void> {
    return this.signInWithPlatform(http, config, true)
  }

  private scheduleRenewal(http: VirviHttpClient, config: VirviInitConfig): void {
    this.stopRenewal()
    let due = Date.now() + Virvi.RENEW_MS
    let busy = false
    const system = (_dt: number) => {
      if (busy || Date.now() < due) return
      if (http !== this.http || !this.binding?.sceneId) return this.stopRenewal()
      busy = true
      // Shared with the 401 retry. A failure keeps the current pass and tries again shortly.
      void http.renewSession().then(
        () => { due = Date.now() + Virvi.RENEW_MS },
        () => { due = Date.now() + Virvi.RENEW_RETRY_MS },
      ).finally(() => { busy = false })
    }
    this.renewSystem = system
    this.adapter.registerSystem(system)
  }

  private stopRenewal(): void {
    if (this.renewSystem) this.adapter.unregisterSystem(this.renewSystem)
    this.renewSystem = null
  }

  /**
   * Phase 1: Authenticate with the Virvi server using platform credentials.
   * Can be called standalone before scene discovery.
   */
  async authenticate(config: VirviInitConfig): Promise<void> {
    const env = config.env || 'prod'
    const apiUrl = resolveApiUrl(config)
    this.wssUrl = config.wssUrl || WSS_URLS[env] || WSS_URLS.prod
    this.http = new VirviHttpClient(apiUrl)
    if (this.adapter.hudProtocol !== undefined) this.http.defaultHeaders[HUD_PROTOCOL_HEADER] = String(this.adapter.hudProtocol)
    if (this.adapter.hudVersion !== undefined) this.http.defaultHeaders[HUD_VERSION_HEADER] = this.adapter.hudVersion
    // A previous sign-in's binding must never outlive a new attempt (failed or not).
    this._binding = null

    this.setState('authenticating')

    try {
      const http = this.http
      await this.signInWithPlatform(http, config)
      // The pass lasts 15 min with no refresh token: renew it every 10 min, and on a 401 sign a fresh request.
      http.reauthenticate = () => this.renewPass(http, config)
      if (this.binding?.sceneId) this.scheduleRenewal(http, config)
      this.setState('authenticated', { user: this._user as any })
    } catch (err) {
      this.setState('error', { error: String(err) })
      throw err
    }
  }

  /**
   * Phase 2: Discover existing scenes or auto-create one.
   * Must be called after authenticate().
   */
  async discoverOrCreateScene(): Promise<string> {
    this.setState('discovering_scene')

    try {
      const { scenes } = await this.http.getScenes()
      this._scenes = scenes

      if (scenes.length > 0) {
        // Use the most recently updated scene
        this._sceneId = scenes[0].id
        this.setState('scene_ready', { sceneId: this._sceneId, scenes, isNew: false })
        return this._sceneId
      }

      // No scenes — auto-create one
      const displayName = this._user?.displayName || 'My Scene'
      const { scene } = await this.http.createScene(`${displayName}'s Scene`)
      this._sceneId = scene.id
      this._scenes = [scene]
      this.setState('scene_ready', { sceneId: this._sceneId, scenes: [scene], isNew: true })
      return this._sceneId
    } catch (err) {
      this.setState('error', { error: String(err) })
      throw err
    }
  }

  /**
   * Phase 3: Connect to a specific scene via Colyseus.
   * Must be called after authenticate().
   */
  async connectToScene(sceneId: string): Promise<VirviStorageType> {
    this._sceneId = sceneId
    this.setState('connecting', { sceneId })

    try {
      this.colyseus.connect(this.wssUrl)
      // Register message handlers BEFORE joining
      this.registerMessageHandlers()
    } catch (err) {
      // Without this the HUD would sit on "connecting" forever
      this.setState('error', { error: String(err) })
      throw err
    }

    return new Promise<VirviStorageType>(async (resolve, reject) => {
      try {
        this.events.on('scene_initialized', () => {
          void this.ads.start()
          this.setState('connected', { sceneId })
          resolve(this.storage)
        })

        const platformUser = await this.adapter.getPlatformUser()

        const joinToken = this.http.auth.token
        await this.colyseus.joinSceneRoom(sceneId, {
          sessionToken: joinToken,
          clientType: 'analytics',
          user: {
            id: this._user?.id || '',
            displayName: this._user?.displayName || platformUser.displayName,
            connectedWallet: platformUser.walletAddress,
          },
        })
        // A renewal that finished mid-join couldn't reach the room yet: hand it the newer pass now.
        if (this.http.auth.token && this.http.auth.token !== joinToken) {
          try { this.colyseus.send('auth_renew', { sessionToken: this.http.auth.token }) } catch {}
        }
      } catch (err) {
        this.setState('error', { error: String(err) })
        reject(err)
      }
    })
  }

  /**
   * Select a scene from the user's existing scenes and connect to it.
   */
  async selectScene(sceneId: string): Promise<VirviStorageType> {
    return this.connectToScene(sceneId)
  }

  /**
   * Create a new scene and connect to it.
   */
  async createScene(name: string, description?: string): Promise<VirviStorageType> {
    const { scene } = await this.http.createScene(name, description)
    this._sceneId = scene.id
    this._scenes = [scene, ...this._scenes]
    this.setState('scene_ready', { sceneId: scene.id, isNew: true })
    return this.connectToScene(scene.id)
  }

  private registerMessageHandlers(): void {
    if (this.handlersRegistered) return
    this.handlersRegistered = true

    this.colyseus.onMessage('scene_preset_update', (message: unknown) => {
      this.sceneManager.handlePresetUpdate(message as any)
      if ((message as any).action === 'init') {
        this.events.emit('scene_initialized')
      }
    })

    this.colyseus.onMessage('transform_draft', (message: unknown) => {
      const d = message as TransformDraftData & { holderName: string; holderSessionId: string }
      if (!d?.sk) return
      // The server never echoes to the sender; ignore defensively if it ever does.
      if (d.holderSessionId && d.holderSessionId === this.colyseus.getRoom()?.sessionId) return
      this.sceneManager.previewTransform(d.element, d.sk, { position: d.position, rotation: d.rotation, scale: d.scale })
      this.events.emit('transform_draft', d)
    })

    this.colyseus.onMessage('transform_draft_end', (message: unknown) => {
      const d = message as { sk: string; saved: boolean }
      if (!d?.sk) return
      if (!d.saved) {
        for (const e of ['image', 'video', 'model', 'sound', 'ad_space'] as const) this.sceneManager.restoreTransform(e, d.sk)
      }
      this.events.emit('transform_draft_end', d)
    })

    this.colyseus.onMessage('scene_library_changed', (message: unknown) => {
      this.events.emit('library_changed', message)
    })

    this.colyseus.onMessage('transform_held', (message: unknown) => {
      this.events.emit('transform_held', message)
    })

    this.colyseus.onMessage('scene_preset_update_ack', (message: unknown) => {
      const sk = (message as { sk?: string } | null)?.sk
      if (sk) this.pendingSaves.get(sk)?.resolve()
    })

    this.colyseus.onMessage('virvi_error', (message: unknown) => {
      const e = message as { code?: string; messageType?: string } | null
      // Errors carry no sk: a refused scene_preset_update fails every save still waiting
      if (e?.messageType === 'scene_preset_update') this.failSaves(e.code || 'server_error')
      this.events.emit('virvi_error', message)
    })

    this.colyseus.onLeave((code: number) => {
      this.failSaves('not_connected')
      this.events.emit('connection_lost', { code })
    })

    this.colyseus.onMessage('scene_change_preset', (message: unknown) => {
      this.sceneManager.handlePresetChange(message as any)
      void this.ads.refresh()
      const presetId = (message as any)?.scenePreset?.sk
      if (presetId) this.events.emit('active_preset_changed', presetId)
    })

    // Editors only: a preset was created, renamed or deleted (LIV-84)
    this.colyseus.onMessage('scene_presets_changed', (message: unknown) => {
      this.events.emit('presets_changed', message)
    })

    this.colyseus.onMessage('screen_showings', (message: unknown) => {
      this.sceneManager.handleScreenShowings(message as any)
    })

    // Raffles (LIV-55): also sent once on join, so guests and late joiners see the running raffle
    this.colyseus.onMessage('raffle_changed', (message: unknown) => {
      this.events.emit('raffle_changed', (message as { raffle?: PublicRaffle | null } | null)?.raffle ?? null)
    })

    this.colyseus.onMessage('raffle_draw', (message: unknown) => {
      if ((message as PublicDraw | null)?.drawId) this.events.emit('raffle_draw', message)
    })

    this.colyseus.onMessage('scene_video_status', (message: unknown) => {
      this.sceneManager.handleVideoStatus(message as any)
    })

    this.colyseus.onMessage('user_message', (message: unknown) => {
      const msg = message as any
      if (msg?.messageId && this.userMessageHandlers.has(msg.messageId)) {
        this.userMessageHandlers.get(msg.messageId)!(msg.data)
      }
    })
  }

  // Public API
  async destroy(): Promise<void> {
    if (this.hud) {
      this.hud.destroy()
      this.hud = null
    }
    // The collector is shared per scene runtime (other Virvi instances may use it): detach only.
    // Stop it explicitly with the adapter's stopVirviAnalytics().
    this.analytics = null
    this.ads.stop()
    this.stopRenewal()
    this.http.reauthenticate = null
    this.colyseus.leaveRoom()
    this.setState('idle')
  }

  /**
   * Initialize the in-world management HUD.
   * Can be called at any time — the HUD will reflect the current connection state.
   */
  async initHUD(renderer: HUDRenderer, budgetLimits?: BudgetLimits): Promise<void> {
    if (!this.adapter.capabilities.screenSpaceUI && !this.adapter.capabilities.spatialUI) {
      return
    }

    try {
      const { HUDManager } = await import('@virvixr/hud')
      const limits: BudgetLimits = budgetLimits || {
        maxFileSizeBytes: 50 * 1024 * 1024,
        maxTriangleCount: 100_000,
        maxTextureCount: 128,
        maxMaterialCount: 128,
        maxEntityCount: 500,
        platformName: this.adapter.capabilities.platformName,
      }

      this.hud = new HUDManager({
        renderer,
        http: this.http,
        colyseus: this.colyseus,
        storage: this.storage,
        budgetLimits: limits,
      })
      this.hud.init()
    } catch {
      // @virvixr/hud not installed — that's fine, it's optional
    }
  }

  /** In-world transform editing: scene helpers plus draft/save messaging. */
  get editing() {
    const scene = this.sceneManager
    return {
      scene: {
        findByEntity: (entity: Parameters<SceneManager['findByEntity']>[0]) => scene.findByEntity(entity),
        listEditable: () => scene.listEditable(),
        previewTransform: (element: Selected['element'], sk: string, t: TransformData) => scene.previewTransform(element, sk, t),
        restoreTransform: (element: Selected['element'], sk: string) => scene.restoreTransform(element, sk),
      },
      /** Dropped silently when not connected (drafts are previews; the next one or Save catches up). */
      sendDraft: (d: TransformDraftData): void => {
        if (this.colyseus.isConnected()) this.colyseus.send('transform_draft', d)
      },
      endDraft: (sk: string, saved: boolean): void => this.colyseus.send('transform_end', { sk, saved }),
      /**
       * Saves the instance's transform to the live preset. Resolves (and applies locally) only once the server acks
       * this instance; rejects with `not_connected`, the server's error code, or `save_timeout` after 5 s.
       */
      save: (element: Selected['element'], sk: string, t: TransformData): Promise<void> => {
        if (!this.colyseus.isConnected()) return Promise.reject(new Error('not_connected'))
        const instanceData = { sk, position: t.position, rotation: t.rotation, scale: t.scale }
        const update = { action: 'update', element, instance: true, instanceData }
        return new Promise<void>((resolve, reject) => {
          this.pendingSaves.get(sk)?.reject(new Error('save_superseded'))
          const entry = {
            resolve: () => {
              this.settleSave(sk, entry)
              scene.handlePresetUpdate(update)
              resolve()
            },
            reject: (err: Error) => {
              this.settleSave(sk, entry)
              reject(err)
            },
            deadline: Date.now() + Virvi.SAVE_TIMEOUT_MS,
          }
          this.pendingSaves.set(sk, entry)
          this.watchSaveTimeouts()
          try {
            this.colyseus.send('scene_preset_update', update)
          } catch {
            entry.reject(new Error('not_connected'))
          }
        })
      },
    }
  }

  private settleSave(sk: string, entry: unknown): void {
    if (this.pendingSaves.get(sk) === entry) this.pendingSaves.delete(sk)
    if (this.pendingSaves.size === 0 && this.saveTimeoutSystem) {
      this.adapter.unregisterSystem(this.saveTimeoutSystem)
      this.saveTimeoutSystem = null
    }
  }

  private failSaves(code: string): void {
    for (const entry of [...this.pendingSaves.values()]) entry.reject(new Error(code))
  }

  private watchSaveTimeouts(): void {
    if (this.saveTimeoutSystem) return
    const system = (_dt: number) => {
      const now = Date.now()
      for (const entry of [...this.pendingSaves.values()]) {
        if (now >= entry.deadline) entry.reject(new Error('save_timeout'))
      }
    }
    this.saveTimeoutSystem = system
    this.adapter.registerSystem(system)
  }

  /** Model elements whose files this platform can't load (see adapter.resolveModelSrc). */
  missingModels(): number {
    return this.storage.models.missing.size
  }

  /** The modelSrc of each placed model this platform can't load yet (needs `virvi-dcl sync` + redeploy). */
  missingModelSrcs(): string[] {
    return this.sceneManager.missingModelSrcs()
  }

  /** Called with each scene library change (editors only); returns an unsubscribe. */
  /** The scene's live preset changed (from the dashboard, the HUD, a schedule or a booking). */
  onActivePresetChanged(listener: (presetId: string) => void): () => void {
    const handler = (id: string) => {
      try { listener(id) } catch { /* swallow */ }
    }
    this.events.on('active_preset_changed', handler)
    return () => this.events.off('active_preset_changed', handler)
  }

  /** Editors only: a preset was created, renamed or deleted (`{ action: 'upsert', preset } | { action: 'delete', presetId }`). */
  onPresetsChanged(listener: (change: { action: 'upsert'; preset: { id: string; name: string } } | { action: 'delete'; presetId: string }) => void): () => void {
    const handler = (change: any) => {
      try { listener(change) } catch { /* swallow */ }
    }
    this.events.on('presets_changed', handler)
    return () => this.events.off('presets_changed', handler)
  }

  onLibraryChanged(listener: (change: SceneLibraryChangeData) => void): () => void {
    const handler = (change: SceneLibraryChangeData) => {
      try { listener(change) } catch { /* swallow */ }
    }
    this.events.on('library_changed', handler)
    return () => this.events.off('library_changed', handler)
  }

  /** The scene's running raffle changed (or ended: null). Also called once on join; returns an unsubscribe. */
  onRaffleChanged(listener: (raffle: PublicRaffle | null) => void): () => void {
    const handler = (r: PublicRaffle | null) => {
      try { listener(r) } catch { /* swallow */ }
    }
    this.events.on('raffle_changed', handler)
    return () => this.events.off('raffle_changed', handler)
  }

  /** A raffle draw happened: spin the wheel. Returns an unsubscribe. */
  onRaffleDraw(listener: (draw: PublicDraw) => void): () => void {
    const handler = (d: PublicDraw) => {
      try { listener(d) } catch { /* swallow */ }
    }
    this.events.on('raffle_draw', handler)
    return () => this.events.off('raffle_draw', handler)
  }

  /** The current scene's running raffle, with the caller's entry and whether they can enter. */
  getCurrentRaffle() {
    return this.http.getCurrentRaffle(this.requireSceneId())
  }

  enterRaffle(raffleId: string) {
    return this.http.enterRaffle(raffleId, RAFFLE_CONSENT_VERSION)
  }

  withdrawRaffle(raffleId: string) {
    return this.http.withdrawRaffle(raffleId)
  }

  raffleCheckIn(raffleId: string) {
    return this.http.raffleCheckIn(raffleId)
  }

  // Host calls (need raffle.run)
  raffleList() { return this.http.listRaffles(this.requireSceneId()) }
  raffleDetail(raffleId: string) { return this.http.getRaffleDetail(raffleId) }
  updateRaffle(raffleId: string, patch: RafflePatch) { return this.http.updateRaffle(raffleId, patch) }
  raffleOpen(raffleId: string) { return this.http.raffleAction(raffleId, 'open') }
  raffleSnapshot(raffleId: string) { return this.http.raffleAction(raffleId, 'snapshot') }
  raffleDraw(raffleId: string) { return this.http.raffleAction(raffleId, 'draw') }
  raffleClose(raffleId: string) { return this.http.raffleAction(raffleId, 'close') }

  private requireSceneId(): string {
    const id = this._sceneId ?? this.binding?.sceneId
    if (!id) throw new Error('No scene')
    return id
  }

  /** Called with the current missingModels() count whenever it changes; returns an unsubscribe. */
  onModelsMissing(listener: (count: number) => void): () => void {
    const handler = () => {
      try { listener(this.missingModels()) } catch { /* swallow */ }
    }
    this.events.on('models_missing', handler)
    return () => this.events.off('models_missing', handler)
  }

  sendMessage(id: string, data?: unknown): void {
    this.colyseus.send('user_message', { messageId: id, data, type: 'outbound' })
  }

  onMessage(id: string, callback: (data: unknown) => void): void {
    this.userMessageHandlers.set(id, callback)
  }

  /** @deprecated use track() */
  recordAction(id: string, metadata?: Record<string, unknown>): void {
    this.track(id, metadata)
  }

  attachAnalytics(collector: import('./analytics/collector.js').Collector): void {
    this.analytics = collector
  }

  track(name: string, props?: Record<string, unknown>): void {
    this.analytics?.track(name, props)
  }
}
