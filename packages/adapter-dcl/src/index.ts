import { Virvi, resolveApiUrl, analyticsUrlFor, handoffUrlFor, dashboardOriginFor, hudStatus, applyLibraryChange, placedMessage } from '@virvixr/core'
import { VirviHttpClient } from '@virvixr/client'
import type { SetupStatus, SceneLibraryItem } from '@virvixr/client'
import type { VirviConnectionState } from '@virvixr/core'
import { engine, Transform } from '@dcl/sdk/ecs'
import { DclAdapter } from './DclAdapter'
import { startVirviAnalytics, getAnalyticsSceneRef } from './analytics.js'
import { DclHUDRenderer, setSceneActionHandler } from './DclHUDRenderer.js'
import { DclEditMode } from './transform/edit-mode.js'
import { friendlyEditError, friendlyRenameError, editBlockedMessage, createReconnector, DISCONNECTED } from './edit-errors.js'
import { applyPresetsChange, friendlyPresetError, presetsFromScene, type HUDPreset } from './presets.js'
import { offImageChoices, screensFromPreset, withLiveSource, withOffImage, type HUDStream } from './streams.js'
import type { HUDMediaItem } from './DclHUDRenderer.js'
import { toLayoutItem, withCopies, clearedMessage, type HUDLayoutItem } from './layout.js'
import { locationKeyFor } from '@virvixr/shared'
import type { VirviInitConfig, VirviStorage } from '@virvixr/shared'

// Setup-status re-checks while Decentraland's directory is unavailable (~2.5 min).
const OWNER_CHECK_BACKOFF_MS = [10_000, 20_000, 40_000, 80_000]

// Same wording as the dashboard's Roles tab (apps/web SceneRoles.tsx).
const ROLE_ERRORS: Record<string, string> = {
  Forbidden: 'Only the host and co-hosts can manage roles.',
  is_host: 'That wallet is the host.',
  not_a_signed_in_cohost: 'They need to sign in to Virvi with that wallet before they can become host.',
  host_has_no_wallet: 'Link your wallet in Settings before transferring host.',
}

/** Map a @virvixr/client error (`HTTP 409: {"error":"is_host"}`) to text for the Roles panel. */
function friendlyRoleError(err: unknown): string {
  const m = /^HTTP \d+: ([\s\S]*)$/.exec(err instanceof Error ? err.message : String(err))
  if (m) {
    try {
      const code = (JSON.parse(m[1]) as { error?: unknown })?.error
      if (typeof code === 'string' && ROLE_ERRORS[code]) return ROLE_ERRORS[code]
    } catch {
      // not JSON
    }
  }
  return 'Something went wrong — try again'
}

const PLACEABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const LAYOUT_TYPES = new Set(['image', 'video', 'model', 'sound', 'ad_space'])

/** Images (rendered live) and GLBs (rendered after `npx @virvixr/dcl sync` + redeploy) can be placed from the HUD. */
function mediaKind(a: SceneLibraryItem): 'image' | 'model' | null {
  // In-flight and failed uploads have no url yet but still show (with their status)
  if (!a.url && a.status === 'ready') return null
  if (a.kind === 'model') return 'model'
  if (a.contentType && PLACEABLE_IMAGE_TYPES.has(a.contentType)) return 'image'
  if (a.contentType === 'model/gltf-binary' || /\.glb$/i.test(a.name)) return 'model'
  return null
}

/** HUD rows for the library: placeable kinds only, each with its status (needs sync = placed but not deployed). */
function toHUDMedia(items: SceneLibraryItem[], missingSrcs: string[]): HUDMediaItem[] {
  const missing = new Set(missingSrcs)
  return items.flatMap((a): HUDMediaItem[] => {
    const kind = mediaKind(a)
    if (!kind) return []
    const status = hudStatus(a, kind === 'model', missing)
    return [{ id: a.id, name: a.name, kind, status, ...(status === 'failed' && a.error ? { error: a.error } : {}) }]
  })
}


/**
 * Where a placed item goes: 2 m in front of the player on the XZ plane, turned to face them (to the nearest 90°).
 * SDK7 Transforms of root scene entities and of the player are both relative to the scene's base
 * parcel (the analytics probe relies on the same), so this is already the scene-local space that
 * Virvi instance positions use (the adapter's setTransform applies them as-is).
 */
