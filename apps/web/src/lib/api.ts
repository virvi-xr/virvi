'use client'
import { createContext, useCallback, useContext, useMemo } from 'react'
import { useAuth } from './auth'
import { API_URL } from './config'
import type { Plan } from './billing'
import { requestHeaders } from './request-headers'
import { reporter } from './errors/reporter'
import type { ErrorDetail, ErrorSettings, ErrorsOverview, ErrorThresholds } from './errors/admin'
import { accountRequired, openSignUp, readTextRecovering, sendRecovering, type BlockedCtx } from './trial'
import { backupPath } from './backup'
import type { Plot, RoomSetOptions } from '@virvixr/shared'
import type { RoomNudge } from './room-set'
import type { MediaNames } from './media-names'
import type { AuthChain } from '@dcl/crypto'
import type { ParcelGrant, ParcelRevoke } from './parcel-grant'
import type { ArFileFormat, ArMounting } from './ar'
import { adminDesignsQuery, type AdminDesign } from './studio-support'
import type { AdminWallEntry, WallState, AdminManaRefund, AdminManaRefundQuote, AdminManaTransfer, AdminGiftCode, AdminMistakeReport, AdminHelpRequest, AdminStudioFlag, CheckoutMethod, CheckoutResult, Quote, RenderView, StudioDesign, StudioDetail, StudioKind, StudioMember, StudioMessage, StudioSet, StudioUpload, StudioUsage } from './studio'
import type { PromptHelp } from './studio-prompt'
import type { NotificationItem } from './notifications'
import type { InviteLinkView, InviteRole, InviteTarget, MyInvite, PastPackage, StudioInvite } from './studio-people'
import type { AdminIdeaCounts, PromptIdeas } from './studio-ideas'
import type { FirstReplyStats } from './studio-wait'
import type { SceneImportMove, SceneImportView } from '@virvixr/shared'
import type { ArDeviceKind, ArDeviceSummary, ArPairApprovalInfo, ArFloorView, ArMarkerView, ArSpaceView, AdContent, AdAudience, AdminAd, AdminAdSpace, OwnerAdSpace, AdminAdvertiserLead, AdReport, AdShape, CatalogPack, HyperfyPairingSummary, HyperfyWorldSummary } from '@virvixr/shared'
import { overlayDemoApi, type DemoApi } from './demo/store'
import type { DeletePlan, DeletedScene, DeleteResult, Removal, RemovalSignRequest } from './scene-delete'
import type { AnalyticsLocation, AnalyticsRangeQuery, AnalyticsSession, AnalyticsSummary, HeatCell, HeatmapData, LayoutItem, LiveData, TimeseriesPoint } from './analytics/types'
import { ratingsQuery, type AdminLesson, type AdminRating, type Digest, type KindDefaults, type LessonsList, type ratingBody, type ReviewFilters, type StudioRevision } from './studio-ratings'
import type { HostRaffle, RaffleDetail, RaffleSnapshotRow, RaffleWinner, drawBody, editBody, raffleBody } from './raffles'

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
  /** Set for a trial session: it walks the wizard up to Deploy. */
  trial?: true
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
  /** The Virvi scene the World is connected to, as the caller may see it; null when none (absent on older responses). */
  connectedScene?: ConnectedScene | null
}

/**
 * Who holds a World in Virvi: named only for someone with access to that scene, and disconnectable (with the
 * destination to remove) only with full access. Otherwise just "another Virvi account".
 */
export type ConnectedScene =
  | { sceneId: string; name: string; canDisconnect: true; destinationId: string }
  | { sceneId: string; name: string; canDisconnect: false }
  | { name: null; canDisconnect: false }

export type DclDestinationMode = 'virvi' | 'sign'

