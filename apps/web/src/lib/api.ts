'use client'
import { useCallback, useMemo } from 'react'
import { useAuth } from './auth'
import { API_URL } from './config'
import { requestHeaders } from './request-headers'
import type { Plot, RoomSetOptions } from '@virvixr/shared'
import type { RoomNudge } from './room-set'
import type { AuthChain } from '@dcl/crypto'
import type { ArFileFormat, ArMounting } from './ar'
import type { AdminGiftCode, AdminMistakeReport, AdminStudioFlag, Quote, RenderView, StudioDesign, StudioDetail, StudioKind, StudioUpload, StudioUsage } from './studio'
import type { ArDeviceKind, ArDeviceSummary, ArPairApprovalInfo, ArFloorView, ArMarkerView, ArSpaceView, AdContent, AdAudience, AdminAd, AdminAdSpace, OwnerAdSpace, AdminAdvertiserLead, AdReport, AdShape, CatalogPack, HyperfyPairingSummary, HyperfyWorldSummary } from '@virvixr/shared'
import type { AnalyticsLocation, AnalyticsRangeQuery, AnalyticsSession, AnalyticsSummary, HeatCell, LiveData, TimeseriesPoint } from './analytics/types'

// ── New Scene Wizard and Decentraland Worlds ────────────────────────────────

export interface WizardAsset {
  id: string
  name: string
  thumbnailUrl: string | null
  cdnUrl: string | null
  dimensions: { x: number; y: number; z: number } | null
  triangleCount: number | null
  fileSizeBytes: number
}

export interface WizardCatalog {
  themes: Array<{ id: string; name: string; items: Array<{ asset: WizardAsset; x: number; z: number; rotationY: number }> }>
  chips: Array<{ id: string; label: string; categories: string[]; assets: WizardAsset[] }>
}

export interface WizardOptions {
  dcl: { virviDeploys: boolean; virviAddress: string | null }
  hyperfy: { allowed: boolean; requiredTier: string }
  scenes: { used: number; limit: number | null }
}

export interface WizardSceneBody {
  name: string
  plot: Plot
  spawn: { x: number; z: number }
  items: Array<{ assetId: string; x: number; z: number; rotationY: number }>
  /** True with a Decentraland destination; false (Hyperfy/AR only) skips the per-parcel budget. */
  dcl: boolean
  /** Start from one of the caller's room scans; `plot` must be the scan's size. */
  roomSet?: { scanId: string; options: RoomSetOptions }
}

/** One of the caller's room scans. `plot` is the smallest plot that holds it, null when none does. */
export interface RoomScanSummary {
  id: string
  name: string
  source: 'quest-mruk' | 'ios-roomplan'
  roomCount: number
  footprint: { minX: number; minZ: number; maxX: number; maxZ: number }
  plot: Plot | null
  createdAt: string
}

/**
 * One room set (owner only). `rooms` holds its scan's room labels, null once the scan is deleted (it can't be
 * restyled then). `nudges` has one entry per room once adjusted, and is empty or `{}` before.
 */
export interface RoomSetDetail {
  id: string
  scanId: string | null
  options: RoomSetOptions
  nudges: RoomNudge[] | Record<string, never>
  glbUrl: string
  triangles: number
  plot: Plot
  sceneElementId: string | null
  assetItemId: string | null
  rooms: string[] | null
}

/** The preview GLB of a scan with these options (the route needs the bearer header: fetch it, don't link it). */
export function roomScanPreviewUrl(id: string, options: RoomSetOptions): string {
  const q = new URLSearchParams({
    style: options.style,
    wallColor: options.wallColor,
    floorColor: options.floorColor,
    ceiling: String(options.ceiling),
    furniture: String(options.furniture),
  })
  return `${API_URL}/api/room-scans/${encodeURIComponent(id)}/preview.glb?${q}`
}

/** A World as the server describes it; `footprint` is the parcels of its live scene(s), null when it has none. */
export interface DclWorld {
  world: string
  hasScene: boolean
  footprint: { base: string; parcels: string[] } | null
  storage: { maxAllowedBytes: number; usedBytes: number } | null
}

export type DclDestinationMode = 'virvi' | 'sign'

export interface DclDestination {
  id: string
  sceneId: string
  ownerUserId: string
  ownerWallet: string
  worldName: string
  base: string
  parcels: string[]
  mode: DclDestinationMode
  grantedAt: string | null
  status: string
  statusDetail: string | null
  lastEntityId: string | null
  deployedFiles: string[]
  pendingSince: string | null
  adopted: boolean
  spawn: { x: number; y: number; z: number } | null
  createdAt: string
  updatedAt: string
}

/** A model in the scene that the World doesn't have yet. */
export interface DclPendingModel {
  elementId: string
  name: string
  url: string
  file: string
  triangles: number | null
  bytes: number | null
}

/** A deployment row (the Hyperfy admin code never reaches the browser). */
export interface DclDeployment {
  id: string
  sceneId: string
  status: string
  [key: string]: any
}

/** A request the owner's wallet must sign for Decentraland's Worlds server. */
export interface DclSignRequest {
  method: 'PUT' | 'POST' | 'DELETE'
  path: string
  metadata: string
  timestamp: number
  body?: unknown
  /** What to sign (personal-sign payload for the signed fetch). */
  payload: string
}

export type DclGrantPurpose = 'reset' | 'grant' | 'scope' | 'rollback'

export interface DclGrantRequests {
  virviAddress: string
  /** Every request shares one timestamp: submit `requests[0].timestamp`. */
  requests: Array<DclSignRequest & { purpose: DclGrantPurpose }>
}

export interface DclRevokeRequests {
  requests: DclSignRequest[]
}

/** Sign every request's `payload`, in order; Decentraland rejects them after ~60 s (the server after 50 s). */
export interface DclSignedSubmission {
  chains: AuthChain[]
  timestamp: number
}

/** Read a File as base64 (no `data:…;base64,` prefix) for JSON upload bodies. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
}

/** Content type to send for a media upload; browsers often leave `type` empty for .glb files. */
export function mediaContentType(file: File): string {
  if (file.type) return file.type
  return file.name.toLowerCase().endsWith('.glb') ? 'model/gltf-binary' : 'application/octet-stream'
}