function placementInFrontOfPlayer(kind: 'image' | 'model') {
  const t = Transform.getOrNull(engine.PlayerEntity)
  const p = t?.position ?? { x: 8, y: 0.9, z: 8 }
  const q = t?.rotation ?? { x: 0, y: 0, z: 0, w: 1 }
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
  // Turned to face the player, squared up to the nearest 90° so placed items line up with the scene and each other
  const yawDeg = Math.round((yaw * 180) / Math.PI / 90) * 90
  const round = (n: number) => Math.round(n * 100) / 100
  // The player's Transform is about 0.9 m above their feet
  const feet = Math.max(0, p.y - 0.9)
  return {
    position: {
      x: round(p.x + Math.sin(yaw) * 2),
      y: round(kind === 'image' ? feet + 1.2 : feet),
      z: round(p.z + Math.cos(yaw) * 2),
    },
    rotation: { x: 0, y: round((((yawDeg + 180) % 360) + 360) % 360), z: 0 },
    scale: kind === 'image' ? { x: 2, y: 2, z: 1 } : { x: 1, y: 1, z: 1 },
  }
}

/**
 * Create a Virvi instance for Decentraland SDK 7.
 *
 * If sceneId is provided, authenticates and connects to that scene directly.
 * If not, asks the Virvi server what the signed-in wallet gets at this location:
 * - a member of this location's setup (host / co-host / editor / viewer) connects straight to its scene;
 * - an owner, operator or deployer of the land with no setup yet gets a one-press "Set up Virvi here" card;
 * - everyone else (visitors, guests, wallets without a role) gets no Virvi UI at all, but still
 *   connects content-only when the location is set up, so they see its images, video and models.
 */