export interface DclDestination {
  id: string
  /** Absent on older responses: a World. */
  kind?: 'world' | 'parcels'
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
  /** LIV-135: whether Decentraland built a map snapshot for `mapEntityId` (absent on older responses: unknown). */
  mapStatus?: DclMapStatus
  mapEntityId?: string | null
  mapAssets?: number | null
  mapCheckedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type DclMapStatus = 'pending' | 'ready' | 'none' | 'unknown'

/** A model in the scene that the World doesn't have yet. */
export interface DclPendingModel {
  elementId: string
  name: string
  url: string
  file: string
  triangles: number | null
  bytes: number | null
  /** The scene's thumbnail rather than a model (LIV-88); `removed` when it was taken off since the last deploy. */
  kind?: 'thumbnail'
  removed?: true
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
/** An open report of a shared model (LIV-20), as the admin page lists it. */
export type AdminAssetReport = {
  id: string
  reason: string
  details: string | null
  createdAt: string
  asset: { id: string; name: string; thumbnailUrl: string | null; author: string | null; license: string | null }
  owner: { id: string; displayName: string | null; email: string | null } | null
}

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

// Images & Video's rules and messages live with the libraries' wording
export { MEDIA_UPLOAD_RULES, uploadErrorMessage } from './libraries'

/** True if a media asset is a GLB model (old uploads may be stored as octet-stream). */
export function isGlbAsset(asset: { contentType?: string; filename?: string }): boolean {
  return asset.contentType === 'model/gltf-binary' || !!asset.filename?.toLowerCase().endsWith('.glb')
}

/**
 * The Worlds of the session `bearer` belongs to. Deploy uses it right after a trial's wallet sign-in, with the token the
 * sign-in returned: the page's own `api` still holds the trial's until it re-renders.
 */
export async function fetchDclNames(bearer: string): Promise<{ wallets: Array<{ address: string; names: DclWorld[] }> }> {
  const res = await fetch(`${API_URL}/api/dcl/names`, { headers: requestHeaders(bearer, {}) })
  if (res.ok) return res.json()
  const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  throw Object.assign(new Error(err.error || `API error ${res.status}`), { status: res.status, body: err })
}

/**
 * Set by `<DemoApiProvider>` (the guest demos under `/demo/*`): `useApi()` inside it answers from the in-browser demo and
 * refuses everything else, and `useDemoPrefix()` keeps the pages' own links under `/demo`. Null everywhere else.
 */
export const DemoApiContext = createContext<{ api: DemoApi; onRefused: (action: string) => void } | null>(null)

/** `/demo` inside a demo, else ''. Pages that link to themselves (`/events?id=`) put it in front. */
export function useDemoPrefix(): '' | '/demo' {
  return useContext(DemoApiContext) ? '/demo' : ''
}

/** The api `useApi()` returns: the real one's shape, which a demo keeps. */
export type Api = ReturnType<typeof useRealApi>

export function useApi(): Api {
  const real = useRealApi()
  const demo = useContext(DemoApiContext)
  return useMemo(() => (demo ? overlayDemoApi(real, demo.api, demo.onRefused) : real), [real, demo])
}

function useRealApi() {
  const { token, user, logout, renew, swapToStoredAccount } = useAuth()

  /** A kind-less (pre-scene-pass) session, or a scene pass used outside its scope: drop it so the
   *  dashboard layout sends the user to sign-in once (with `next`), instead of showing an error. */
  const dropDeadSession = useCallback((status: number, err: any) => {
    if ((status === 401 && err.message === 'Session expired — sign in again') || (status === 403 && err.error === 'scene_pass_not_allowed')) logout()
  }, [logout])

  /**
   * `userAction`: the call is something the user asked for (a save, deploy, upload or payment), so its failure broke
   * what they were doing and may offer a report (LIV-66 §4). Every other call is background: recorded, never prompted.
   */
  const apiFetch = useCallback(async <T = any>(path: string, options: RequestInit & { signUpCtx?: BlockedCtx; userAction?: boolean } = {}): Promise<T> => {
    const { signUpCtx, userAction, ...init } = options
    const send = async (bearer: string | null) => {
      const started = performance.now()
      const method = init.method ?? 'GET'
      // The access token ran out: renew it with the stored refresh token (or follow the account a trial became) and send once more
      const res = await sendRecovering((b) => fetch(`${API_URL}${path}`, { ...init, headers: requestHeaders(b, init) }), bearer, { swapToStoredAccount, renew })
      const done = { method, path, status: res.status, ms: performance.now() - started, requestId: res.headers.get('x-request-id') }
      if (res.ok) {
        reporter.apiDone({ ...done, ok: true })
        return { res, err: null as any }
      }
      // Non-JSON error bodies (proxy pages, e.g. a 413 from the edge) become `HTTP <status>`.
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      // LIV-66: every non-OK response is recorded, with the error body only (never the request's)
      reporter.apiDone({ ...done, ok: false, body: err, userAction })
      dropDeadSession(res.status, err)
      return { res, err }
    }
    const fail = (res: Response, err: any) => Object.assign(new Error(err.error || `API error ${res.status}`), { status: res.status, body: err })
    let { res, err } = await send(token)
    if (!res.ok && user?.trial) {
      const blocked = accountRequired(fail(res, err))
      if (blocked) {
        // A trial hit an account-only action: ask for a sign-up in the page, then carry on with the new session once
        let fresh: string
        try {
          fresh = await openSignUp({ action: blocked.action, ctx: signUpCtx ?? {} })
        } catch {
          throw fail(res, err)
        }
        ;({ res, err } = await send(fresh))
      }
    }
    if (!res.ok) throw fail(res, err)
    if (res.status === 204) return undefined as T
    return res.json()
  }, [token, user?.trial, dropDeadSession, renew, swapToStoredAccount])

  /** An authenticated file download. A trial refused with `account_required` is asked to sign up, then the download is tried once more. */
  const downloadBlob = useCallback(async (path: string, fallbackName: string, signUpCtx?: BlockedCtx): Promise<{ blob: Blob; filename: string }> => {
    let res = await fetch(`${API_URL}${path}`, { headers: requestHeaders(token, {}) })
    if (!res.ok) {
      let err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      const blocked = user?.trial ? accountRequired({ status: res.status, body: err }) : null
      if (blocked) {
        let fresh: string | null = null
        try { fresh = await openSignUp({ action: blocked.action, ctx: signUpCtx ?? {} }) } catch {}
        if (fresh) {
          res = await fetch(`${API_URL}${path}`, { headers: requestHeaders(fresh, {}) })
          if (!res.ok) err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        }
      }
      if (!res.ok) {
        reporter.apiDone({ method: 'GET', path, status: res.status, ms: 0, requestId: res.headers.get('x-request-id'), ok: false, body: err })
        dropDeadSession(res.status, err)
        throw Object.assign(new Error(err.error || `API error ${res.status}`), { status: res.status, body: err })
      }
    }
    const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')
    return { blob: await res.blob(), filename: m?.[1] ?? fallbackName }
  }, [token, user?.trial, dropDeadSession])

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
      apiFetch<{ scene: any; preset: any }>('/api/scenes', { method: 'POST', userAction: true, body: JSON.stringify({ name, description }) }),
    updateScene: (id: string, data: Record<string, any>) =>
      apiFetch<{ scene: any }>(`/api/scenes/${id}`, { method: 'PUT', userAction: true, body: JSON.stringify(data) }),
    // Deleting a scene (LIV-83): soft delete, Recently deleted, restore, delete forever, removals
    getDeletePlan: (id: string) => apiFetch<DeletePlan>(`/api/scenes/${id}/delete-plan`),
    /** `remove`: ids from the plan's `running` to shut down or remove. */
    deleteScene: (id: string, remove: string[] = [], seen: Record<string, string | null> = {}) =>
      apiFetch<DeleteResult>(`/api/scenes/${id}`, { method: 'DELETE', body: JSON.stringify({ remove, seen }) }),
    getDeletedScenes: () => apiFetch<{ scenes: DeletedScene[] }>('/api/scenes/deleted'),
    restoreScene: (id: string) => apiFetch<{ scene: any; notRestored: Removal[] }>(`/api/scenes/${id}/restore`, { method: 'POST', body: '{}' }),
    /** "Delete forever now": `name` must be the scene's. */
    purgeScene: (id: string, name: string) => apiFetch(`/api/scenes/${id}/purge`, { method: 'POST', body: JSON.stringify({ name }) }),
    /** `confirm`: "Remove anyway" for a removal whose live content changed. */
    retryRemoval: (sceneId: string, removalId: string, confirm = false) =>
      apiFetch<{ removal: Removal }>(`/api/scenes/${sceneId}/removals/${removalId}/retry`, { method: 'POST', body: JSON.stringify(confirm ? { confirm: true } : {}) }),
    getRemovalSign: (sceneId: string, removalId: string) => apiFetch<RemovalSignRequest>(`/api/scenes/${sceneId}/removals/${removalId}/sign`),
    submitRemovalSignature: (sceneId: string, removalId: string, body: { chain: unknown; timestamp?: number }) =>
      apiFetch<{ removal: Removal }>(`/api/scenes/${sceneId}/removals/${removalId}/signature`, { method: 'POST', body: JSON.stringify(body) }),
    /** The scene's thumbnail (LIV-88): the cropped 16:9 PNG or JPEG, base64. */
    setSceneThumbnail: (id: string, fileData: string) =>
      apiFetch<{ scene: any }>(`/api/scenes/${id}/thumbnail`, { method: 'PUT', userAction: true, body: JSON.stringify({ fileData }) }),
    removeSceneThumbnail: (id: string) =>
      apiFetch<{ scene: any }>(`/api/scenes/${id}/thumbnail`, { method: 'DELETE' }),

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

    // Raffles (LIV-55)
    listRaffles: (sceneId: string) => apiFetch<{ raffles: HostRaffle[] }>(`/api/scenes/${sceneId}/raffles`),
    createRaffle: (sceneId: string, body: ReturnType<typeof raffleBody>) =>
      apiFetch<{ raffle: HostRaffle }>(`/api/scenes/${sceneId}/raffles`, { method: 'POST', userAction: true, body: JSON.stringify(body) }),
    getRaffle: (raffleId: string) => apiFetch<RaffleDetail>(`/api/raffles/${raffleId}`),
    raffleAction: (raffleId: string, action: 'open' | 'snapshot' | 'close' | 'cancel') =>
      apiFetch<{ raffle?: HostRaffle; snapshot?: RaffleSnapshotRow }>(`/api/raffles/${raffleId}/${action}`, { method: 'POST', userAction: true }),
    updateRaffle: (raffleId: string, body: ReturnType<typeof editBody>) =>
      apiFetch<{ raffle: HostRaffle }>(`/api/raffles/${raffleId}`, { method: 'PATCH', userAction: true, body: JSON.stringify(body) }),
    drawRaffle: (raffleId: string, body: ReturnType<typeof drawBody> | Record<string, never> = {}) =>
      apiFetch<{ draw: any; winners: RaffleWinner[] }>(`/api/raffles/${raffleId}/draw`, { method: 'POST', userAction: true, body: JSON.stringify(body) }),
    getRaffleDraw: (raffleId: string, drawId: string) => apiFetch<any>(`/api/raffles/${raffleId}/draws/${drawId}`),

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
      apiFetch<{ element: any }>(`/api/presets/${presetId}/elements`, { method: 'POST', userAction: true, body: JSON.stringify(data) }),
    updateElement: (id: string, data: Record<string, any>) =>
      apiFetch<{ element: any }>(`/api/elements/${id}`, { method: 'PUT', userAction: true, body: JSON.stringify(data) }),
    deleteElement: (id: string) =>
      apiFetch(`/api/elements/${id}`, { method: 'DELETE' }),

    // Instances
    createInstance: (elementId: string, data: Record<string, any>) =>
      apiFetch<{ instance: any }>(`/api/elements/${elementId}/instances`, { method: 'POST', userAction: true, body: JSON.stringify(data) }),
    updateInstance: (id: string, data: Record<string, any>) =>
      apiFetch<{ instance: any }>(`/api/instances/${id}`, { method: 'PUT', userAction: true, body: JSON.stringify(data) }),
    deleteInstance: (id: string) =>
      apiFetch(`/api/instances/${id}`, { method: 'DELETE' }),
    deleteElementInstances: (elementId: string) =>
      apiFetch<{ deleted: number }>(`/api/elements/${elementId}/instances`, { method: 'DELETE' }),

    // Media
    getMedia: () => apiFetch<{ assets: any[] }>('/api/media'),
    uploadMedia: (filename: string, contentType: string, data: string) =>
      apiFetch<{ asset: any }>('/api/media/upload', { method: 'POST', userAction: true, body: JSON.stringify({ filename, contentType, data }) }),
    deleteMedia: (assetId: string) =>
      apiFetch(`/api/media/${assetId}`, { method: 'DELETE' }),
    /** Scheduled showings on a video screen (LIV-87). */
    getShowings: (elementId: string) => apiFetch<{ showings: import('./showings').Showing[]; events?: import('./showings').ShowingEvent[] }>(`/api/elements/${elementId}/showings`),
    createShowing: (elementId: string, body: Record<string, unknown>) =>
      apiFetch<{ showing: import('./showings').Showing }>(`/api/elements/${elementId}/showings`, { method: 'POST', body: JSON.stringify(body) }),
    updateShowing: (showingId: string, body: Record<string, unknown>) =>
      apiFetch<{ showing: import('./showings').Showing }>(`/api/showings/${showingId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteShowing: (showingId: string) => apiFetch<void>(`/api/showings/${showingId}`, { method: 'DELETE' }),
    /** Host controls for single shows: delay the next by `minutes`, end the one on now, or play the programme now. */
    controlShowing: (showingId: string, control: 'delay' | 'end' | 'play-now', minutes?: number) =>
      apiFetch<{ showing: import('./showings').Showing }>(`/api/showings/${showingId}/${control}`, { method: 'POST', body: JSON.stringify(control === 'delay' ? { minutes } : {}) }),
    /** Scheduled presets (LIV-86). */
    getPresetSchedules: (sceneId: string) =>
      apiFetch<{ schedules: import('./preset-schedules').PresetSchedule[]; runs: import('./preset-schedules').ScheduleRun[]; status: import('./preset-schedules').LiveStatus; week: import('./preset-schedules').WeekOccurrence[] }>(`/api/scenes/${sceneId}/preset-schedules`),
    createPresetSchedule: (sceneId: string, body: Record<string, unknown>) =>
      apiFetch<{ schedule: import('./preset-schedules').PresetSchedule }>(`/api/scenes/${sceneId}/preset-schedules`, { method: 'POST', body: JSON.stringify(body) }),
    updatePresetSchedule: (scheduleId: string, body: Record<string, unknown>) =>
      apiFetch<{ schedule: import('./preset-schedules').PresetSchedule }>(`/api/preset-schedules/${scheduleId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deletePresetSchedule: (scheduleId: string) => apiFetch<void>(`/api/preset-schedules/${scheduleId}`, { method: 'DELETE' }),
    /** Skip one upcoming run (the next one when `occurrenceStart` is left out). */
    skipPresetScheduleRun: (scheduleId: string, occurrenceStart?: string) =>
      apiFetch<{ skipped: string; schedule: import('./preset-schedules').PresetSchedule }>(`/api/preset-schedules/${scheduleId}/skip`, { method: 'POST', body: JSON.stringify(occurrenceStart ? { occurrenceStart } : {}) }),
    unskipPresetScheduleRun: (scheduleId: string, occurrenceStart: string) =>
      apiFetch<{ schedule: import('./preset-schedules').PresetSchedule }>(`/api/preset-schedules/${scheduleId}/skip?occurrenceStart=${encodeURIComponent(occurrenceStart)}`, { method: 'DELETE' }),
    /** Scene presets (LIV-84): blank, or a copy of `fromPresetId`. */
    createPreset: (sceneId: string, body: { name: string; fromPresetId?: string }) =>
      apiFetch<{ preset: { id: string; name: string } }>(`/api/scenes/${sceneId}/presets`, { method: 'POST', body: JSON.stringify(body) }),
    renamePreset: (presetId: string, name: string) =>
      apiFetch<{ preset: { id: string; name: string } }>(`/api/presets/${presetId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    deletePreset: (presetId: string) => apiFetch<void>(`/api/presets/${presetId}`, { method: 'DELETE' }),
    activatePreset: (presetId: string) =>
      apiFetch<{ activePresetId: string }>(`/api/presets/${presetId}/activate`, { method: 'POST' }),
    /** Self-hosted branding (instance admins). undefined keeps a field, null clears it; images are base64. */
    updateBranding: (body: { name?: string | null; logo?: string | null; favicon?: string | null }) =>
      apiFetch<{ name: string | null; logoUrl: string | null; faviconUrl: string | null }>('/api/instance/branding', { method: 'PUT', userAction: true, body: JSON.stringify(body) }),
    resetBranding: () => apiFetch<void>('/api/instance/branding', { method: 'DELETE' }),
    getSceneStreams: (sceneId: string) =>
      apiFetch<{ streams: import('./streams').SceneStream[] }>(`/api/scenes/${sceneId}/streams`),
    /** Current Images & Video names for media URLs placed in a scene (a playlist stores URLs only). */
    getMediaNames: (sceneId: string, urls: string[]) =>
      apiFetch<MediaNames>(`/api/scenes/${sceneId}/media-names`, { method: 'POST', body: JSON.stringify({ urls }) }),

    // Organizations
    getOrgs: () => apiFetch<{ organizations: import('./orgs').OrgSummary[] }>('/api/orgs'),
    createOrg: (name: string) => apiFetch<{ organization: import('./orgs').OrgSummary }>('/api/orgs', { method: 'POST', body: JSON.stringify({ name }) }),
    getOrgMembers: (orgId: string) => apiFetch<{ members: import('./orgs').OrgMember[] }>(`/api/orgs/${orgId}/members`),
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
    getAnalyticsHeatmap: async (id: string, q: AnalyticsRangeQuery): Promise<HeatmapData> => {
      const r = await apiFetch<{ cells: HeatCell[]; heatmap3d?: boolean }>(`/api/analytics/locations/${id}/heatmap?${new URLSearchParams({ ...q })}`)
      return { cells: r.cells, heatmap3d: r.heatmap3d === true }
    },
    getAnalyticsLayout: (id: string) => apiFetch<{ layout: { items: LayoutItem[] } | null }>(`/api/analytics/locations/${id}/layout`),
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
      apiFetch<{ user: any }>('/api/auth/profile', { method: 'PUT', userAction: true, body: JSON.stringify({ displayName }) }),
    changePassword: (currentPassword: string, newPassword: string) =>
      apiFetch<{ success: boolean }>('/api/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),
    deleteAccount: (password: string) =>
      apiFetch('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) }),

    // Admin
    getAdminStats: () => apiFetch<{
      totalUsers: number; trialGuests?: number; totalOrgs: number; totalScenes: number;
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
    getBillingPlans: () => apiFetch<{ billingEnabled: boolean; plans: Plan[] }>('/api/billing/plans'),
    createCheckout: (tier: 'creator' | 'pro' | 'studio') => apiFetch<{ url: string }>('/api/billing/checkout', { method: 'POST', userAction: true, body: JSON.stringify({ tier }) }),
    getPortalUrl: () => apiFetch<{ url: string }>('/api/billing/portal', { method: 'POST', body: JSON.stringify({}) }),

    // New Scene Wizard
    getWizardCatalog: () => apiFetch<WizardCatalog>('/api/wizard/catalog'),
    getWizardOptions: () => apiFetch<WizardOptions>('/api/wizard/options'),
    /** 400 (incl. `unmeasured_asset`, `invalid_plot`), 403 `scene_limit_reached`, 422 `over_budget` ({ message, triangles, limit } on err.body). */
    /** The wizard's save. A trial is asked to sign up first; `ctx.sceneName` names the scene on the sheet. */
    bootstrapWizardScene: (data: WizardSceneBody, signUpCtx?: BlockedCtx) =>
      apiFetch<{ sceneId: string }>('/api/wizard/scenes', { method: 'POST', body: JSON.stringify(data), signUpCtx }),

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
    /** Pass `plot` (and `spawn`) to build a new scene there, or omit both to adopt the live scene. 409 `world_in_use` carries `sceneId` and `connectedScene`. */
    createDclDestination: (data: { sceneId: string; world: string; mode: DclDestinationMode; plot?: Plot; spawn?: { x: number; z: number } }) =>
      apiFetch<{ destination: DclDestination; replaces?: { parcels: string[] } }>('/api/dcl/destinations', { method: 'POST', userAction: true, body: JSON.stringify(data) }),
    /** The scene's World destinations, and Worlds set up in-world for it (Creator Hub `@virvixr/dcl` scenes) it can adopt. */
    getSceneDclDestinations: (sceneId: string) =>
      apiFetch<{ destinations: DclDestination[]; adoptable: Array<{ world: string }> }>(`/api/scenes/${sceneId}/dcl/destinations`),
    /**
     * Disconnects the World from its scene: nothing changes in Decentraland. `grantKept`: Virvi still holds the owner's
     * deploy permission there (`message` says how to remove it). 409 `deploy_in_progress`, 409 `not_a_world`, 403 without full access.
     */
    disconnectDclDestination: (id: string) =>
      apiFetch<{ world: string; sceneId: string; grantKept: boolean; message?: string }>(`/api/dcl/destinations/${id}`, { method: 'DELETE' }),
    getDclDestination: (id: string) =>
      apiFetch<{
        destination: DclDestination; kind: 'world' | 'parcels'; parcels: string[]
        /** Wallets that may sign this destination's deploys; null when Decentraland couldn't be reached. */
        signers: string[] | null
        pending: DclPendingModel[]; refused: Array<{ name: string; reason: string }>; lastDeployment: DclDeployment | null; warning?: string | null
      }>(`/api/dcl/destinations/${id}`),
    /** Genesis City parcels: whether Virvi may be made an operator, and the owner's transactions that do it. */
    getParcelGrant: (id: string) => apiFetch<ParcelGrant>(`/api/dcl/destinations/${id}/parcel-grant`),
    /** Reads the rights fresh. 409 `aetheria_managed`. */
    checkParcelGrant: (id: string) =>
      apiFetch<{ granted: true } | { granted: false; missing: string }>(`/api/dcl/destinations/${id}/parcel-grant/check`, { method: 'POST' }),
    getParcelRevoke: (id: string) => apiFetch<ParcelRevoke>(`/api/dcl/destinations/${id}/parcel-grant/revoke`),
    checkParcelRevoke: (id: string) =>
      apiFetch<{ revoked: boolean; still?: string }>(`/api/dcl/destinations/${id}/parcel-grant/revoke/check`, { method: 'POST' }),
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
      apiFetch<{ deployment: DclDeployment; payload?: string; expiresAt?: string }>(`/api/dcl/destinations/${id}/deploy`, { method: 'POST', userAction: true }),
    /** 409 `expired`: prepare the deploy again. */
    submitDeploySignature: (deploymentId: string, chain: AuthChain) =>
      apiFetch<{ deployment: DclDeployment }>(`/api/deploy/${deploymentId}/signature`, { method: 'POST', userAction: true, body: JSON.stringify({ chain }) }),
    rebaseDclDestination: (id: string) =>
      apiFetch<{ destination: DclDestination }>(`/api/dcl/destinations/${id}/rebase`, { method: 'POST' }),

    // Scene imports (a Creator Hub or SDK7 scene built and deployed by Virvi)
    /** The scene zip as the raw body. Errors carry `{ error, message, importId? }` (the import made, for its build log). */
    uploadSceneImport: (zip: Blob) =>
      apiFetch<{ import: SceneImportView }>('/api/imports', { method: 'POST', userAction: true, body: zip, headers: { 'Content-Type': 'application/zip' } }),
    getSceneImport: (id: string) => apiFetch<{ import: SceneImportView }>(`/api/imports/${id}`),
    /** The caller's own last 10 imports, any scene, newest first. */
    listMySceneImports: () => apiFetch<{ imports: SceneImportView[] }>('/api/imports'),
    /** The whole build log, as text. */
    getSceneImportLog: (id: string): Promise<string> =>
      readTextRecovering((b) => fetch(`${API_URL}/api/imports/${id}/log`, { headers: requestHeaders(b, {}) }), token, { swapToStoredAccount, renew }, dropDeadSession),
    /** 200 with the `payload` to sign (then `submitDeploySignature`), or 202 with just the deployment: Virvi deploys. */
    deploySceneImport: (id: string) =>
      apiFetch<{ deployment: DclDeployment; payload?: string; expiresAt?: string; usesScene?: SceneImportMove }>(`/api/imports/${id}/deploy`, { method: 'POST', userAction: true }),
    /** What a World deployment put live, as a zip: through the authenticated route, never a plain link. */
    downloadDeployFiles: async (deploymentId: string): Promise<{ blob: Blob; filename: string }> => {
      const res = await fetch(`${API_URL}/api/deploy/${deploymentId}/files.zip`, { headers: requestHeaders(token, {}) })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        dropDeadSession(res.status, err)
        throw Object.assign(new Error(err.error || `API error ${res.status}`), { status: res.status, body: err })
      }
      const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')
      return { blob: await res.blob(), filename: m?.[1] ?? `deploy-${deploymentId}.zip` }
    },

    /** A scene's Virvi-free Decentraland project as a zip, placed at `destinationId` when Virvi built it (errors: `backup_too_big`, `not_decentraland`, `backup_busy`, `backup_timeout`, `destination_not_found`). */
    downloadSceneBackup: async (sceneId: string, destinationId?: string): Promise<{ blob: Blob; filename: string }> => {
      const res = await fetch(`${API_URL}${backupPath(sceneId, destinationId)}`, { headers: requestHeaders(token, {}) })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        dropDeadSession(res.status, err)
        throw Object.assign(new Error(err.error || `API error ${res.status}`), { status: res.status, body: err })
      }
      const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')
      return { blob: await res.blob(), filename: m?.[1] ?? `scene-${sceneId}-backup.zip` }
    },

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

    // 3D Models (the asset library)
    getAssets: (params?: { q?: string; category?: string; tag?: string; style?: string; venue?: string; pack?: string; mine?: string; scope?: string; maxTriangles?: string; maxFileSize?: string; limit?: string; offset?: string }) => {
      const query = new URLSearchParams()
      if (params?.q) query.set('q', params.q)
      if (params?.mine) query.set('mine', params.mine)
      if (params?.scope) query.set('scope', params.scope)
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
    // Errors (admin, LIV-66)
    getAdminErrors: () => apiFetch<ErrorsOverview>('/api/admin/errors'),
    /** "Re-open for filing": forget a Linear issue closed without a fix, so the data can file it again. */
    reopenAdminErrorForFiling: (id: string) =>
      apiFetch<{ id: string; reopened: true }>(`/api/admin/errors/${id}`, { method: 'PATCH', body: JSON.stringify({ reopenForFiling: true }) }),
    /** A report's screenshot (admin; the route needs the bearer, so it is fetched, never linked). */
    getAdminErrorScreenshot: (reportId: string) => downloadBlob(`/api/admin/errors/reports/${reportId}/screenshot`, 'screenshot'),
    // "Ask me about errors" (accounts; guests and trials keep theirs in the browser)
    getErrorPromptSettings: () => apiFetch<{ askAboutErrors: boolean }>('/api/errors/prompt-settings'),
    setErrorPromptSettings: (askAboutErrors: boolean) =>
      apiFetch<{ askAboutErrors: boolean }>('/api/errors/prompt-settings', { method: 'PUT', body: JSON.stringify({ askAboutErrors }) }),
    getAdminError: (id: string, days = 7) => apiFetch<ErrorDetail>(`/api/admin/errors/${id}?days=${days}`),
    setAdminErrorResolved: (id: string, resolved: boolean) =>
      apiFetch<{ id: string; resolvedAt: string | null }>(`/api/admin/errors/${id}`, { method: 'PATCH', body: JSON.stringify({ resolved }) }),
    getAdminErrorSettings: () => apiFetch<ErrorSettings>('/api/admin/error-settings'),
    saveAdminErrorSettings: (change: Partial<ErrorThresholds>) =>
      apiFetch<{ thresholds: ErrorThresholds }>('/api/admin/error-settings', { method: 'PUT', body: JSON.stringify(change) }),
    setCatalogPackEnabled: (id: string, enabled: boolean) =>
      apiFetch<{ pack: CatalogPack }>(`/api/admin/catalog/packs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),

    // Everyone's designs (admin: Virvi support opens them on the design page)
    getAdminStudioDesigns: (query: { q?: string; kind?: string; cursor?: string | null } = {}) =>
      apiFetch<{ designs: AdminDesign[]; nextCursor: string | null }>(`/api/admin/studio/designs${adminDesignsQuery(query)}`),
    // Ratings (admin, LIV-142): the 👎 queue, the weekly digest, lessons for the agent and the default agent per kind
    getAdminStudioRatings: (f: ReviewFilters = {}) => apiFetch<{ ratings: AdminRating[]; nextCursor: string | null }>(`/api/admin/studio/ratings${ratingsQuery(f)}`),
    markAdminStudioRating: (id: string, change: { handled?: boolean; autoCheck?: boolean }) =>
      apiFetch<{ id: string; handledAt: string | null; autoCheck: boolean }>(`/api/admin/studio/ratings/${id}`, { method: 'PATCH', body: JSON.stringify(change) }),
    getAdminStudioDigest: (week?: string) => apiFetch<Digest>(`/api/admin/studio/digest${week ? `?week=${week}` : ''}`),
    getAdminStudioLessons: () => apiFetch<LessonsList>('/api/admin/studio/lessons'),
    createAdminStudioLesson: (body: { kind: string; text: string; sourceRatingIds?: string[] }) =>
      apiFetch<AdminLesson>('/api/admin/studio/lessons', { method: 'POST', body: JSON.stringify(body) }),
    draftAdminStudioLesson: (ratingIds: string[]) =>
      apiFetch<AdminLesson>('/api/admin/studio/lessons/draft', { method: 'POST', body: JSON.stringify({ ratingIds }) }),
    updateAdminStudioLesson: (id: string, change: { text?: string; enabled?: boolean; status?: 'approved' }) =>
      apiFetch<AdminLesson>(`/api/admin/studio/lessons/${id}`, { method: 'PATCH', body: JSON.stringify(change) }),
    deleteAdminStudioLesson: (id: string) => apiFetch<void>(`/api/admin/studio/lessons/${id}`, { method: 'DELETE' }),
    getAdminStudioDefaults: () => apiFetch<KindDefaults>('/api/admin/studio/defaults'),
    getAdminStudioIdeas: () => apiFetch<AdminIdeaCounts>('/api/admin/studio/ideas'),
    getAdminStudioFirstReply: () => apiFetch<FirstReplyStats>('/api/admin/studio/first-reply'),
    setAdminStudioDefault: (kind: string, agent: string) =>
      apiFetch<{ defaults: KindDefaults['defaults'] }>(`/api/admin/studio/defaults/${kind}`, { method: 'PUT', body: JSON.stringify({ agent }) }),
    // Studio flags (admin)
    getAdminStudioFlags: (status: 'open' | 'closed') => apiFetch<{ flags: AdminStudioFlag[] }>(`/api/admin/studio/flags?status=${status}`),
    dismissAdminStudioFlag: (id: string) => apiFetch<void>(`/api/admin/studio/flags/${id}/dismiss`, { method: 'POST' }),
    pauseStudioUser: (userId: string) => apiFetch<void>(`/api/admin/studio/users/${userId}/pause`, { method: 'POST' }),
    resumeStudioUser: (userId: string) => apiFetch<void>(`/api/admin/studio/users/${userId}/pause`, { method: 'DELETE' }),
    createGiftCode: (body: { prompts: number; finalizes: number; maxUses: number; expiresAt?: string | null; note?: string | null }) =>
      apiFetch<{ id: string; code: string }>('/api/admin/studio/gift-codes', { method: 'POST', body: JSON.stringify(body) }),
    listGiftCodes: () => apiFetch<{ codes: AdminGiftCode[] }>('/api/admin/studio/gift-codes'),
    disableGiftCode: (id: string) => apiFetch<void>(`/api/admin/studio/gift-codes/${id}/off`, { method: 'POST' }),
    getAdminStudioHelp: () => apiFetch<{ requests: AdminHelpRequest[] }>('/api/admin/studio/help'),
    resolveAdminStudioHelp: (id: string) => apiFetch<void>(`/api/admin/studio/help/${id}/resolve`, { method: 'POST' }),
    getAdminStudioReports: () => apiFetch<{ reports: AdminMistakeReport[] }>('/api/admin/studio/reports'),
    approveAdminStudioReport: (id: string) =>
      apiFetch<{ status: 'refunded'; refundCents: number; creditedCents: number; manaCents: number }>(`/api/admin/studio/reports/${id}/approve`, { method: 'POST' }),
    declineAdminStudioReport: (id: string) => apiFetch<void>(`/api/admin/studio/reports/${id}/decline`, { method: 'POST' }),

    // MANA the owner sends back, and transfers that matched no payment (admin)
    getAdminManaRefunds: () => apiFetch<{ refunds: AdminManaRefund[] }>('/api/admin/studio/mana-refunds?status=requested'),
    getAdminManaRefundQuote: (id: string) => apiFetch<AdminManaRefundQuote>(`/api/admin/studio/mana-refunds/${id}/quote`),
    markAdminManaRefundSent: (id: string, txHash: string, amountWei: string) =>
      apiFetch<unknown>(`/api/admin/studio/mana-refunds/${id}/sent`, { method: 'POST', body: JSON.stringify({ txHash, amountWei }) }),
    declineAdminManaRefund: (id: string) => apiFetch<unknown>(`/api/admin/studio/mana-refunds/${id}/decline`, { method: 'POST' }),
    getAdminManaTransfers: () => apiFetch<{ transfers: AdminManaTransfer[] }>('/api/admin/studio/mana-transfers?status=unmatched'),
    settleAdminManaTransfer: (txHash: string, logIndex: number, paymentId: string) =>
      apiFetch<unknown>(`/api/admin/studio/mana-transfers/${txHash}/${logIndex}/settle`, { method: 'POST', body: JSON.stringify({ paymentId }) }),
    returnAdminManaTransfer: (txHash: string, logIndex: number, returnTxHash: string) =>
      apiFetch<unknown>(`/api/admin/studio/mana-transfers/${txHash}/${logIndex}/returned`, { method: 'POST', body: JSON.stringify({ returnTxHash }) }),

    // The wall of fame (admin)
    getAdminStudioWall: () => apiFetch<{ entries: AdminWallEntry[] }>('/api/admin/studio/wall'),
    hideAdminStudioWallEntry: (designId: string, hidden: boolean) =>
      apiFetch<{ hidden: boolean }>(`/api/admin/studio/wall/${designId}/hide`, { method: 'POST', body: JSON.stringify({ hidden }) }),

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
      author?: string
    }) => apiFetch<{ asset: any }>('/api/assets', { method: 'POST', userAction: true, body: JSON.stringify(data) }),
    // Sharing (LIV-20): public and its license change only here
    shareAsset: (id: string, data: { license: string; rightsConfirmed: boolean; credit?: string }) =>
      apiFetch<{ asset: any }>(`/api/assets/${id}/share`, { method: 'POST', userAction: true, body: JSON.stringify(data) }),
    unshareAsset: (id: string) =>
      apiFetch<{ asset: any }>(`/api/assets/${id}/unshare`, { method: 'POST', userAction: true }),
    reportAsset: (id: string, data: { reason: string; details?: string }) =>
      apiFetch<{ reported: boolean }>(`/api/assets/${id}/report`, { method: 'POST', userAction: true, body: JSON.stringify(data) }),
    getAdminAssetReports: () => apiFetch<{ reports: AdminAssetReport[] }>('/api/admin/asset-reports'),
    dismissAdminAssetReport: (id: string) =>
      apiFetch<{ dismissed: boolean }>(`/api/admin/asset-reports/${id}/dismiss`, { method: 'POST' }),
    takeDownAsset: (id: string, reason: string) =>
      apiFetch<{ takenDown: boolean }>(`/api/admin/assets/${id}/takedown`, { method: 'POST', body: JSON.stringify({ reason }) }),
    updateAsset: (id: string, data: Record<string, any>) =>
      apiFetch<{ asset: any }>(`/api/assets/${id}`, { method: 'PUT', userAction: true, body: JSON.stringify(data) }),
    deleteAsset: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/assets/${id}`, { method: 'DELETE' }),

    // Command Center
    getCommandCenterStatus: (eventId: string) =>
      apiFetch<{ event: any; worlds: any[]; aggregate: { worldCount: number; deployedCount: number } }>(`/api/command-center/${eventId}/status`),
    broadcastToEvent: (eventId: string, data: { action: Record<string, unknown>; targetScenes?: string[] | 'all' }) =>
      apiFetch<{ dispatched: number; sceneIds: string[] }>(`/api/command-center/${eventId}/broadcast`, { method: 'POST', body: JSON.stringify(data) }),

    // Events
    getEvents: () => apiFetch<{ events: any[] }>('/api/events'),
    getEvent: (id: string) => apiFetch<{ event: any; presetSchedules?: import('./event-presets').EventPresetSchedule[]; scenePresets?: import('./event-presets').ScenePresetOption[]; showings?: import('./event-presets').EventShowing[] }>(`/api/events/${id}`),
    createEvent: (data: { name: string; description?: string; startTime?: string; endTime?: string; timezone?: string }) =>
      apiFetch<{ event: any }>('/api/events', { method: 'POST', userAction: true, body: JSON.stringify(data) }),
    updateEvent: (id: string, data: { name?: string; description?: string; startTime?: string; endTime?: string; timezone?: string }) =>
      apiFetch<{ event: any }>(`/api/events/${id}`, { method: 'PUT', userAction: true, body: JSON.stringify(data) }),
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
    // 👍 / 👎 on a revision (LIV-142), and a 👎's free try-again
    rateStudioRevision: (id: string, jobId: string, body: ReturnType<typeof ratingBody>) =>
      apiFetch<StudioRevision>(`/api/studio/designs/${id}/revisions/${jobId}/rating`, { method: 'PUT', body: JSON.stringify(body) }),
    clearStudioRating: (id: string, jobId: string) => apiFetch<void>(`/api/studio/designs/${id}/revisions/${jobId}/rating`, { method: 'DELETE' }),
    tryStudioRevisionAgain: (id: string, jobId: string) =>
      apiFetch<{ jobId: string }>(`/api/studio/designs/${id}/revisions/${jobId}/try-again`, { method: 'POST' }),
    getStudioDefaults: () => apiFetch<{ agents: Record<StudioKind, string | null> }>('/api/studio/defaults'),
    updateStudioDesign: (id: string, patch: { name?: string; agent?: string; archived?: boolean }) =>
      apiFetch<StudioDesign>(`/api/studio/designs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    setStudioWall: (id: string, body: { shown: boolean; marketplaceUrl?: string | null }) =>
      apiFetch<WallState>(`/api/studio/designs/${id}/wall`, { method: 'PUT', body: JSON.stringify(body) }),
    // "Improve my prompt": a rewrite of the draft, never sent to the agent
    studioPromptHelp: (id: string, body: { text: string; selectedSlots?: string[]; answers?: Record<string, string> }) =>
      apiFetch<PromptHelp>(`/api/studio/designs/${id}/prompt-help`, { method: 'POST', body: JSON.stringify(body) }),
    // Starting the design's machine while the person writes a prompt: always 204, fire and forget
    warmStudioDesign: (id: string) => apiFetch<void>(`/api/studio/designs/${id}/warm`, { method: 'POST' }),
    /** `query`: ideaParams (studio-ideas.ts). */
    studioPromptIdeas: (id: string, query: string) => apiFetch<PromptIdeas>(`/api/studio/designs/${id}/prompt-ideas?${query}`),
    sendStudioPrompt: (id: string, body: { text?: string; selectedSlots?: string[]; continue?: boolean; fixChecks?: boolean; ideaId?: string }) =>
      apiFetch<{ jobId: string }>(`/api/studio/designs/${id}/prompts`, { method: 'POST', userAction: true, body: JSON.stringify(body) }),
    /** Virvi support's note to the people on a design: starts no agent (support only). */
    askStudioHelp: (id: string, text: string) =>
      apiFetch<{ help: { id: string } }>(`/api/studio/designs/${id}/help`, { method: 'POST', userAction: true, body: JSON.stringify({ text }) }),
    sendStudioSupportNote: (id: string, text: string) =>
      apiFetch<{ message: StudioMessage }>(`/api/studio/designs/${id}/support-notes`, { method: 'POST', userAction: true, body: JSON.stringify({ text }) }),
    requestStudioRender: (id: string, body: ({ category: string } & RenderView) | { category: string; bodyShape: 'male' | 'female'; mode: 'orbit' }
      | { category: string; mode: 'orbit' | 'scale' }) =>
      apiFetch<{ status: 'ready'; frames: number; urls: string[] } | { status: 'queued' }>(`/api/studio/designs/${id}/renders`, { method: 'POST', body: JSON.stringify(body) }),
    /**
     * An emote view with every piece worn (or, with `categories`, Finalize's selection and the finalized pieces); a
     * scene design's walk-through takes no view.
     */
    requestStudioSetRender: (id: string, view?: RenderView, categories: string[] | null = null) =>
      apiFetch<{ status: 'ready'; frames: number; fps: number | null; urls: string[] } | { status: 'queued' }>(`/api/studio/designs/${id}/set-renders`, { method: 'POST', body: JSON.stringify({ ...view, ...(categories ? { categories } : {}) }) }),
    /** A set view's frames when rendered already, never asking for a render (what a viewer may read, LIV-159). */
    getStudioSetFrames: (id: string, view?: RenderView, categories: string[] | null = null) => {
      const q = new URLSearchParams()
      if (view) {
        q.set('bodyShape', view.bodyShape)
        q.set('outfit', view.outfit)
        if (view.emote) q.set('emote', view.emote)
      }
      if (categories?.length) q.set('categories', categories.join(','))
      const qs = q.toString()
      return apiFetch<{ status: 'ready'; frames: number; fps: number | null; urls: string[] } | { status: string }>(`/api/studio/designs/${id}/set-frames${qs ? `?${qs}` : ''}`)
    },
    checkStudioEmote: (id: string, body: { emote: string; bodyShape: 'male' | 'female' }, categories: string[] | null = null) =>
      apiFetch<void>(`/api/studio/designs/${id}/emote-checks`, { method: 'POST', body: JSON.stringify({ ...body, state: 'fine', ...(categories ? { categories } : {}) }) }),
    reportStudioClipping: (id: string, body: { emote: string; bodyShape: 'male' | 'female'; outfit: string }, categories: string[] | null = null) =>
      apiFetch<{ jobId: string }>(`/api/studio/designs/${id}/clipping`, { method: 'POST', body: JSON.stringify({ ...body, ...(categories ? { categories } : {}) }) }),
    requestStudioFinalizeRenders: (id: string, categories: string[] | null = null) =>
      apiFetch<{ queued: number }>(`/api/studio/designs/${id}/finalize-renders`, categories ? { method: 'POST', body: JSON.stringify({ categories }) } : { method: 'POST' }),
    /** The emote step for Finalize's selection: the chosen and finalized pieces worn together. */
    getStudioSet: (id: string, categories: string[]) =>
      apiFetch<StudioSet>(`/api/studio/designs/${id}/set?categories=${categories.join(',')}`),
    /** The finalize quote: every payable piece, or only `categories`, priced by the server. */
    getStudioQuote: (id: string, categories: string[] | null = null) =>
      apiFetch<Quote>(`/api/studio/designs/${id}/finalize${categories?.length ? `?categories=${categories.join(',')}` : ''}`),
    finalizeStudio: (id: string, body: { categories?: string[]; reports?: Record<string, string>; method: CheckoutMethod }, signUpCtx?: BlockedCtx) =>
      apiFetch<CheckoutResult>(`/api/studio/designs/${id}/finalize`, { method: 'POST', userAction: true, body: JSON.stringify(body), signUpCtx }),
    redeemGiftCode: (code: string) =>
      apiFetch<{ prompts: number; finalizes: number }>('/api/studio/gift-codes/redeem', { method: 'POST', body: JSON.stringify({ code }) }),
    buyStudioPrompts: (packs: number, method: CheckoutMethod, signUpCtx?: BlockedCtx) =>
      apiFetch<CheckoutResult>('/api/studio/topups', { method: 'POST', body: JSON.stringify({ packs, method }), signUpCtx }),
    // MANA: report the transaction that pays a quote, then poll the payment until Polygon confirms it
    reportStudioManaTx: (paymentId: string, txHash: string) =>
      apiFetch<{ status: 'granted' | 'confirming' }>(`/api/studio/payments/${paymentId}/mana-tx`, { method: 'POST', body: JSON.stringify({ txHash }) }),
    getStudioPayment: (paymentId: string) =>
      apiFetch<{ status: 'pending' | 'paid' | 'expired' | string; method: string; expiresAt: string | null; manaTxHash: string | null }>(`/api/studio/payments/${paymentId}`),
    requestStudioManaRefund: (reportId: string) =>
      apiFetch<{ id: string; status: 'requested'; usdCents: number }>('/api/studio/mana-refunds', { method: 'POST', body: JSON.stringify({ reportId }) }),
    reportStudioMistake: (id: string, category: string, n: number, text: string) =>
      apiFetch<{ status: 'refunded'; refundCents: number; creditedCents: number; manaCents: number } | { status: 'in_review' }>(`/api/studio/designs/${id}/pieces/${category}/revisions/${n}/report`, { method: 'POST', body: JSON.stringify({ text }) }),
    retryStudioPackage: (id: string, category: string, n: number, signUpCtx?: BlockedCtx) =>
      apiFetch<{ jobId: string }>(`/api/studio/designs/${id}/pieces/${category}/revisions/${n}/package/retry`, { method: 'POST', signUpCtx }),
    /** A file for the agent: the body is the file itself (the server reads its contents to tell its type). */
    uploadStudioFile: async (id: string, file: File, signUpCtx?: BlockedCtx): Promise<StudioUpload> => {
      const send = async (bearer: string | null) => {
        const res = await fetch(`${API_URL}/api/studio/designs/${id}/uploads?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', body: file, headers: { ...requestHeaders(bearer, {}), 'Content-Type': 'application/octet-stream' },
        })
        return { res, body: await res.json().catch(() => ({ error: `HTTP ${res.status}` })) }
      }
      let { res, body } = await send(token)
      // The access token ran out: renew it (or follow a trial converted in another tab) and send once more
      if (res.status === 401 && token) {
        const fresh = body.error === 'trial_ended' ? swapToStoredAccount(token) : await renew()
        if (fresh) ({ res, body } = await send(fresh))
      }
      // A trial at its upload limit: ask for a sign-up in the page, then upload once more with the new session
      const blocked = !res.ok && user?.trial ? accountRequired({ status: res.status, body }) : null
      if (blocked) {
        let fresh: string | null = null
        try { fresh = await openSignUp({ action: blocked.action, ctx: signUpCtx ?? {} }) } catch {}
        if (fresh) ({ res, body } = await send(fresh))
      }
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
    downloadStudioPackage: async (id: string, category: string, n: number, signUpCtx?: BlockedCtx): Promise<{ blob: Blob; filename: string }> =>
      downloadBlob(`/api/studio/designs/${id}/pieces/${category}/revisions/${n}/package`, `${category}-r${n}.zip`, signUpCtx),
    /** Every piece's newest ready package in one zip ("Download all"), through the same kind of authenticated route. */
    downloadStudioPackages: (id: string, signUpCtx?: BlockedCtx): Promise<{ blob: Blob; filename: string }> =>
      downloadBlob(`/api/studio/designs/${id}/packages`, 'design.zip', signUpCtx),
    // Sharing a design (LIV-159): its people and invites, my invites, and packages kept from designs I've left
    /** `invites` (with their links) for the owner alone. */
    getStudioPeople: (id: string) => apiFetch<{ members: StudioMember[]; invites?: StudioInvite[] }>(`/api/studio/designs/${id}/people`),
    inviteToStudioDesign: (id: string, to: InviteTarget, role: InviteRole) =>
      apiFetch<{ invite: StudioInvite }>(`/api/studio/designs/${id}/invites`, { method: 'POST', body: JSON.stringify({ ...to, role }) }),
    cancelStudioInvite: (id: string, inviteId: string) => apiFetch<void>(`/api/studio/designs/${id}/invites/${inviteId}/cancel`, { method: 'POST' }),
    resendStudioInvite: (id: string, inviteId: string) =>
      apiFetch<{ invite: StudioInvite }>(`/api/studio/designs/${id}/invites/${inviteId}/resend`, { method: 'POST' }),
    setStudioMemberRole: (id: string, userId: string, role: InviteRole) =>
      apiFetch<{ userId: string; role: InviteRole }>(`/api/studio/designs/${id}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    /** The owner removing someone, or a member leaving (their own id). */
    removeStudioMember: (id: string, userId: string) => apiFetch<void>(`/api/studio/designs/${id}/members/${userId}`, { method: 'DELETE' }),
    // The bell (LIV-159): my notifications; `before` is the last item's updatedAt
    getNotifications: (before?: string) =>
      apiFetch<{ items: NotificationItem[]; more: boolean }>(`/api/notifications?limit=20${before ? `&before=${encodeURIComponent(before)}` : ''}`),
    getUnreadNotifications: () => apiFetch<{ count: number }>('/api/notifications/unread-count'),
    markNotificationRead: (id: string) => apiFetch<void>(`/api/notifications/${id}/read`, { method: 'POST' }),
    markAllNotificationsRead: () => apiFetch<void>('/api/notifications/read-all', { method: 'POST' }),
    getMyStudioInvites: () => apiFetch<MyInvite[]>('/api/studio/invites'),
    acceptStudioInvite: (inviteId: string) =>
      apiFetch<{ designId: string; role: InviteRole }>(`/api/studio/invites/${inviteId}/accept`, { method: 'POST' }),
    declineStudioInvite: (inviteId: string) => apiFetch<void>(`/api/studio/invites/${inviteId}/decline`, { method: 'POST' }),
    getStudioInviteLink: (token: string) => apiFetch<InviteLinkView>(`/api/studio/invite-links/${token}`),
    acceptStudioInviteLink: (token: string) =>
      apiFetch<{ designId: string; role: InviteRole }>(`/api/studio/invite-links/${token}/accept`, { method: 'POST' }),
    getStudioPastPackages: () => apiFetch<PastPackage[]>('/api/studio/past-packages'),
    downloadStudioPastPackage: (entitlementId: string): Promise<{ blob: Blob; filename: string }> =>
      downloadBlob(`/api/studio/past-packages/${entitlementId}/package`, 'package.zip'),
  }), [apiFetch, downloadBlob, token, user?.trial, dropDeadSession, renew, swapToStoredAccount])
}
