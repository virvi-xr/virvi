import type { Scene, AuthProof, VirviPlatformAdapter, AnalyticsSceneRef, SceneLibraryItemData, AdServeRequest, AdServeResponse, AdEventBatch } from '@virvixr/shared'
import type { AuthResponse, MediaAsset } from './types.js'
import { VirviAuth } from './auth.js'

export type SetupStatus =
  | { state: 'eligible' }
  | { state: 'member'; sceneId: string; role: 'host' | 'cohost' | 'editor' | 'viewer' }
  | { state: 'taken'; host: string; sceneId?: string }
  /** `sceneId` is present when the location is set up — visitors connect content-only. */
  | { state: 'none'; sceneId?: string }
  | { state: 'unavailable' }

export interface SceneRoleEntry {
  wallet: string
  role: 'cohost' | 'editor' | 'viewer'
  userId: string | null
  displayName?: string | null
  createdAt?: string
}

/** One file in the signed-in user's Media library (`GET /api/media`). */
export interface MediaLibraryAsset {
  id: string
  filename: string
  contentType: string
  publicUrl: string | null
  sizeBytes: number
}

/** One file in a scene's library (`GET /api/scenes/:sceneId/library`). */
export type SceneLibraryItem = SceneLibraryItemData

/** A companion upload code: the page link (for this computer or a phone) and a QR image of it. */
export type UploadToken = { code: string; uploadUrl: string; qrUrl: string; expiresAt: string; maxUploads: number }