export type { AdminAdSpace } from '@virvixr/shared'

/** A visitor's report of a Virvi Spaces space, as the admin page lists it. */
export interface AdminArReport {
  id: string
  spaceId: string
  spaceName: string
  sceneId: string
  sceneName: string
  reason: string
  platform: string
  status: 'open' | 'resolved'
  createdAt: string
}

export const MEDIA_UPLOAD_RULES = 'Only PNG, JPG, WebP, GIF (≤ 10 MB), GLB (≤ 50 MB) or MP4/WebM video (≤ 70 MB)'

/** Human-readable message for a failed media upload. */
export function uploadErrorMessage(err: any): string {
  const msg = err?.message || ''
  // 'HTTP 413' is a non-JSON 413 (e.g. a proxy's body-size page) — still a size problem.
  if (msg === 'unsupported_type' || msg === 'too_large' || msg === 'HTTP 413') return MEDIA_UPLOAD_RULES
  return msg || 'Upload failed'
}

/** True if a media asset is a GLB model (old uploads may be stored as octet-stream). */
export function isGlbAsset(asset: { contentType?: string; filename?: string }): boolean {
  return asset.contentType === 'model/gltf-binary' || !!asset.filename?.toLowerCase().endsWith('.glb')
}

export function useApi() {
  const { token, logout, renew } = useAuth()

  /** A kind-less (pre-scene-pass) session, or a scene pass used outside its scope: drop it so the
   *  dashboard layout sends the user to sign-in once (with `next`), instead of showing an error. */
  const dropDeadSession = useCallback((status: number, err: any) => {
    if ((status === 401 && err.message === 'Session expired — sign in again') || (status === 403 && err.error === 'scene_pass_not_allowed')) logout()
  }, [logout])

  const apiFetch = useCallback(async <T = any>(path: string, options: RequestInit = {}): Promise<T> => {
    let res = await fetch(`${API_URL}${path}`, { ...options, headers: requestHeaders(token, options) })
    // The access token ran out: renew it with the stored refresh token and send the request once more
    if (res.status === 401 && token) {
      const fresh = await renew()
      if (fresh) res = await fetch(`${API_URL}${path}`, { ...options, headers: requestHeaders(fresh, options) })
    }
    if (!res.ok) {
      // Non-JSON error bodies (proxy pages, e.g. a 413 from the edge) become `HTTP <status>`.
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      dropDeadSession(res.status, err)
      throw Object.assign(new Error(err.error || `API error ${res.status}`), { status: res.status, body: err })
    }
    if (res.status === 204) return undefined as T
    return res.json()
  }, [token, dropDeadSession, renew])

  // One object per session: effects and callbacks that depend on `api` (or one of its functions) run once, not on
  // every render, which would refetch in a loop
  return useMemo(() => ({
    // Linked wallets
    getWallets: () => apiFetch<{ wallets: { address: string; linkedAt: string }[] }>('/api/auth/wallets'),
    linkWallet: (proof: { address: string; nonce: string; signature: string }) =>
      apiFetch<{ linked: boolean }>('/api/auth/wallet/verify', { method: 'POST', body: JSON.stringify(proof) }),

    // Scenes
    getScenes: () => apiFetch<{ scenes: any[] }>('/api/scenes'),
    getScene: (id: string) => apiFetch<{ scene: any }>(`/api/scenes/${id}`),
    createScene: (name: string, description?: string) =>
      apiFetch<{ scene: any; preset: any }>('/api/scenes', { method: 'POST', body: JSON.stringify({ name, description }) }),
    updateScene: (id: string, data: Record<string, any>) =>
      apiFetch<{ scene: any }>(`/api/scenes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteScene: (id: string) =>
      apiFetch(`/api/scenes/${id}`, { method: 'DELETE' }),

    // Scene Collaborators
    getSceneCollaborators: (sceneId: string) =>
      apiFetch<{ collaborators: any[] }>(`/api/scenes/${sceneId}/collaborators`),
    addSceneCollaborator: (sceneId: string, email: string, role: string) =>
      apiFetch<{ collaborator: any }>(`/api/scenes/${sceneId}/collaborators`, { method: 'POST', body: JSON.stringify({ email, role }) }),
    updateSceneCollaborator: (sceneId: string, userId: string, role: string) =>
      apiFetch<{ collaborator: any }>(`/api/scenes/${sceneId}/collaborators/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
    removeSceneCollaborator: (sceneId: string, userId: string) =>
      apiFetch(`/api/scenes/${sceneId}/collaborators/${userId}`, { method: 'DELETE' }),

    // AR spaces
    getArSpaces: (sceneId: string) => apiFetch<ArSpaceView[]>(`/api/scenes/${sceneId}/ar/spaces`),
    createArSpace: (sceneId: string, body: { name: string; place?: string | null }) =>
      apiFetch<ArSpaceView>(`/api/scenes/${sceneId}/ar/spaces`, { method: 'POST', body: JSON.stringify(body) }),
    updateArSpace: (id: string, patch: { name?: string; place?: string | null; lat?: number | null; lng?: number | null; published?: boolean }) =>
      apiFetch<ArSpaceView>(`/api/ar/spaces/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    deleteArSpace: (id: string) => apiFetch(`/api/ar/spaces/${id}`, { method: 'DELETE' }),
    addArFloor: (spaceId: string, body: { name: string; heightM: number }) =>
      apiFetch<ArFloorView>(`/api/ar/spaces/${spaceId}/floors`, { method: 'POST', body: JSON.stringify(body) }),
    updateArFloor: (id: string, patch: { name?: string; heightM?: number; sortOrder?: number }) =>
      apiFetch<ArFloorView>(`/api/ar/floors/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    deleteArFloor: (id: string) => apiFetch(`/api/ar/floors/${id}`, { method: 'DELETE' }),
    addArMarker: (floorId: string, body: { diameterMm?: number; whereText?: string | null }) =>
      apiFetch<ArMarkerView>(`/api/ar/floors/${floorId}/markers`, { method: 'POST', body: JSON.stringify(body) }),
    updateArMarker: (id: string, patch: { diameterMm?: number; whereText?: string | null }) =>
      apiFetch<ArMarkerView>(`/api/ar/markers/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    deleteArMarker: (id: string) => apiFetch(`/api/ar/markers/${id}`, { method: 'DELETE' }),
    arMarkerFileUrl: (id: string, format: ArFileFormat, mounting: ArMounting = 'none') =>
      `${API_URL}/api/ar/markers/${id}/files?format=${format}&mounting=${mounting}`,
    /** Authenticated download (a plain link can't send the bearer header). Filename comes from Content-Disposition. */
    downloadArMarkerFile: async (id: string, format: ArFileFormat, mounting: ArMounting = 'none'): Promise<{ blob: Blob; filename: string }> => {
      const res = await fetch(`${API_URL}/api/ar/markers/${id}/files?format=${format}&mounting=${mounting}`, { headers: requestHeaders(token, {}) })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        dropDeadSession(res.status, err)
        throw Object.assign(new Error(err.error || `API error ${res.status}`), { status: res.status, body: err })
      }
      const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')
      return { blob: await res.blob(), filename: m?.[1] ?? `virvi-ring-${id}.${format}` }
    },

    // Scene roles (wallet-based)
    getSceneRoles: (sceneId: string) =>
      apiFetch<{ host: { userId: string; displayName: string | null; wallets: string[] }; roles: { wallet: string; role: 'cohost' | 'editor' | 'viewer'; userId: string | null; displayName: string | null; createdAt: string }[] }>(`/api/scenes/${sceneId}/roles`),
    addSceneRole: (sceneId: string, wallet: string, role: 'cohost' | 'editor' | 'viewer') =>
      apiFetch(`/api/scenes/${sceneId}/roles`, { method: 'POST', body: JSON.stringify({ wallet, role }) }),
    removeSceneRole: (sceneId: string, wallet: string) => apiFetch(`/api/scenes/${sceneId}/roles/${wallet}`, { method: 'DELETE' }),
    transferHost: (sceneId: string, wallet: string) =>
      apiFetch<{ host: string }>(`/api/scenes/${sceneId}/transfer-host`, { method: 'POST', body: JSON.stringify({ wallet }) }),

    // Elements
    createElement: (presetId: string, data: Record<string, any>) =>
      apiFetch<{ element: any }>(`/api/presets/${presetId}/elements`, { method: 'POST', body: JSON.stringify(data) }),
    updateElement: (id: string, data: Record<string, any>) =>
      apiFetch<{ element: any }>(`/api/elements/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteElement: (id: string) =>
      apiFetch(`/api/elements/${id}`, { method: 'DELETE' }),

    // Instances
    createInstance: (elementId: string, data: Record<string, any>) =>
      apiFetch<{ instance: any }>(`/api/elements/${elementId}/instances`, { method: 'POST', body: JSON.stringify(data) }),
    updateInstance: (id: string, data: Record<string, any>) =>
      apiFetch<{ instance: any }>(`/api/instances/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteInstance: (id: string) =>
      apiFetch(`/api/instances/${id}`, { method: 'DELETE' }),

    // Media
    getMedia: () => apiFetch<{ assets: any[] }>('/api/media'),
    uploadMedia: (filename: string, contentType: string, data: string) =>
      apiFetch<{ asset: any }>('/api/media/upload', { method: 'POST', body: JSON.stringify({ filename, contentType, data }) }),
    deleteMedia: (assetId: string) =>
      apiFetch(`/api/media/${assetId}`, { method: 'DELETE' }),

    // Organizations
    getOrgs: () => apiFetch<{ organizations: any[] }>('/api/orgs'),
    createOrg: (name: string) => apiFetch<{ organization: any }>('/api/orgs', { method: 'POST', body: JSON.stringify({ name }) }),
    getOrgMembers: (orgId: string) => apiFetch<{ members: any[] }>(`/api/orgs/${orgId}/members`),
    inviteToOrg: (orgId: string, email: string, role?: string) => apiFetch<{ invite: any }>(`/api/orgs/${orgId}/invites`, { method: 'POST', body: JSON.stringify({ email, role }) }),
    removeOrgMember: (orgId: string, userId: string) => apiFetch(`/api/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
    setActiveOrg: (orgId: string) => apiFetch<{ activeOrgId: string }>(`/api/orgs/${orgId}/active`, { method: 'PUT' }),
    acceptInvite: (token: string) => apiFetch<{ accepted: boolean; orgId: string }>('/api/orgs/accept-invite', { method: 'POST', body: JSON.stringify({ token }) }),

    // Platform Hooks
    getHooks: () => apiFetch<{ hooks: any[] }>('/api/hooks'),
    deleteHook: (hookId: string) => apiFetch(`/api/hooks/${hookId}`, { method: 'DELETE' }),

    // API Keys
    getApiKeys: () => apiFetch<{ keys: any[] }>('/api/keys'),
    createApiKey: (name: string) => apiFetch<{ key: string; apiKey: any }>('/api/keys', { method: 'POST', body: JSON.stringify({ name }) }),
    deleteApiKey: (keyId: string) => apiFetch(`/api/keys/${keyId}`, { method: 'DELETE' }),

    // Analytics (locations)
    getAnalyticsLocations: () => apiFetch<{ scenes: AnalyticsLocation[] }>('/api/analytics/locations'),
    getAnalyticsSummary: (id: string, q: AnalyticsRangeQuery) =>
      apiFetch<AnalyticsSummary>(`/api/analytics/locations/${id}/summary?${new URLSearchParams({ ...q })}`),
    getAnalyticsTimeseries: (id: string, q: AnalyticsRangeQuery & { bucket: 'hour' | 'day' }) =>
      apiFetch<{ points: TimeseriesPoint[] }>(`/api/analytics/locations/${id}/timeseries?${new URLSearchParams({ ...q })}`),
    getAnalyticsLive: (id: string) => apiFetch<LiveData>(`/api/analytics/locations/${id}/live`),
    getAnalyticsHeatmap: (id: string, q: AnalyticsRangeQuery) =>
      apiFetch<{ cells: HeatCell[] }>(`/api/analytics/locations/${id}/heatmap?${new URLSearchParams({ ...q })}`),
    getAnalyticsSessions: (id: string, cursor?: string) => {
      const query = new URLSearchParams({ limit: '50' })
      if (cursor) query.set('cursor', cursor)
      return apiFetch<{ sessions: AnalyticsSession[]; nextCursor: string | null }>(`/api/analytics/locations/${id}/sessions?${query}`)
    },
    setAnalyticsWalletVisibility: (id: string, on: boolean) =>
      apiFetch<{ scene: { id: string; walletVisibility: boolean } }>(`/api/analytics/locations/${id}`, { method: 'PATCH', body: JSON.stringify({ walletVisibility: on }) }),

    // Giveaways
    getGiveaways: () => apiFetch<{ giveaways: any[] }>('/api/giveaways'),
    getGiveaway: (id: string) => apiFetch<{ giveaway: any }>(`/api/giveaways/${id}`),
    createGiveaway: (data: { name: string; enabled?: boolean; claimLimit?: number }) =>
      apiFetch<{ giveaway: any }>('/api/giveaways', { method: 'POST', body: JSON.stringify(data) }),
    updateGiveaway: (id: string, data: { name?: string; enabled?: boolean; claimLimit?: number }) =>
      apiFetch<{ giveaway: any }>(`/api/giveaways/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteGiveaway: (id: string) =>
      apiFetch(`/api/giveaways/${id}`, { method: 'DELETE' }),
    addGiveawayItem: (giveawayId: string, data: { name?: string; imageUrl?: string; contractAddress?: string; tokenId?: string; metadata?: unknown }) =>
      apiFetch<{ item: any }>(`/api/giveaways/${giveawayId}/items`, { method: 'POST', body: JSON.stringify(data) }),
    deleteGiveawayItem: (giveawayId: string, itemId: string) =>
      apiFetch(`/api/giveaways/${giveawayId}/items/${itemId}`, { method: 'DELETE' }),
    getGiveawayClaims: (giveawayId: string) =>
      apiFetch<{ claims: any[] }>(`/api/giveaways/${giveawayId}/claims`),

    // Account
    updateProfile: (displayName: string) =>
      apiFetch<{ user: any }>('/api/auth/profile', { method: 'PUT', body: JSON.stringify({ displayName }) }),
    changePassword: (currentPassword: string, newPassword: string) =>
      apiFetch<{ success: boolean }>('/api/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),
    deleteAccount: (password: string) =>
      apiFetch('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }),

    // Admin
    getAdminStats: () => apiFetch<{
      totalUsers: number; totalOrgs: number; totalScenes: number;
      totalMedia: number; totalStorageBytes: number;
      activeSubscriptionsByTier: Record<string, number>;
    }>('/api/admin/stats'),
    getAdminUsers: (params?: { limit?: number; offset?: number; search?: string }) => {
      const query = new URLSearchParams()
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      if (params?.search) query.set('search', params.search)
      const qs = query.toString()
      return apiFetch<{ users: any[]; total: number; limit: number; offset: number }>(
        `/api/admin/users${qs ? `?${qs}` : ''}`,
      )
    },
    getAdminUser: (id: string) => apiFetch<{ user: any; subscription: any }>(`/api/admin/users/${id}`),
    updateUserRole: (userId: string, role: string) =>
      apiFetch<{ user: any }>(`/api/admin/users/${userId}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
    deleteUser: (userId: string) =>
      apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' }),
    getAdminOrgs: (params?: { limit?: number; offset?: number; search?: string }) => {
      const query = new URLSearchParams()
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      if (params?.search) query.set('search', params.search)
      const qs = query.toString()
      return apiFetch<{ organizations: any[]; total: number; limit: number; offset: number }>(
        `/api/admin/orgs${qs ? `?${qs}` : ''}`,
      )
    },
    deleteOrg: (orgId: string) =>
      apiFetch(`/api/admin/orgs/${orgId}`, { method: 'DELETE' }),

    // Billing
    getBillingUsage: () => apiFetch<{ tier: string; limits: any; usage: any }>('/api/billing/usage'),
    getBillingSubscription: () => apiFetch<{ tier: string; status: string; billingEnabled?: boolean; limits: any }>('/api/billing/subscription'),
    createCheckout: (priceId: string) => apiFetch<{ url: string }>('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ priceId }) }),
    getPortalUrl: () => apiFetch<{ url: string }>('/api/billing/portal', { method: 'POST', body: JSON.stringify({}) }),

    // New Scene Wizard
    getWizardCatalog: () => apiFetch<WizardCatalog>('/api/wizard/catalog'),
    getWizardOptions: () => apiFetch<WizardOptions>('/api/wizard/options'),
    /** 400 (incl. `unmeasured_asset`, `invalid_plot`), 403 `scene_limit_reached`, 422 `over_budget` ({ message, triangles, limit } on err.body). */
    bootstrapWizardScene: (data: WizardSceneBody) =>
      apiFetch<{ sceneId: string }>('/api/wizard/scenes', { method: 'POST', body: JSON.stringify(data) }),

    // Room scans and room sets
    getRoomScans: () => apiFetch<{ scans: RoomScanSummary[] }>('/api/room-scans'),
    roomScanPreviewUrl,
    /** The preview GLB and its triangle count (`X-Triangles`). 422 `too_big`. */
    getRoomScanPreview: async (id: string, options: RoomSetOptions, signal?: AbortSignal): Promise<{ blob: Blob; triangles: number | null }> => {
      const res = await fetch(roomScanPreviewUrl(id, options), { headers: requestHeaders(token, {}), signal })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        dropDeadSession(res.status, err)
        throw Object.assign(new Error(err.error || `API error ${res.status}`), { status: res.status, body: err })
      }
      const triangles = Number(res.headers.get('x-triangles'))
      return { blob: await res.blob(), triangles: res.headers.has('x-triangles') && Number.isFinite(triangles) ? triangles : null }
    },
    /** A private library asset made from a scan. 422 `too_big`. */
    createRoomSetAsset: (data: { scanId: string; name: string; options: RoomSetOptions }) =>
      apiFetch<{ asset: any; set: any }>('/api/room-sets/asset', { method: 'POST', body: JSON.stringify(data) }),
    /** 404 unless it's yours. */
    getRoomSet: (id: string) => apiFetch<{ set: RoomSetDetail }>(`/api/room-sets/${encodeURIComponent(id)}`),
    /** Restyle and/or nudge (one per room; `snap` lines doors up first). 409 `scan_deleted`, 422 `too_big`. */
    updateRoomSet: (id: string, data: { options?: Partial<RoomSetOptions>; nudges?: RoomNudge[]; snap?: boolean }) =>
      apiFetch<{ set: Omit<RoomSetDetail, 'rooms'> }>(`/api/room-sets/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),

    // Decentraland Worlds
    getDclNames: () => apiFetch<{ wallets: Array<{ address: string; names: DclWorld[] }> }>('/api/dcl/names'),
    getDclWorld: (world: string) => apiFetch<DclWorld & { owner: boolean }>(`/api/dcl/worlds/${encodeURIComponent(world)}`),
    /** Pass `plot` (and `spawn`) to build a new scene there, or omit both to adopt the live scene. 409 `world_in_use` carries `sceneId`. */
    createDclDestination: (data: { sceneId: string; world: string; mode: DclDestinationMode; plot?: Plot; spawn?: { x: number; z: number } }) =>
      apiFetch<{ destination: DclDestination; replaces?: { parcels: string[] } }>('/api/dcl/destinations', { method: 'POST', body: JSON.stringify(data) }),
    /** The scene's World destinations, and Worlds set up in-world for it (Creator Hub `@virvixr/dcl` scenes) it can adopt. */
    getSceneDclDestinations: (sceneId: string) =>
      apiFetch<{ destinations: DclDestination[]; adoptable: Array<{ world: string }> }>(`/api/scenes/${sceneId}/dcl/destinations`),
    getDclDestination: (id: string) =>
      apiFetch<{ destination: DclDestination; pending: DclPendingModel[]; refused: Array<{ name: string; reason: string }>; lastDeployment: DclDeployment | null }>(`/api/dcl/destinations/${id}`),
    patchDclDestination: (id: string, data: { mode: DclDestinationMode }) =>
      apiFetch<{ destination: DclDestination; message?: string }>(`/api/dcl/destinations/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    getDclGrant: (id: string) => apiFetch<DclGrantRequests>(`/api/dcl/destinations/${id}/grant`),
    submitDclGrant: (id: string, data: DclSignedSubmission) =>
      apiFetch<{ destination: DclDestination }>(`/api/dcl/destinations/${id}/grant`, { method: 'POST', body: JSON.stringify(data) }),
    getDclRevoke: (id: string) => apiFetch<DclRevokeRequests>(`/api/dcl/destinations/${id}/grant`, { method: 'DELETE' }),
    submitDclRevoke: (id: string, data: DclSignedSubmission) =>
      apiFetch<{ destination: DclDestination }>(`/api/dcl/destinations/${id}/revoke`, { method: 'POST', body: JSON.stringify(data) }),
    /** Mode virvi answers 202 with just the deployment; mode sign adds the `payload` to sign (then `submitDeploySignature`). */
    deployDclDestination: (id: string) =>
      apiFetch<{ deployment: DclDeployment; payload?: string; expiresAt?: string }>(`/api/dcl/destinations/${id}/deploy`, { method: 'POST' }),
    /** 409 `expired`: prepare the deploy again. */
    submitDeploySignature: (deploymentId: string, chain: AuthChain) =>
      apiFetch<{ deployment: DclDeployment }>(`/api/deploy/${deploymentId}/signature`, { method: 'POST', body: JSON.stringify({ chain }) }),
    rebaseDclDestination: (id: string) =>
      apiFetch<{ destination: DclDestination }>(`/api/dcl/destinations/${id}/rebase`, { method: 'POST' }),

    // Deployments
    getDeployments: (sceneId: string) =>
      apiFetch<{ deployments: any[] }>(`/api/deploy/scene/${sceneId}`),
    getDeployment: (id: string) =>
      apiFetch<{ deployment: any }>(`/api/deploy/${id}`),
    cancelDeployment: (id: string) =>
      apiFetch<{ deployment: any }>(`/api/deploy/${id}/cancel`, { method: 'POST' }),
    getDeployPlatforms: () => apiFetch<{ platforms: { decentraland: boolean; hyperfy: boolean } }>('/api/deploy/platforms'),

    // Hyperfy HUD pairings
    getHyperfyPairingInfo: (code: string) =>
      apiFetch<{ pairingId: string; worldName: string; sceneId: string; sceneName: string; playerName: string | null }>(`/api/hyperfy/pair/${encodeURIComponent(code)}`),
    approveHyperfyPairing: (code: string) =>
      apiFetch<{ result: 'approved' }>(`/api/hyperfy/pair/${encodeURIComponent(code)}/approve`, { method: 'POST' }),
    getHyperfyPairings: () => apiFetch<{ pairings: HyperfyPairingSummary[] }>('/api/hyperfy/pairings'),
    revokeHyperfyPairing: (id: string) => apiFetch<{ revoked: true }>(`/api/hyperfy/pairings/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // AR headset pairing
    getHeadsetPairingInfo: (code: string) =>
      apiFetch<ArPairApprovalInfo>(`/api/ar/pair/${encodeURIComponent(code)}`),
    approveHeadsetPairing: (code: string, kind: ArDeviceKind) =>
      apiFetch<{ result: string }>(`/api/ar/pair/${encodeURIComponent(code)}/approve`, { method: 'POST', body: JSON.stringify({ kind }) }),
    getHeadsets: () => apiFetch<ArDeviceSummary[]>('/api/ar/devices'),
    revokeHeadset: (id: string) => apiFetch<void>(`/api/ar/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // Hyperfy worlds (self-run and Virvi-hosted)
    getHyperfyWorlds: (sceneId: string) =>
      apiFetch<{ worlds: HyperfyWorldSummary[] }>(`/api/hyperfy/worlds?sceneId=${encodeURIComponent(sceneId)}`),
    createHyperfyWorld: (data: { sceneId: string; name: string }) =>
      apiFetch<{ world: HyperfyWorldSummary; key: string }>('/api/hyperfy/worlds', { method: 'POST', body: JSON.stringify(data) }),
    createHostedHyperfyWorld: (data: { sceneId: string; name: string; endsAt?: string | null }) =>
      apiFetch<{ world: HyperfyWorldSummary; adminCode: string }>('/api/hyperfy/worlds', { method: 'POST', body: JSON.stringify({ ...data, kind: 'hosted' }) }),
    getHyperfySlots: () =>
      apiFetch<{ used: number; limit: number | null; hostingAvailable: boolean }>('/api/hyperfy/slots'),
    /** The display name only: a hosted world's address stays as it is. */
    renameHyperfyWorld: (id: string, name: string) =>
      apiFetch<{ world: HyperfyWorldSummary }>(`/api/hyperfy/worlds/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    setHyperfyWorldEndDate: (id: string, endsAt: string | null) =>
      apiFetch<{ world: HyperfyWorldSummary }>(`/api/hyperfy/worlds/${id}`, { method: 'PATCH', body: JSON.stringify({ endsAt }) }),
    restoreHyperfyWorld: (id: string) =>
      apiFetch<{ world: HyperfyWorldSummary }>(`/api/hyperfy/worlds/${id}/restore`, { method: 'POST' }),
    getHyperfyAdminCode: (id: string) =>
      apiFetch<{ adminCode: string }>(`/api/hyperfy/worlds/${id}/admin-code`, { method: 'POST' }),
    rotateHyperfyWorldKey: (id: string) =>
      apiFetch<{ world: HyperfyWorldSummary; key: string }>(`/api/hyperfy/worlds/${id}/rotate-key`, { method: 'POST' }),
    deleteHyperfyWorld: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/hyperfy/worlds/${id}`, { method: 'DELETE' }),

    // Streaming
    getStreamingServers: () => apiFetch<{ servers: any[] }>('/api/streaming'),
    getStreamingServer: (id: string) => apiFetch<{ server: any }>(`/api/streaming/${id}`),
    provisionStreamingServer: (data: { name: string; type?: 'shared' | 'dedicated'; region?: string; sceneId?: string }) =>
      apiFetch<{ server: any; instructions: any }>('/api/streaming/provision', { method: 'POST', body: JSON.stringify(data) }),
    deleteStreamingServer: (id: string) =>
      apiFetch<{ terminated: boolean }>(`/api/streaming/${id}`, { method: 'DELETE' }),
    getStreamingSessions: (serverId: string) =>
      apiFetch<{ sessions: any[] }>(`/api/streaming/${serverId}/sessions`),

    // 3D Asset Library
    getAssets: (params?: { q?: string; category?: string; tag?: string; style?: string; venue?: string; pack?: string; maxTriangles?: string; maxFileSize?: string; limit?: string; offset?: string }) => {
      const query = new URLSearchParams()
      if (params?.q) query.set('q', params.q)
      if (params?.style) query.set('style', params.style)
      if (params?.venue) query.set('venue', params.venue)
      if (params?.pack) query.set('pack', params.pack)
      if (params?.category) query.set('category', params.category)
      if (params?.tag) query.set('tag', params.tag)
      if (params?.maxTriangles) query.set('maxTriangles', params.maxTriangles)
      if (params?.maxFileSize) query.set('maxFileSize', params.maxFileSize)
      if (params?.limit) query.set('limit', params.limit)
      if (params?.offset) query.set('offset', params.offset)
      const qs = query.toString()
      return apiFetch<{ assets: any[]; total: number; limit: number; offset: number }>(
        `/api/assets${qs ? `?${qs}` : ''}`,
      )
    },
    getAsset: (id: string) => apiFetch<{ asset: any }>(`/api/assets/${id}`),
    getAssetCategories: () => apiFetch<{ categories: string[] }>('/api/assets/categories'),
    // Catalog packs: public list (credits, pack filter); admins switch packs on and off
    getCatalogPacks: () => apiFetch<{ packs: CatalogPack[] }>('/api/catalog/packs'),
    getAdminCatalogPacks: () => apiFetch<{ packs: CatalogPack[] }>('/api/admin/catalog/packs'),
    setCatalogPackEnabled: (id: string, enabled: boolean) =>
      apiFetch<{ pack: CatalogPack }>(`/api/admin/catalog/packs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),

    // Studio flags (admin)
    getAdminStudioFlags: (status: 'open' | 'closed') => apiFetch<{ flags: AdminStudioFlag[] }>(`/api/admin/studio/flags?status=${status}`),
    dismissAdminStudioFlag: (id: string) => apiFetch<void>(`/api/admin/studio/flags/${id}/dismiss`, { method: 'POST' }),
    pauseStudioUser: (userId: string) => apiFetch<void>(`/api/admin/studio/users/${userId}/pause`, { method: 'POST' }),
    resumeStudioUser: (userId: string) => apiFetch<void>(`/api/admin/studio/users/${userId}/pause`, { method: 'DELETE' }),
    createGiftCode: (body: { prompts: number; finalizes: number; maxUses: number; expiresAt?: string | null; note?: string | null }) =>
      apiFetch<{ id: string; code: string }>('/api/admin/studio/gift-codes', { method: 'POST', body: JSON.stringify(body) }),
    listGiftCodes: () => apiFetch<{ codes: AdminGiftCode[] }>('/api/admin/studio/gift-codes'),
    disableGiftCode: (id: string) => apiFetch<void>(`/api/admin/studio/gift-codes/${id}/off`, { method: 'POST' }),
    getAdminStudioReports: () => apiFetch<{ reports: AdminMistakeReport[] }>('/api/admin/studio/reports'),
    approveAdminStudioReport: (id: string) =>
      apiFetch<{ status: 'refunded'; refundCents: number }>(`/api/admin/studio/reports/${id}/approve`, { method: 'POST' }),
    declineAdminStudioReport: (id: string) => apiFetch<void>(`/api/admin/studio/reports/${id}/decline`, { method: 'POST' }),

    // Ads (admin)
    getAdminAdvertiserLeads: () => apiFetch<{ leads: AdminAdvertiserLead[] }>('/api/admin/advertiser-leads'),
    getAdminAds: (review?: 'pending') => apiFetch<{ ads: AdminAd[] }>(`/api/admin/ads${review ? `?review=${review}` : ''}`),
    reviewAdminAd: (id: string, body: { decision: 'approved'; audience: AdAudience } | { decision: 'rejected'; reason: string }) =>
      apiFetch<{ ad: AdminAd }>(`/api/admin/ads/${id}/review`, { method: 'POST', body: JSON.stringify(body) }),
    getAdSpace: (elementId: string) => apiFetch<{ space: OwnerAdSpace }>(`/api/ad-spaces/${encodeURIComponent(elementId)}`),
    setAdSpaceContent: (elementId: string, content: AdContent) =>
      apiFetch<{ space: OwnerAdSpace }>(`/api/ad-spaces/${encodeURIComponent(elementId)}/content`, { method: 'PUT', body: JSON.stringify({ content }) }),
    decideAdSpaceAd: (elementId: string, adId: string, decision: 'approved' | 'declined') =>
      apiFetch<{ space: OwnerAdSpace }>(`/api/ad-spaces/${encodeURIComponent(elementId)}/approvals/${encodeURIComponent(adId)}`, { method: 'PUT', body: JSON.stringify({ decision }) }),
    createAdminAd: (data: { name: string; kind: 'house' | 'partner'; clickUrl: string; startsAt?: string | null; endsAt?: string | null }) =>
      apiFetch<{ ad: AdminAd }>('/api/admin/ads', { method: 'POST', body: JSON.stringify(data) }),
    updateAdminAd: (id: string, data: { name?: string; clickUrl?: string; status?: 'active' | 'paused'; startsAt?: string | null; endsAt?: string | null }) =>
      apiFetch<{ ad: AdminAd }>(`/api/admin/ads/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    addAdminAdCreative: (id: string, mediaAssetId: string, shape: AdShape) =>
      apiFetch<{ creative: AdminAd['creatives'][number] }>(`/api/admin/ads/${id}/creatives`, { method: 'POST', body: JSON.stringify({ mediaAssetId, shape }) }),
    deleteAdminAdCreative: (id: string, creativeId: string) =>
      apiFetch<{ ok: true }>(`/api/admin/ads/${id}/creatives/${creativeId}`, { method: 'DELETE' }),
    setAdminAdPlacements: (id: string, elementIds: string[]) =>
      apiFetch<{ ad: AdminAd }>(`/api/admin/ads/${id}/placements`, { method: 'PUT', body: JSON.stringify({ elementIds }) }),
    getAdminAdSpaces: () => apiFetch<{ spaces: AdminAdSpace[] }>('/api/admin/ads/spaces'),
    getAdminArReports: (status: 'open' | 'resolved' | 'all' = 'open') =>
      apiFetch<{ reports: AdminArReport[] }>(`/api/admin/ar-reports?status=${status}`),
    setAdminArReportStatus: (id: string, status: 'open' | 'resolved') =>
      apiFetch<{ report: { id: string; status: string } }>(`/api/admin/ar-reports/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    getAdminAdReport: (id: string) => apiFetch<AdReport>(`/api/admin/ads/${id}/report`),
    /** Links a model you uploaded, or a catalog model, into a scene's library (no storage used for catalog models). */
    addModelToSceneLibrary: (sceneId: string, assetItemId: string) =>
      apiFetch<{ id: string }>(`/api/scenes/${sceneId}/library`, { method: 'POST', body: JSON.stringify({ assetItemId }) }),
    uploadAsset: (data: {
      name: string
      description?: string
      category?: string
      tags?: string[]
      fileData: string
      contentType: string
      filename: string
      triangleCount?: number
      textureCount?: number
      materialCount?: number
      dimensions?: { width: number; height: number; depth: number }
      license?: string
      author?: string
      isPublic?: boolean
    }) => apiFetch<{ asset: any }>('/api/assets', { method: 'POST', body: JSON.stringify(data) }),
    updateAsset: (id: string, data: Record<string, any>) =>
      apiFetch<{ asset: any }>(`/api/assets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteAsset: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/assets/${id}`, { method: 'DELETE' }),

    // Command Center
    getCommandCenterStatus: (eventId: string) =>
      apiFetch<{ event: any; worlds: any[]; aggregate: { worldCount: number; deployedCount: number } }>(`/api/command-center/${eventId}/status`),
    broadcastToEvent: (eventId: string, data: { action: Record<string, unknown>; targetScenes?: string[] | 'all' }) =>
      apiFetch<{ dispatched: number; sceneIds: string[] }>(`/api/command-center/${eventId}/broadcast`, { method: 'POST', body: JSON.stringify(data) }),

    // Events
    getEvents: () => apiFetch<{ events: any[] }>('/api/events'),
    getEvent: (id: string) => apiFetch<{ event: any }>(`/api/events/${id}`),
    createEvent: (data: { name: string; description?: string; startTime?: string; endTime?: string; timezone?: string }) =>
      apiFetch<{ event: any }>('/api/events', { method: 'POST', body: JSON.stringify(data) }),
    updateEvent: (id: string, data: { name?: string; description?: string; startTime?: string; endTime?: string; timezone?: string }) =>
      apiFetch<{ event: any }>(`/api/events/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteEvent: (id: string) =>
      apiFetch(`/api/events/${id}`, { method: 'DELETE' }),
    linkSceneToEvent: (eventId: string, sceneId: string) =>
      apiFetch<{ link: any }>(`/api/events/${eventId}/link-scene`, { method: 'POST', body: JSON.stringify({ sceneId }) }),
    unlinkSceneFromEvent: (eventId: string, sceneId: string) =>
      apiFetch(`/api/events/${eventId}/unlink-scene/${sceneId}`, { method: 'DELETE' }),
    linkGiveawayToEvent: (eventId: string, giveawayId: string) =>
      apiFetch<{ link: any }>(`/api/events/${eventId}/link-giveaway`, { method: 'POST', body: JSON.stringify({ giveawayId }) }),
    unlinkGiveawayFromEvent: (eventId: string, giveawayId: string) =>
      apiFetch(`/api/events/${eventId}/unlink-giveaway/${giveawayId}`, { method: 'DELETE' }),

    // Design Studio
    getStudioUsage: () => apiFetch<StudioUsage>('/api/studio/usage'),
    getStudioDesigns: (archived = false) => apiFetch<StudioDesign[]>(`/api/studio/designs${archived ? '?archived=true' : ''}`),
    createStudioDesign: (body: { kind: StudioKind; agent: string; name?: string }) =>
      apiFetch<StudioDesign>('/api/studio/designs', { method: 'POST', body: JSON.stringify(body) }),
    getStudioDesign: (id: string) => apiFetch<StudioDetail>(`/api/studio/designs/${id}`),
    updateStudioDesign: (id: string, patch: { name?: string; agent?: string; archived?: boolean }) =>
      apiFetch<StudioDesign>(`/api/studio/designs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    sendStudioPrompt: (id: string, body: { text?: string; selectedSlots?: string[]; continue?: boolean; fixChecks?: boolean }) =>
      apiFetch<{ jobId: string }>(`/api/studio/designs/${id}/prompts`, { method: 'POST', body: JSON.stringify(body) }),
    requestStudioRender: (id: string, body: ({ category: string } & RenderView) | { category: string; bodyShape: 'male' | 'female'; mode: 'orbit' }) =>
      apiFetch<{ status: 'ready'; frames: number; urls: string[] } | { status: 'queued' }>(`/api/studio/designs/${id}/renders`, { method: 'POST', body: JSON.stringify(body) }),
    requestStudioSetRender: (id: string, view: RenderView) =>
      apiFetch<{ status: 'ready'; frames: number; fps: number | null; urls: string[] } | { status: 'queued' }>(`/api/studio/designs/${id}/set-renders`, { method: 'POST', body: JSON.stringify(view) }),
    checkStudioEmote: (id: string, body: { emote: string; bodyShape: 'male' | 'female' }) =>
      apiFetch<void>(`/api/studio/designs/${id}/emote-checks`, { method: 'POST', body: JSON.stringify({ ...body, state: 'fine' }) }),
    reportStudioClipping: (id: string, body: { emote: string; bodyShape: 'male' | 'female'; outfit: string }) =>
      apiFetch<{ jobId: string }>(`/api/studio/designs/${id}/clipping`, { method: 'POST', body: JSON.stringify(body) }),
    requestStudioFinalizeRenders: (id: string) =>
      apiFetch<{ queued: number }>(`/api/studio/designs/${id}/finalize-renders`, { method: 'POST' }),
    getStudioQuote: (id: string) => apiFetch<Quote>(`/api/studio/designs/${id}/finalize`),
    finalizeStudio: (id: string, body: { categories?: string[]; reports?: Record<string, string> }) =>
      apiFetch<{ url: string } | { granted: true; paymentId: string }>(`/api/studio/designs/${id}/finalize`, { method: 'POST', body: JSON.stringify(body) }),
    redeemGiftCode: (code: string) =>
      apiFetch<{ prompts: number; finalizes: number }>('/api/studio/gift-codes/redeem', { method: 'POST', body: JSON.stringify({ code }) }),
    buyStudioPrompts: (packs = 1) => apiFetch<{ url: string }>('/api/studio/topups', { method: 'POST', body: JSON.stringify({ packs }) }),
    reportStudioMistake: (id: string, category: string, n: number, text: string) =>
      apiFetch<{ status: 'refunded'; refundCents: number } | { status: 'in_review' }>(`/api/studio/designs/${id}/pieces/${category}/revisions/${n}/report`, { method: 'POST', body: JSON.stringify({ text }) }),
    retryStudioPackage: (id: string, category: string, n: number) =>
      apiFetch<{ jobId: string }>(`/api/studio/designs/${id}/pieces/${category}/revisions/${n}/package/retry`, { method: 'POST' }),
    /** A file for the agent: the body is the file itself (the server reads its contents to tell its type). */
    uploadStudioFile: async (id: string, file: File): Promise<StudioUpload> => {
      const res = await fetch(`${API_URL}/api/studio/designs/${id}/uploads?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', body: file, headers: { ...requestHeaders(token, {}), 'Content-Type': 'application/octet-stream' },
      })
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      if (!res.ok) {
        dropDeadSession(res.status, body)
        throw Object.assign(new Error(body.error || `API error ${res.status}`), { status: res.status, body })
      }
      return body
    },
    deleteStudioUpload: (id: string, uploadId: string) => apiFetch(`/api/studio/designs/${id}/uploads/${uploadId}`, { method: 'DELETE' }),
    /** An uploaded image's bytes, for its thumbnail (the route needs the bearer header, so no plain <img src>). */
    getStudioUploadBlob: async (id: string, uploadId: string): Promise<Blob> => {
      const res = await fetch(`${API_URL}/api/studio/designs/${id}/uploads/${uploadId}`, { headers: requestHeaders(token, {}) })
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
      return res.blob()
    },
    /** The paid revision's package, through the authenticated route: no package URL is ever put in the page. */
    downloadStudioPackage: async (id: string, category: string, n: number): Promise<{ blob: Blob; filename: string }> => {
      const res = await fetch(`${API_URL}/api/studio/designs/${id}/pieces/${category}/revisions/${n}/package`, { headers: requestHeaders(token, {}) })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        dropDeadSession(res.status, err)
        throw Object.assign(new Error(err.error || `API error ${res.status}`), { status: res.status, body: err })
      }
      const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')
      return { blob: await res.blob(), filename: m?.[1] ?? `${category}-r${n}.zip` }
    },
  }), [apiFetch, token, dropDeadSession])
}