export async function createVirvi(config?: Partial<VirviInitConfig> & { enableHud?: boolean }): Promise<Virvi> {
  const adapter = new DclAdapter()
  const virvi = new Virvi(adapter)
  if (config?.analytics !== false) {
    // Analytics start once per scene runtime; every createVirvi call (retries included) attaches the shared collector.
    void startVirviAnalytics({ env: config?.env, apiUrl: config?.apiUrl, adapter }).then((c) => {
      if (c) virvi.attachAnalytics(c)
    })
  }
  const enableHud = config?.enableHud !== false

  // The HUD is created lazily: visitors never get one (see the eligibility check below)
  let renderer = null as DclHUDRenderer | null
  const ensureRenderer = (): DclHUDRenderer | null => {
    if (renderer || !enableHud) return renderer
    try {
      const r = new DclHUDRenderer()
      r.init()
      r.updateConnectionState('idle')
      virvi.onStateChange((state: VirviConnectionState, detail?: Record<string, unknown>) => {
        r.updateConnectionState(state, detail)
      })
      // Models not deployed with the scene yet; always the latest count (an upsert can emit 0 then 1)
      r.setMissingModels(virvi.missingModels())
      virvi.onModelsMissing((n) => r.setMissingModels(n))
      renderer = r
    } catch (err) {
      console.warn('[Virvi] HUD initialization failed:', err)
    }
    return renderer
  }

  // initHUD runs once per virvi, after the first successful connect (which may be a Retry)
  // (shared promise, so a Retry racing an in-flight connect can't initialise it twice)
  let hudInit: Promise<void> | null = null
  const ensureHUD = async () => {
    if (!renderer) return
    if (!hudInit) {
      hudInit = virvi.initHUD(renderer).catch((err) => {
        hudInit = null
        throw err
      })
    }
    await hudInit
  }

  // Stats tab: signs the browser in as this wallet via a single-use hand-off code, created only on the press and never logged.
  // Any failure to create it (guest, unverified, rate limit, network) opens the plain dashboard link instead.
  // When the dashboard origin can't be derived from the API URL, no code is minted: it would go to the virvi.io fallback.
  const openAnalytics = (sceneId: string): void => {
    const apiUrl = resolveApiUrl(config ?? {})
    const next = `/analytics/?scene=${encodeURIComponent(sceneId)}`
    const swallow = () => {}
    const openPlain = () => { void Promise.resolve(adapter.openUrl(analyticsUrlFor(apiUrl, sceneId))).catch(swallow) }
    if (!dashboardOriginFor(apiUrl)) return openPlain()
    virvi.httpClient.createHandoff().then(
      ({ code }) => {
        const url = handoffUrlFor(apiUrl, code, next)
        if (!url) return openPlain()
        void Promise.resolve(adapter.openUrl(url)).catch(swallow)
      },
      openPlain,
    )
  }

  // If sceneId is provided, do the full init in one shot
  if (config?.sceneId) {
    ensureRenderer()
    try {
      await virvi.init({ env: 'prod', ...config })

      if (renderer) {
        renderer.setCurrentScene(config.sceneId, 'Scene')
        await ensureHUD()
        // Only the Stats tab is wired on this path; other actions (roles, media, retry) were never available here
        setSceneActionHandler((action: string) => {
          if (action === 'open_analytics') openAnalytics(config.sceneId!)
        })
      }

      console.log('[Virvi] Connected to scene:', config.sceneId)
      // Edit rights come from the setup at this location, not from config.sceneId: say so instead of failing silently.
      if (virvi.binding?.sceneId !== config.sceneId) {
        console.warn(`[Virvi] Scene ${config.sceneId} is not set up at this location, so it shows content only. Set up Virvi at this location to edit it in-world.`)
        renderer?.showNotification({
          id: `virvi-binding-${Date.now()}`,
          type: 'warning',
          title: 'Set up Virvi at this location to edit',
          message: 'This scene is not set up here, so in-world editing is off.',
          timestamp: Date.now(),
        })
      }
      return virvi
    } catch (err) {
      if (renderer) {
        renderer.updateConnectionState('error', { error: String(err) })
      }
      throw err
    }
  }

  // No sceneId: ask the server what this wallet gets here (nothing / Set up / member of the setup).
  // Visitors, role-less wallets and wallets that can't set up here never get any Virvi UI.
  // createVirvi never blocks the creator's scene code: it resolves right after the first status probe,
  // and connecting, setup and directory retries all continue in the background.
  type SceneRole = 'host' | 'cohost' | 'editor' | 'viewer'
  try {
    const sceneRef = await getAnalyticsSceneRef()
    const user = await adapter.getPlatformUser()
    const probe = new VirviHttpClient(resolveApiUrl(config ?? {}))

    // Visitors (role-less wallets and guests) at a set-up location: join the scene room for its
    // content only — no renderer, no HUD; failures are only logged. Platform auth gives guests a
    // guest session, which the room accepts as an analytics/content client.
    let contentStarted = false
    const connectContentOnly = (sceneId: string) => {
      if (contentStarted) return
      contentStarted = true
      void (async () => {
        await virvi.authenticate({ env: 'prod', ...config })
        await virvi.connectToScene(sceneId)
        console.log('[Virvi] Showing Virvi content for scene', sceneId)
      })().catch((err) => console.log('[Virvi] Virvi content unavailable:', String(err)))
    }

    if (user.isGuest) {
      // Guests can't sign requests, so look the scene up by location (previews are never set up publicly)
      if (!sceneRef.isPreview) {
        void probe
          .getSceneForLocation(locationKeyFor(sceneRef, null))
          .then((sceneId) => { if (sceneId) connectContentOnly(sceneId) })
          .catch((err) => console.log('[Virvi] Virvi content unavailable:', String(err)))
      }
      return virvi
    }

    const reconnect = async (sceneId: string) => {
      try {
        renderer?.updateConnectionState('connecting', { sceneId })
        await virvi.connectToScene(sceneId)
        // A failed first connect never reached initHUD; do it now so the HUD isn't left dead after Retry
        await ensureHUD()
      } catch (err) {
        renderer?.updateConnectionState('error', { error: String(err) })
      }
    }

    // In-world transform tools: one edit mode per Virvi, only for members who can edit (HUD actions drive it)
    let editMode: DclEditMode | null = null
    // Live library + missing-model subscriptions of the current connected handler (replaced on reinstall)
    let offLibrary: (() => void)[] = []
    // The scene room is up: false from a drop until a (re)connect finishes. Edits wait for it.
    let roomUp = false
    virvi.onStateChange((state) => {
      if (state === 'connected') roomUp = true
      else if (state === 'connecting' || state === 'error' || state === 'idle') roomUp = false
    })
    virvi.events.on('connection_lost', () => { roomUp = false })

    // Scene actions once connected: 'retry' for everyone; roles management for host and co-hosts;
    // placing media and showing / hiding / deleting elements for host, co-hosts and editors
    // (the server enforces the same; the scene room's upsert/delete broadcast renders the result)
    const installConnectedHandler = (configuredSceneId: string, role: SceneRole) => {
      // A scene pass is only valid for the scene the server bound it to; prefer that over the configured id
      const sceneId = virvi.binding?.sceneId ?? configuredSceneId
      let currentRole: SceneRole = role
      const managesRoles = () => currentRole === 'host' || currentRole === 'cohost'
      const edits = () => currentRole !== 'viewer'
      const ensureEditMode = () => {
        if (edits() && !editMode) editMode = new DclEditMode(virvi, adapter)
        if (editMode) {
          const em = editMode
          em.onChange = () => renderer?.setEditMode(em.state)
        }
      }
      ensureEditMode()
      let busy = false
      let media: SceneLibraryItem[] = []
      let layout: HUDLayoutItem[] = []
      let presets: HUDPreset[] = []
      const refreshPresets = async () => {
        const { scene } = await virvi.httpClient.getScene(sceneId)
        const got = presetsFromScene(scene as any)
        presets = got.list
        renderer?.setPresets(presets, got.activeId)
        renderer?.setPresetsError(null)
      }

      const refresh = async () => {
        try {
          const data = await virvi.httpClient.getSceneRoles(sceneId)
          renderer?.setRoles({ hostWallets: data.host.wallets, roles: data.roles })
          renderer?.setRolesError(null)
        } catch (err) {
          renderer?.setRolesError(friendlyRoleError(err))
        }
      }

      // Ask the server for this wallet's role here again (it may have changed since joining, e.g. promoted to
      // editor, or across a reconnect). Only a member answer for this scene counts: getSetupStatus reads any
      // failure as "none", so anything else keeps the current role (the server still refuses what it must).
      const refreshRole = async () => {
        const status = await probe.getSetupStatus(sceneRef, adapter)
        if (status.state !== 'member' || (status.sceneId !== configuredSceneId && status.sceneId !== sceneId)) return
        if (status.role === currentRole) return
        currentRole = status.role
        renderer?.setSceneRole(currentRole)
        ensureEditMode()
        if (managesRoles()) void refresh()
      }

      // A dropped room rejoins on its own (backoff); the role is fetched again once it's back
      const reconnector = createReconnector({
        connect: async () => {
          await virvi.connectToScene(sceneId)
          await ensureHUD()
        },
        onReconnected: async () => {
          renderer?.setEditMessage(null)
          await refreshRole()
        },
        onFailed: () => renderer?.updateConnectionState('error', { error: DISCONNECTED }),
        schedule: (fn, ms) => {
          const t = setTimeout(fn, ms)
          return () => clearTimeout(t)
        },
      })
      const onConnectionLost = () => {
        renderer?.setEditMessage(DISCONNECTED, true)
        reconnector.lost()
      }
      const connected = () => roomUp
      const pushMedia = () => renderer?.setMedia(toHUDMedia(media, virvi.missingModelSrcs()))
      const refreshMedia = async () => {
        const { items } = await virvi.httpClient.getSceneLibrary(sceneId)
        media = items
        pushMedia()
      }
      // Uploads (from this computer, a phone, or another editor) arrive live; a model's sync state follows placing and redeploys
      for (const off of offLibrary) off()
      offLibrary = [
        virvi.onLibraryChanged((change) => {
          if (!edits()) return
          media = applyLibraryChange(media, change)
          pushMedia()
        }),
        virvi.onModelsMissing(() => { if (edits() && media.length) pushMedia() }),
        // Presets made, renamed or deleted elsewhere, and the live one switching (dashboard, schedule, booking)
        virvi.onPresetsChanged((change) => {
          if (!edits()) return
          presets = applyPresetsChange(presets, change)
          renderer?.setPresets(presets)
        }),
        virvi.onActivePresetChanged((id) => {
          renderer?.setActivePreset(id)
          if (edits() && !presets.some((p) => p.id === id)) void refreshPresets().catch(() => {})
        }),
        () => virvi.events.off('connection_lost', onConnectionLost),
        () => reconnector.stop(),
      ]
      virvi.events.on('connection_lost', onConnectionLost)
      // Upload link: minted on the press, kept only while the Upload view is open
      let uploadUrl: string | null = null
      const mintUploadLink = async () => {
        uploadUrl = null
        renderer?.setUploadView({ open: true, loading: true, error: null, token: null })
        try {
          const { token } = await virvi.httpClient.createUploadToken(sceneId, { kinds: ['image', 'model'] })
          uploadUrl = token.uploadUrl
          renderer?.setUploadView({ loading: false, token })
        } catch {
          renderer?.setUploadView({ loading: false, error: "Couldn't make an upload link — try again" })
        }
      }
      const activePreset = async () => {
        const { scene } = await virvi.httpClient.getScene(sceneId)
        return scene.presets?.find((p) => p.id === scene.activePresetId) ?? null
      }
      // Stream panel (LIV-53): the live preset's screens and the streams they can play
      let streams: HUDStream[] = []
      const refreshStreams = async () => {
        // The scene library's images are the off image choices (LIV-54); without them the stream controls still work
        const [preset, got, library] = await Promise.all([activePreset(), virvi.httpClient.getSceneStreams(sceneId), virvi.httpClient.getSceneLibrary(sceneId).catch(() => ({ items: [] }))])
        streams = got.streams
        renderer?.setStreams(screensFromPreset(preset), streams, offImageChoices(library.items))
        return preset
      }
      const refreshLayout = async () => {
        const preset = await activePreset()
        layout = (preset?.elements ?? []).filter((el: any) => LAYOUT_TYPES.has(el.type)).map((el: any) => toLayoutItem(el))
        renderer?.setLayout(layout)
      }
      let publishUrl: string | null = null // the Publish action's target, set when a model is placed
      const place = async (assetId: string) => {
        let asset = media.find((a) => a.id === assetId)
        if (!asset) {
          await refreshMedia()
          asset = media.find((a) => a.id === assetId)
        }
        const kind = asset ? mediaKind(asset) : null
        if (!asset || !kind) {
          renderer?.setEditMessage('That file is no longer in the scene library', true)
          return
        }
        if (asset.status !== 'ready') {
          renderer?.setEditMessage("That file isn't ready yet", true)
          return
        }
        const scene = (await virvi.httpClient.getScene(sceneId)).scene
        if (!scene.activePresetId) {
          renderer?.setEditMessage('This scene has no active preset — pick one on the dashboard', true)
          return
        }
        const where = placementInFrontOfPlayer(kind)
        const { element } = await virvi.httpClient.createElement(scene.activePresetId, {
          type: kind,
          name: asset.name,
          enabled: true,
          properties: kind === 'image' ? { textureSrc: asset.url } : { modelSrc: asset.url },
        })
        try {
          await virvi.httpClient.createInstance(element.id, { ...where, enabled: true })
        } catch (err) {
          // Don't leave an element with no instance behind (best effort)
          await virvi.httpClient.deleteElement(element.id).catch(() => {})
          throw err
        }
        layout = [...layout.filter((el) => el.id !== element.id), { ...toLayoutItem(element), copies: 1 }]
        renderer?.setLayout(layout)
        if (kind === 'image') {
          renderer?.setEditMessage(`Placed ${asset.name}`)
          return
        }
        // What happens next depends on the scene's World destination; a failed lookup reads as "none"
        const destination = await virvi.httpClient.getDclPublishStatus(sceneId).then((r) => r.destination, () => null)
        const next = placedMessage(asset.name, destination)
        publishUrl = next.publish && destination ? destination.publishUrl : null
        if (publishUrl) renderer?.setEditMessage(next.text, false, { label: 'Publish', action: 'open_publish' })
        else renderer?.setEditMessage(next.text)
      }

      setSceneActionHandler(async (action: string, data?: any) => {
        if (action === 'open_analytics') return openAnalytics(sceneId)
        if (action === 'open_publish') {
          if (publishUrl) void Promise.resolve(adapter.openUrl(publishUrl)).catch(() => {})
          return
        }

        if (action === 'retry') {
          // A manual Retry replaces any pending automatic one; the role is fetched again once connected
          reconnector.stop()
          await reconnect(sceneId)
          if (virvi.connectionState === 'connected') await refreshRole().catch(() => {})
          return
        }

        if (action.startsWith('edit_')) {
          if (!edits() || !editMode) return
          if (action === 'edit_enter') editMode.enter()
          if (action === 'edit_exit') editMode.exit() // dirty: shows the Save / Revert prompt instead
          if (action === 'edit_mode' && ['move', 'rotate', 'resize'].includes(data?.mode)) editMode.setMode(data.mode)
          // Answering the Done prompt completes, then leaves edit mode (DclEditMode.exitAfterPrompt)
          if (action === 'edit_save') editMode.save()
          if (action === 'edit_revert') editMode.revert()
          if (action === 'edit_value' && ['x', 'y', 'z'].includes(data?.axis) && typeof data?.value === 'number') {
            editMode.setValue(data.axis, data.value)
          }
          return
        }

        if (action.startsWith('roles_')) {
          if (!managesRoles() || busy) return
          busy = true
          try {
            if (action === 'roles_refresh') await refresh()
            if (action === 'roles_add') {
              await virvi.httpClient.addSceneRole(sceneId, data.wallet, data.role)
              renderer?.clearRoleDraft()
              await refresh()
            }
            if (action === 'roles_remove') { await virvi.httpClient.removeSceneRole(sceneId, data.wallet); await refresh() }
            if (action === 'roles_transfer' && currentRole === 'host') {
              await virvi.httpClient.transferHost(sceneId, data.wallet)
              currentRole = 'cohost'
              renderer?.setSceneRole('cohost')
              await refresh()
            }
          } catch (err) {
            renderer?.setRolesError(friendlyRoleError(err))
          } finally {
            busy = false
          }
          return
        }

        if (action.startsWith('media_upload_')) {
          if (!edits()) return
          if (action === 'media_upload_open' || action === 'media_upload_new') return mintUploadLink()
          if (action === 'media_upload_back') {
            uploadUrl = null
            return renderer?.setUploadView({ open: false, loading: false, error: null, token: null })
          }
          if (action === 'media_upload_computer' && uploadUrl) {
            void Promise.resolve(adapter.openUrl(uploadUrl)).catch(() => {})
          }
          return
        }

        if (action === 'media_rename') {
          if (!edits() || busy) return
          busy = true
          try {
            const { item } = await virvi.httpClient.renameSceneLibraryItem(sceneId, String(data?.assetId), String(data?.name ?? ''))
            media = applyLibraryChange(media, { action: 'upsert', item })
            pushMedia()
            renderer?.setRenaming(null)
          } catch (err) {
            renderer?.setEditMessage(friendlyRenameError(err, { connected: connected() }), true)
          } finally {
            busy = false
          }
          return
        }

        if (action === 'media_dismiss') {
          if (!edits()) return
          try {
            await virvi.httpClient.removeFromSceneLibrary(sceneId, String(data?.assetId))
            media = media.filter((a) => a.id !== String(data?.assetId))
            pushMedia()
          } catch (err) {
            renderer?.setEditMessage(friendlyEditError(err, { connected: connected() }), true)
          }
          return
        }

        // Presets (LIV-84): host, co-hosts and editors; the server refuses everyone else (and booking crew)
        if (action.startsWith('presets_')) {
          if (!edits()) return
          if (action === 'presets_refresh') {
            try { await refreshPresets() } catch (err) { renderer?.setPresetsError(friendlyPresetError(err, { connected: connected() })) }
            return
          }
          if (busy) return
          busy = true
          renderer?.setPresetBusy(true)
          try {
            if (action === 'presets_activate') {
              const { activePresetId } = await virvi.httpClient.activatePreset(String(data?.presetId))
              renderer?.setActivePreset(activePresetId)
            }
            if (action === 'presets_create') {
              const { preset } = await virvi.httpClient.createPreset(sceneId, String(data?.name ?? ''), data?.copyOf ? String(data.copyOf) : undefined)
              presets = applyPresetsChange(presets, { action: 'upsert', preset })
              renderer?.setPresets(presets)
            }
            if (action === 'presets_rename') {
              const { preset } = await virvi.httpClient.renamePreset(String(data?.presetId), String(data?.name ?? ''))
              presets = applyPresetsChange(presets, { action: 'upsert', preset })
              renderer?.setPresets(presets)
            }
            renderer?.presetDone()
          } catch (err) {
            renderer?.setPresetsError(friendlyPresetError(err, { connected: connected() }))
          } finally {
            busy = false
            renderer?.setPresetBusy(false)
          }
          return
        }

        // Stream panel (LIV-53): host, co-hosts and editors; the server refuses everyone else
        if (action.startsWith('streams_')) {
          if (!edits()) return
          if (action === 'streams_refresh') {
            try { await refreshStreams() } catch (err) { renderer?.setStreamsError(friendlyEditError(err, { connected: connected() })) }
            return
          }
          if (busy) return
          busy = true
          renderer?.setStreamBusy(true)
          try {
            const blocked = await editBlockedMessage({ connected: connected(), canEdit: edits, refreshRole })
            if (blocked) return renderer?.setStreamsError(blocked)
            const elementId = String(data?.elementId)
            if (action === 'streams_choose') {
              const stream = streams.find((s) => s.id === String(data?.streamId))
              const preset = await activePreset()
              const element = preset?.elements?.find((el: any) => el.id === elementId)
              if (!stream || !element) throw new Error('HTTP 404: {"error":"Not found"}')
              await virvi.httpClient.updateElement(elementId, { properties: withLiveSource(element.properties, stream.hlsPlaylistUrl) })
              renderer?.streamChosen()
            }
            if (action === 'streams_off_image') {
              const url = typeof data?.url === 'string' ? data.url : ''
              const preset = await activePreset()
              const element = preset?.elements?.find((el: any) => el.id === elementId)
              if (!element) throw new Error('HTTP 404: {"error":"Not found"}')
              await virvi.httpClient.updateElement(elementId, { properties: withOffImage(element.properties, url) })
              renderer?.streamChosen()
            }
            if (action === 'streams_live') await virvi.httpClient.setElementLive(elementId, data?.enabled === true)
            await refreshStreams()
          } catch (err) {
            renderer?.setStreamsError(friendlyEditError(err, { connected: connected() }))
          } finally {
            busy = false
            renderer?.setStreamBusy(false)
          }
          return
        }

        // Read-only lists: everyone sees the layout; the media library is only fetched for editors.
        // Refreshes don't take the busy lock, so opening a panel mid-edit still loads it.
        if (action === 'layout_refresh' || action === 'media_refresh') {
          if (action === 'media_refresh' && !edits()) return
          try {
            if (action === 'layout_refresh') await refreshLayout()
            else await refreshMedia()
          } catch (err) {
            renderer?.setLoadFailed(action === 'layout_refresh' ? 'layout' : 'media')
            renderer?.setEditMessage(friendlyEditError(err, { connected: connected() }), true)
          }
          return
        }

        if (action !== 'media_place' && action !== 'layout_toggle' && action !== 'layout_delete' && action !== 'layout_clear') return
        if (busy) return
        busy = true
        try {
          // Disconnected, or a role that still says viewer after fetching it again (never a server answer)
          const blocked = await editBlockedMessage({ connected: connected(), canEdit: edits, refreshRole })
          if (blocked) {
            renderer?.setEditMessage(blocked, true)
            return
          }
          renderer?.setEditMessage(null)
          if (action === 'media_place') await place(String(data?.assetId))
          if (action === 'layout_toggle') {
            const { element } = await virvi.httpClient.updateElement(String(data?.elementId), { enabled: !!data?.enabled })
            layout = layout.map((el) => (el.id === element.id ? toLayoutItem(element, el) : el))
            renderer?.setLayout(layout)
          }
          if (action === 'layout_delete') {
            const id = String(data?.elementId)
            await virvi.httpClient.deleteElement(id)
            layout = layout.filter((el) => el.id !== id)
            renderer?.setLayout(layout)
          }
          if (action === 'layout_clear') {
            // Every copy of one element goes; the element stays (the dashboard's Delete all, LIV-12)
            const id = String(data?.elementId)
            const { deleted } = await virvi.httpClient.deleteElementInstances(id)
            const name = layout.find((el) => el.id === id)?.name ?? ''
            layout = withCopies(layout, id, 0)
            renderer?.setLayout(layout)
            renderer?.setEditMessage(clearedMessage(name, deleted))
          }
        } catch (err) {
          renderer?.setEditMessage(friendlyEditError(err, { connected: connected() }), true)
        } finally {
          busy = false
        }
      })
      if (managesRoles()) void refresh()
    }

    const connectAs = async (sceneId: string, role: SceneRole): Promise<void> => {
      await virvi.authenticate({ env: 'prod', ...config })
      ensureRenderer()
      renderer?.setSceneRole(role)
      renderer?.updateConnectionState('connecting', { sceneId })
      renderer?.setCurrentScene(sceneId, sceneRef.title || 'Scene')
      // Installed before connecting so the error screen's Retry works even if this first connect fails
      if (renderer) installConnectedHandler(sceneId, role)
      await virvi.connectToScene(sceneId)
      await ensureHUD()
      console.log('[Virvi] Connected to scene as', role, sceneId)
    }

    const connectInBackground = (sceneId: string, role: SceneRole) => {
      void connectAs(sceneId, role).catch((err) => {
        if (renderer) renderer.updateConnectionState('error', { error: String(err) })
        else console.log('[Virvi] Setup unavailable:', String(err))
      })
    }

    const offerSetup = () => {
      ensureRenderer()
      if (!renderer) return
      renderer.showSetupOffer()
      let busy = false
      // Set once the server has created the setup, so a failed connect retries the connect, not the setup
      let createdSceneId: string | null = null
      const onSetupAction = async (action: string) => {
        if (action !== 'setup_here' || busy) return
        busy = true
        try {
          renderer?.updateConnectionState('connecting')
          if (!createdSceneId) {
            const res = await probe.setUpHere(sceneRef, adapter)
            if (!('sceneId' in res)) {
              const msg =
                res.error === 'already_set_up' ? `Already set up by ${res.host ?? 'someone else'}`
                : res.status === 503 ? "Decentraland's servers aren't answering — try again in a minute"
                : res.status === 403 ? "Only this land's owner, operators or deployer can set up Virvi here"
                : `Setup failed (${res.error})`
              renderer?.showSetupOffer(msg)
              return
            }
            createdSceneId = res.sceneId
          }
          await connectAs(createdSceneId, 'host')
        } catch (err) {
          // connectAs may already have swapped in the connected handler; the card needs setup_here back
          setSceneActionHandler(onSetupAction)
          renderer?.showSetupOffer(
            createdSceneId
              ? `Virvi is set up, but connecting failed (${String(err)}) — press again to retry`
              : 'Setup failed — try again',
          )
        } finally {
          busy = false
        }
      }
      setSceneActionHandler(onSetupAction)
    }

    // Act on a status answer; true when it was final (no directory retry needed)
    const act = (status: SetupStatus): boolean => {
      if (status.state === 'member') connectInBackground(status.sceneId, status.role)
      else if (status.state === 'eligible') offerSetup()
      else if (status.state === 'unavailable') return false
      else if (status.state === 'taken') console.log(`[Virvi] Analytics running; Virvi here is already set up by ${status.host}`)
      else console.log("[Virvi] Analytics running; Virvi setup is only offered to this land's owners, operators and deployer")
      // Not a member, but the location is set up: show its content (no HUD)
      if ((status.state === 'taken' || status.state === 'none') && status.sceneId) connectContentOnly(status.sceneId)
      return true
    }

    if (!act(await probe.getSetupStatus(sceneRef, adapter))) {
      console.log("[Virvi] Analytics running; Decentraland's servers aren't answering, will re-check Virvi setup in the background")
      void (async () => {
        for (const delay of OWNER_CHECK_BACKOFF_MS) {
          await new Promise((r) => setTimeout(r, delay))
          if (act(await probe.getSetupStatus(sceneRef, adapter))) return
        }
        console.log('[Virvi] Virvi setup check gave up; Decentraland is still unavailable')
      })().catch((err) => console.log('[Virvi] Setup unavailable:', String(err)))
    }
    return virvi
  } catch (err) {
    console.log('[Virvi] Setup unavailable:', String(err))
    return virvi
  }
}

// Backward-compatible default export
const VirviCompat = {
  init: async (config?: Partial<VirviInitConfig>): Promise<VirviStorage> => {
    const virvi = await createVirvi(config)
    return virvi.storage
  },
}
export default VirviCompat

export { DclAdapter }
export { DclHUDRenderer } from './DclHUDRenderer.js'
export { DclEditMode } from './transform/edit-mode.js'
export type { DclEditModeState } from './transform/edit-mode.js'
export { SHIFT_ACTION } from './transform/input.js'
export type { VirviInitConfig }
export { startVirviAnalytics, stopVirviAnalytics, DclAnalyticsProbe, getAnalyticsSceneRef } from './analytics.js'
export { HUD_ICON_SRC } from './hud/icon.js'