export class VirviHttpClient {
  private baseUrl: string
  public auth: VirviAuth

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
    this.auth = new VirviAuth()
  }

  /**
   * Retrying after a 401 is safe only because every 401 the server sends comes before the route writes
   * anything (auth preHandler or an early check). Keep it that way.
   *
   * Signs in again when a request gets a 401 (an in-world scene pass lasts 15 min and has no refresh token).
   * Set by Virvi after platform sign-in; called at most once per request, shared by concurrent requests.
   */
  reauthenticate: (() => Promise<void>) | null = null

  /** Sent with every request, under the caller's own headers (the HUD's edit protocol, x-virvi-hud-protocol). */
  defaultHeaders: Record<string, string> = {}
  private reauthInFlight: Promise<void> | null = null

  private async _fetch<T>(path: string, options: RequestInit = {}, retried = false): Promise<T> {
    const sentToken = this.auth.token
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      // Only with a body: the server refuses an empty body labelled as JSON (bodyless DELETEs)
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...this.defaultHeaders,
      ...this.auth.getAuthHeader(),
      ...(options.headers as Record<string, string> || {}),
    }
    const res = await fetch(url, { ...options, headers })
    if (res.status === 401 && !retried && this.reauthenticate && path !== '/api/auth/platform') {
      if (await this.signInAgain(sentToken)) return this._fetch<T>(path, options, true)
    }
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`HTTP ${res.status}: ${body}`)
    }
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  /** Run the re-auth hook, shared by every caller while one is in flight (the 401 retry and timed renewals). */
  renewSession(): Promise<void> {
    if (!this.reauthenticate) return Promise.reject(new Error('No re-auth hook'))
    this.reauthInFlight ??= this.reauthenticate().finally(() => { this.reauthInFlight = null })
    return this.reauthInFlight
  }

  /** True when there is a new token to retry with. A token already replaced by another request counts. */
  private async signInAgain(sentToken: string | null): Promise<boolean> {
    if (this.auth.token !== sentToken) return true
    try {
      await this.renewSession()
    } catch {
      return false
    }
    return this.auth.token !== sentToken
  }

  // Auth
  async register(email: string, password: string, displayName: string): Promise<AuthResponse> {
    const data = await this._fetch<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    })
    this.auth.setTokens(data.accessToken, data.refreshToken)
    return data
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const data = await this._fetch<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    this.auth.setTokens(data.accessToken, data.refreshToken)
    return data
  }

  async refreshToken(): Promise<{ accessToken: string }> {
    if (!this.auth.refreshToken) throw new Error('No refresh token')
    const data = await this._fetch<{ accessToken: string }>('/api/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.auth.refreshToken}` },
    })
    this.auth.token = data.accessToken
    return data
  }

  /**
   * Authenticate with the Virvi server using platform credentials.
   *
   * If the adapter supports signedRequest (e.g., DCL's signedFetch), the request
   * is made through the adapter so cryptographic auth headers are included.
   * The server then verifies the AuthChain to prove the wallet identity.
   *
   * Falls back to regular fetch with proof in body for other platforms.
   */
  async authenticateWithPlatform(
    proof: AuthProof,
    platformData: Record<string, unknown>,
    adapter?: VirviPlatformAdapter,
    /**
     * Re-signing an existing pass: signed request only, and an answer that isn't a pass for `keepSceneId`
     * (guest, visitor, another scene) never replaces the current tokens.
     */
    opts: { signedOnly?: boolean; keepSceneId?: string } = {},
  ): Promise<AuthResponse> {
    const path = '/api/auth/platform'
    const body = JSON.stringify({ ...platformData })

    // If the adapter can make signed requests, use that path
    // This sends the DCL AuthChain headers which the server verifies
    if (adapter?.signedRequest) {
      try {
        const response = await adapter.signedRequest(`${this.baseUrl}${path}`, {
          method: 'POST',
          body,
        })

        if (response.status < 200 || response.status >= 300) {
          throw new Error(`HTTP ${response.status}: ${response.body}`)
        }

        const data = JSON.parse(response.body) as AuthResponse
        if (opts.signedOnly && (data as { guest?: boolean }).guest) throw new Error('Re-sign returned a guest session')
        if (opts.keepSceneId && data.scene?.sceneId !== opts.keepSceneId) throw new Error('Re-sign did not bind the same scene')
        this.auth.setTokens(data.accessToken, data.refreshToken)
        return data
      } catch (err) {
        if (opts.signedOnly) throw err
        // If signedRequest fails, fall through to regular fetch
        console.warn('[VirviHttpClient] signedRequest failed, falling back to regular fetch:', err)
      }
    }

    if (opts.signedOnly) throw new Error('Re-sign needs a signed request')
    // Fallback: regular fetch with proof in body (unverified)
    const data = await this._fetch<AuthResponse>(path, {
      method: 'POST',
      body: JSON.stringify({ proof, ...platformData }),
    })
    this.auth.setTokens(data.accessToken, data.refreshToken)
    return data
  }

  // Scenes
  /**
   * Ask whether the signed-in wallet may set up this location, without creating an account.
   * Any failure counts as "not eligible, not known".
   */
  /** `unavailable`: Decentraland could not answer; worth retrying (unlike a plain "not eligible"). */
  async checkAnalyticsClaimSigned(
    locationKey: string,
    adapter: VirviPlatformAdapter,
  ): Promise<{ eligible: boolean; known: boolean; unavailable?: boolean }> {
    if (!adapter.signedRequest) return { eligible: false, known: false }
    try {
      const res = await adapter.signedRequest(`${this.baseUrl}/api/analytics/claims/check-signed`, {
        method: 'POST',
        body: JSON.stringify({ locationKey }),
      })
      if (res.status < 200 || res.status >= 300) return { eligible: false, known: false }
      const data = JSON.parse(res.body)
      return data.unavailable
        ? { eligible: !!data.eligible, known: !!data.known, unavailable: true }
        : { eligible: !!data.eligible, known: !!data.known }
    } catch {
      return { eligible: false, known: false }
    }
  }

  /** Ads to show in this scene's ad spaces. Any failure is `null` (spaces fall back or hide). */
  async getAds(adapter: VirviPlatformAdapter, req: AdServeRequest): Promise<AdServeResponse | null> {
    if (!adapter.signedRequest) return null
    try {
      const res = await adapter.signedRequest(`${this.baseUrl}/api/ads/serve`, { method: 'POST', body: JSON.stringify(req) })
      if (res.status !== 200) return null
      return JSON.parse(res.body) as AdServeResponse
    } catch {
      return null
    }
  }

  /** Report ad view events. `ok` only when the server accepted the batch; `status` 0 when there was no response. */
  async sendAdEvents(adapter: VirviPlatformAdapter, batch: AdEventBatch): Promise<{ ok: boolean; status: number }> {
    if (!adapter.signedRequest) return { ok: false, status: 0 }
    try {
      const res = await adapter.signedRequest(`${this.baseUrl}/api/ads/events`, { method: 'POST', body: JSON.stringify(batch) })
      return { ok: res.status >= 200 && res.status < 300, status: res.status }
    } catch {
      return { ok: false, status: 0 }
    }
  }

  /** What the in-world HUD should offer this signed-in wallet at this location. Failures count as "none". */
  async getSetupStatus(scene: AnalyticsSceneRef, adapter: VirviPlatformAdapter): Promise<SetupStatus> {
    if (!adapter.signedRequest) return { state: 'none' }
    try {
      const res = await adapter.signedRequest(`${this.baseUrl}/api/setup/status`, { method: 'POST', body: JSON.stringify({ scene }) })
      if (res.status < 200 || res.status >= 300) return { state: 'none' }
      return JSON.parse(res.body) as SetupStatus
    } catch {
      return { state: 'none' }
    }
  }

  /** Public: the Virvi scene set up at a location key (`gc:x,y` / `world:name.eth`), or null. Used for guests (no signed fetch). */
  async getSceneForLocation(locationKey: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/setup/scene?location=${encodeURIComponent(locationKey)}`)
      if (!res.ok) return null
      const data = (await res.json()) as { sceneId?: unknown }
      return typeof data?.sceneId === 'string' && data.sceneId ? data.sceneId : null
    } catch {
      return null
    }
  }

  /** One-press setup: the signed-in wallet becomes host of a new Virvi scene for this location. */
  async setUpHere(scene: AnalyticsSceneRef, adapter: VirviPlatformAdapter): Promise<{ sceneId: string } | { error: string; host?: string; status: number }> {
    if (!adapter.signedRequest) return { error: 'signed_request_unavailable', status: 0 }
    try {
      const res = await adapter.signedRequest(`${this.baseUrl}/api/setup`, { method: 'POST', body: JSON.stringify({ scene }) })
      const data = res.body ? JSON.parse(res.body) : {}
      if (res.status >= 200 && res.status < 300) return { sceneId: data.sceneId }
      return { error: data.error || 'setup_failed', host: data.host, status: res.status }
    } catch (err) {
      return { error: String(err), status: 0 }
    }
  }

  async getSceneRoles(sceneId: string): Promise<{ host: { userId: string; displayName: string | null; wallets: string[] }; roles: SceneRoleEntry[] }> {
    return this._fetch(`/api/scenes/${sceneId}/roles`)
  }

  async getDclPublishStatus(sceneId: string): Promise<{ destination: null | { id: string; world: string; mode: 'virvi' | 'sign'; status: string; granted: boolean; pending: number; publishUrl: string } }> {
    return this._fetch(`/api/scenes/${sceneId}/dcl/publish-status`)
  }

  async addSceneRole(sceneId: string, wallet: string, role: 'cohost' | 'editor' | 'viewer'): Promise<{ role: SceneRoleEntry }> {
    return this._fetch(`/api/scenes/${sceneId}/roles`, { method: 'POST', body: JSON.stringify({ wallet, role }) })
  }

  async removeSceneRole(sceneId: string, wallet: string): Promise<void> {
    await this._fetch(`/api/scenes/${sceneId}/roles/${wallet}`, { method: 'DELETE' })
  }

  async transferHost(sceneId: string, wallet: string): Promise<{ host: string }> {
    return this._fetch(`/api/scenes/${sceneId}/transfer-host`, { method: 'POST', body: JSON.stringify({ wallet }) })
  }

  async createHandoff(): Promise<{ code: string; expiresAt: string }> {
    return this._fetch('/api/auth/handoff', { method: 'POST', body: '{}' })
  }

  async getScenes(): Promise<{ scenes: Scene[] }> {
    return this._fetch('/api/scenes')
  }

  /** Scene presets (LIV-84): blank, or a copy of `fromPresetId`. */
  async createPreset(sceneId: string, name: string, fromPresetId?: string): Promise<{ preset: { id: string; name: string } }> {
    return this._fetch(`/api/scenes/${encodeURIComponent(sceneId)}/presets`, {
      method: 'POST',
      body: JSON.stringify(fromPresetId ? { name, fromPresetId } : { name }),
    })
  }

  async renamePreset(presetId: string, name: string): Promise<{ preset: { id: string; name: string } }> {
    return this._fetch(`/api/presets/${encodeURIComponent(presetId)}`, { method: 'PATCH', body: JSON.stringify({ name }) })
  }

  /** Make a preset live: everyone in the scene switches to it. */
  async activatePreset(presetId: string): Promise<{ activePresetId: string }> {
    return this._fetch(`/api/presets/${encodeURIComponent(presetId)}/activate`, { method: 'POST', body: '{}' })
  }

  async getScene(sceneId: string): Promise<{ scene: Scene }> {
    return this._fetch(`/api/scenes/${sceneId}`)
  }

  async createScene(name: string, description?: string): Promise<{ scene: Scene; preset: any }> {
    return this._fetch('/api/scenes', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    })
  }

  // Media library
  async getMedia(): Promise<{ assets: MediaLibraryAsset[] }> {
    return this._fetch('/api/media')
  }

  // Scene library (works with an in-world scene pass, unlike /api/media)
  async getSceneLibrary(sceneId: string): Promise<{ items: SceneLibraryItem[] }> {
    return this._fetch(`/api/scenes/${encodeURIComponent(sceneId)}/library`)
  }

  async uploadToSceneLibrary(
    sceneId: string,
    file: { filename: string; contentType: string; data: string },
  ): Promise<{ item: SceneLibraryItem }> {
    return this._fetch(`/api/scenes/${encodeURIComponent(sceneId)}/library/upload`, {
      method: 'POST',
      body: JSON.stringify(file),
    })
  }

  async renameSceneLibraryItem(sceneId: string, id: string, name: string): Promise<{ item: SceneLibraryItem }> {
    return this._fetch(`/api/scenes/${encodeURIComponent(sceneId)}/library/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
  }

  async removeFromSceneLibrary(sceneId: string, id: string): Promise<void> {
    await this._fetch(`/api/scenes/${encodeURIComponent(sceneId)}/library/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /** Companion upload token; the server requires `sceneId` (and scene.edit) for scene passes. */
  async createUploadToken(
    sceneId: string,
    opts: { maxUploads?: number; expiresInMinutes?: number; kinds?: ('image' | 'model' | 'video')[] } = {},
  ): Promise<{ token: UploadToken }> {
    return this._fetch('/api/upload-tokens', {
      method: 'POST',
      body: JSON.stringify({ sceneId, maxUploads: 10, expiresInMinutes: 30, ...opts }),
    })
  }

  // Elements
  async createElement(presetId: string, data: Record<string, unknown>): Promise<{ element: any }> {
    return this._fetch(`/api/presets/${presetId}/elements`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateElement(elementId: string, data: Record<string, unknown>): Promise<{ element: any }> {
    return this._fetch(`/api/elements/${elementId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async deleteElement(elementId: string): Promise<void> {
    await this._fetch(`/api/elements/${elementId}`, { method: 'DELETE' })
  }

  // Instances
  async createInstance(elementId: string, data: Record<string, unknown>): Promise<{ instance: any }> {
    return this._fetch(`/api/elements/${elementId}/instances`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateInstance(instanceId: string, data: Record<string, unknown>): Promise<{ instance: any }> {
    return this._fetch(`/api/instances/${instanceId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }
}
