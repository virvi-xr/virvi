/**
 * Decentraland HUD Renderer
 *
 * Implements the Virvi HUDRenderer interface using DCL SDK 7's ReactECS UI system.
 * Renders management panels as screen-space overlay UI.
 *
 * Supports a "setup" flow for first-time users:
 *   idle → authenticating → scene_setup → connected → management panels
 */

import ReactEcs, { ReactEcsRenderer, UiEntity, Label, Input } from '@dcl/sdk/react-ecs'
import { copyName, nextSwitchText, presetLabel, PRESET_NAME_MAX, type HUDNextSwitch, type HUDPreset } from './presets.js'
import { clearCopiesPrompt, type HUDLayoutItem } from './layout.js'
import { CLICK_KIND_LABELS, CLICKABLE_TYPES, clickDraftOf, clickFromDraft, clickLabel, type ClickDraft } from './clicks.js'
import { DELAY_STEP_MINUTES, NO_SHOWINGS, SHOWINGS_LOADING, showingRow, type HUDShowing, type ShowControl } from './showings.js'
import { offImageLabel, screenSourceLabel, streamOptionLabel, type HUDImage, type HUDScreen, type HUDStream } from './streams.js'
import { Color4 } from '@dcl/sdk/math'
import { engine } from '@dcl/sdk/ecs'
import type {
  HUDRenderer,
  HUDPanelState,
  HUDNotification,
  AssetThumbnail,
  BudgetUsage,
  BudgetLimits,
  Scene,
} from '@virvixr/shared'
import { HUDPanelType } from '@virvixr/shared'
import type { EntityHandle, WorldStatus } from '@virvixr/shared'
import type { VirviConnectionState, HUDMediaStatus } from '@virvixr/core'
import type { UploadToken } from '@virvixr/client'
import { nearbyPlayers } from './players.js'
import { markHudPress } from './hud/press.js'
import { EditModeBar, NO_EDIT_MODE, type EditModeHUDState } from './hud/EditModeBar.js'
import { HUD_ICON_MISSING_HINT, HUD_ICON_SRC, hudIconDot, hudIconInScene } from './hud/icon.js'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface HUDState {
  // Connection state
  connectionState: VirviConnectionState
  statusMessage: string
  errorMessage: string | null
  userName: string | null
  userScenes: Scene[]
  currentSceneId: string | null
  currentSceneName: string | null
  isNewScene: boolean

  // Panel state (active once connected)
  activePanel: HUDPanelType | null
  panelStates: Map<HUDPanelType, HUDPanelState>
  notifications: HUDNotification[]
  assets: AssetThumbnail[]
  budgetUsage: BudgetUsage | null
  budgetLimits: BudgetLimits | null
  worlds: WorldStatus[]
  upgradePrompt: { feature: string; tier: string } | null
  hudVisible: boolean
  /** The scene was deployed without images/virvi/hud-v.png: draw a text V, not the image (else a white square). */
  hudIconMissing: boolean

  // Scene creation
  newSceneName: string

  // In-world setup + roles
  setupOffer: boolean
  setupMessage: string | null
  sceneRole: SceneRole | null
  roles: RolesData
  rolesError: string | null
  roleDraftWallet: string
  roleDraftRole: 'cohost' | 'editor' | 'viewer'
  confirmTransfer: string | null

  // Media library + layout editing (host, co-hosts, editors)
  media: HUDMediaItem[]
  mediaLoaded: boolean
  /** The last media/layout load failed (the error is in editMessage) — show that, not "Loading…". */
  mediaFailed: boolean
  layout: HUDLayoutItem[]
  layoutLoaded: boolean
  layoutFailed: boolean
  editMessage: { text: string; error: boolean; action?: { label: string; action: string } } | null
  confirmDelete: string | null
  /** The layout row whose "remove every copy" is awaiting confirmation (LIV-12). */
  confirmClear: string | null
  /** The item whose click action is being edited (LIV-126), its draft, and why the last save didn't go through. */
  clicking: { elementId: string; draft: ClickDraft } | null
  clickError: string | null
  missingModels: number
  /** The Media Library's Upload view: an upload link (this computer) and its QR (phone), minted on open. */
  upload: UploadViewState
  /** The Media Library row being renamed, with the draft name. */
  renaming: { id: string; draft: string } | null

  // In-world transform editing (editors); mirrored from DclEditMode.state
  editMode: EditModeHUDState

  // Presets (host, co-hosts, editors; LIV-84): in the Events panel
  presets: HUDPreset[]
  activePresetId: string | null
  presetsLoaded: boolean
  presetsError: string | null
  /** The preset waiting for "Make live?" to be confirmed. */
  presetConfirm: string | null
  /** New (a copy of the live preset, or blank) or Rename, with the draft name. */
  presetDraft: { mode: 'new' | 'rename'; name: string; copy: boolean; targetId: string | null } | null
  presetBusy: boolean
  /** The next scheduled switch (LIV-86), and the run just skipped here (for Undo). */
  nextSwitch: HUDNextSwitch | null
  presetSkipped: { scheduleId: string; at: string } | null

  // Stream panel (host, co-hosts, editors; LIV-53): which stream each video screen plays
  streamScreens: HUDScreen[]
  streams: HUDStream[]
  streamsLoaded: boolean
  streamsError: string | null
  /** The screen whose stream list is open. */
  streamPicking: string | null
  /** The screen whose off image list is open (LIV-54). */
  offImagePicking: string | null
  streamImages: HUDImage[]
  streamBusy: boolean
  /** The Schedule-mode screen whose showings list is open (LIV-87); its showings, null while loading. */
  showingsFor: string | null
  showings: HUDShowing[] | null
  /** What the last control did, or why it was refused. */
  showingsNote: { text: string; error: boolean } | null
}

type SceneRole = 'host' | 'cohost' | 'editor' | 'viewer'
export type HUDMediaItem = { id: string; name: string; kind: 'image' | 'model'; status: HUDMediaStatus; error?: string }
export type UploadViewState = { open: boolean; loading: boolean; error: string | null; token: UploadToken | null }
export type { HUDLayoutItem } from './layout.js'
const canEdit = () => state.sceneRole === 'host' || state.sceneRole === 'cohost' || state.sceneRole === 'editor'
type RolesData = { hostWallets: string[]; roles: { wallet: string; role: string; displayName?: string | null }[] }

const state: HUDState = {
  connectionState: 'idle',
  statusMessage: 'Initializing...',
  errorMessage: null,
  userName: null,
  userScenes: [],
  currentSceneId: null,
  currentSceneName: null,
  isNewScene: false,

  activePanel: null,
  panelStates: new Map(),
  notifications: [],
  assets: [],
  budgetUsage: null,
  budgetLimits: null,
  worlds: [],
  upgradePrompt: null,
  hudVisible: true,
  hudIconMissing: false,

  newSceneName: '',

  setupOffer: false,
  setupMessage: null,
  sceneRole: null,
  roles: { hostWallets: [], roles: [] },
  rolesError: null,
  roleDraftWallet: '',
  roleDraftRole: 'editor',
  confirmTransfer: null,

  media: [],
  mediaLoaded: false,
  mediaFailed: false,
  layout: [],
  layoutLoaded: false,
  layoutFailed: false,
  editMessage: null,
  confirmDelete: null,
  confirmClear: null,
  clicking: null,
  clickError: null,
  missingModels: 0,
  upload: { open: false, loading: false, error: null, token: null },
  renaming: null,
  editMode: NO_EDIT_MODE,

  presets: [],
  activePresetId: null,
  presetsLoaded: false,
  presetsError: null,
  presetConfirm: null,
  nextSwitch: null,
  presetSkipped: null,
  presetDraft: null,
  presetBusy: false,

  streamScreens: [],
  streams: [],
  streamsLoaded: false,
  streamsError: null,
  streamPicking: null,
  offImagePicking: null,
  streamImages: [],
  streamBusy: false,
  showingsFor: null,
  showings: null,
  showingsNote: null,
}

// Callbacks
let onPanelAction: ((panel: HUDPanelType, action: string, data?: any) => void) | null = null
let onSceneAction: ((action: string, data?: any) => void) | null = null

export function setHUDActionHandler(handler: (panel: HUDPanelType, action: string, data?: any) => void) {
  onPanelAction = handler
}

export function setSceneActionHandler(handler: (action: string, data?: any) => void) {
  onSceneAction = handler
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = {
  bg: Color4.create(0.06, 0.06, 0.1, 0.96),
  bgLight: Color4.create(0.1, 0.1, 0.16, 1),
  bgHover: Color4.create(0.14, 0.14, 0.2, 1),
  bgCard: Color4.create(0.09, 0.09, 0.14, 1),
  border: Color4.create(0.18, 0.18, 0.26, 1),
  text: Color4.create(1, 1, 1, 1),
  textDim: Color4.create(0.55, 0.55, 0.6, 1),
  textMuted: Color4.create(0.4, 0.4, 0.45, 1),
  accent: Color4.create(0.35, 0.38, 0.92, 1),
  accentHover: Color4.create(0.25, 0.28, 0.82, 1),
  accentSoft: Color4.create(0.35, 0.38, 0.92, 0.15),
  success: Color4.create(0.18, 0.75, 0.38, 1),
  successSoft: Color4.create(0.18, 0.75, 0.38, 0.15),
  warning: Color4.create(0.88, 0.68, 0.08, 1),
  danger: Color4.create(0.88, 0.28, 0.28, 1),
  /** Virvi cyan #08DDEB, the launcher dot when connected */
  virvi: Color4.create(8 / 255, 221 / 255, 235 / 255, 1),
  transparent: Color4.create(0, 0, 0, 0),
  white08: Color4.create(1, 1, 1, 0.08),
  white15: Color4.create(1, 1, 1, 0.15),
}

// ---------------------------------------------------------------------------
// Shared Components
// ---------------------------------------------------------------------------

const LAUNCHER_SIZE = 44
const LAUNCHER_ICON = 34
const LAUNCHER_DOT = hudIconDot(LAUNCHER_ICON)

/** The launcher: the Virvi symbol on the dark square; its dot is the connection status. */
function HUDToggleButton() {
  const dotColor =
    state.connectionState === 'connected' ? C.virvi : state.connectionState === 'error' ? C.danger : C.warning

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { right: 12, top: 12 },
        width: LAUNCHER_SIZE,
        height: LAUNCHER_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      uiBackground={{ color: C.bg }}
      onMouseDown={() => { markHudPress(); state.hudVisible = !state.hudVisible }}
    >
      <UiEntity
        uiTransform={{ width: LAUNCHER_ICON, height: LAUNCHER_ICON, alignItems: 'center', justifyContent: 'center' }}
        uiBackground={state.hudIconMissing ? undefined : { texture: { src: HUD_ICON_SRC }, textureMode: 'stretch', color: C.text }}
      >
        {state.hudIconMissing && <Label value="V" fontSize={26} color={C.text} textAlign="middle-center" />}
        {/* Status dot, where the symbol's dot is */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { left: LAUNCHER_DOT.left, top: LAUNCHER_DOT.top },
            width: LAUNCHER_DOT.diameter,
            height: LAUNCHER_DOT.diameter,
            borderRadius: LAUNCHER_DOT.diameter / 2,
          }}
          uiBackground={{ color: dotColor }}
        />
      </UiEntity>
    </UiEntity>
  )
}

function PanelHeader({ title, onClose, subtitle }: { title: string; onClose: () => void; subtitle?: string }) {
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: subtitle ? 48 : 40,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: { left: 14, right: 10, top: 4, bottom: 4 },
      }}
      uiBackground={{ color: C.bgLight }}
    >
      <UiEntity uiTransform={{ flexDirection: 'column' }}>
        <Label value={title} fontSize={14} color={C.text} />
        {subtitle && <Label value={subtitle} fontSize={9} color={C.textDim} />}
      </UiEntity>
      <UiEntity
        uiTransform={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
        uiBackground={{ color: C.white08 }}
        onMouseDown={() => { markHudPress(); onClose() }}
      >
        <Label value="X" fontSize={12} color={C.textDim}
          uiTransform={{ width: 28, height: 28 }} />
      </UiEntity>
    </UiEntity>
  )
}

function Button({ label, color, textColor, onPress, width, height, fontSize }: {
  label: string; color?: ReturnType<typeof Color4.create>;
  textColor?: ReturnType<typeof Color4.create>;
  onPress: () => void; width?: number; height?: number; fontSize?: number; key?: string | number
}) {
  const w = width || ('100%' as any)
  const h = height || 36
  return (
    <UiEntity
      uiTransform={{
        width: w,
        height: h,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      uiBackground={{ color: color || C.bgHover }}
      onMouseDown={() => { markHudPress(); onPress() }}
    >
      <Label value={label} fontSize={fontSize || 12} color={textColor || C.text}
        uiTransform={{ width: w, height: h }} />
    </UiEntity>
  )
}

function Divider() {
  return (
    <UiEntity
      uiTransform={{ width: '100%', height: 1, margin: { top: 4, bottom: 4 } }}
      uiBackground={{ color: C.white08 }}
    />
  )
}

// ---------------------------------------------------------------------------
// Setup Flow Screens
// ---------------------------------------------------------------------------

function ConnectingScreen() {
  const messages: Record<string, string> = {
    idle: 'Initializing Virvi...',
    authenticating: 'Authenticating with Decentraland...',
    authenticated: 'Signed in! Loading scenes...',
    discovering_scene: 'Looking for your scenes...',
    scene_ready: 'Scene found! Connecting...',
    connecting: 'Connecting to scene...',
    connected: 'Connected!',
    error: 'Connection failed',
  }

  const msg = state.statusMessage || messages[state.connectionState] || 'Working...'

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { right: 12, top: 62 },
        width: 320,
        flexDirection: 'column',
        padding: 16,
      }}
      uiBackground={{ color: C.bg }}
    >
      {/* Virvi Header */}
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'center', margin: { bottom: 12 } }}>
        <Label value="Virvi" fontSize={16} color={C.text} />
      </UiEntity>

      {/* Status */}
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center', padding: 16 }}>
        <Label value={msg} fontSize={12} color={C.textDim} />

        {/* Progress dots animation */}
        {state.connectionState !== 'error' && state.connectionState !== 'connected' && (
          <Label value="..." fontSize={18} color={C.accent}
            uiTransform={{ margin: { top: 8 } }} />
        )}

        {/* Error display */}
        {state.connectionState === 'error' && state.errorMessage && (
          <UiEntity uiTransform={{ width: '100%', margin: { top: 8 }, padding: 8 }}
            uiBackground={{ color: Color4.create(0.88, 0.28, 0.28, 0.15) }}>
            <Label value={state.errorMessage} fontSize={10} color={C.danger} />
          </UiEntity>
        )}

        {/* Retry button on error */}
        {state.connectionState === 'error' && (
          <UiEntity uiTransform={{ margin: { top: 12 } }}>
            <Button label="Retry" color={C.accent}
              onPress={() => onSceneAction?.('retry')} width={100} />
          </UiEntity>
        )}
      </UiEntity>

      {/* User info if authenticated */}
      {state.userName && (
        <UiEntity uiTransform={{ width: '100%', margin: { top: 8 } }}>
          <Divider />
          <Label value={`Signed in as ${state.userName}`} fontSize={10} color={C.textMuted}
            uiTransform={{ margin: { top: 4 } }} />
        </UiEntity>
      )}
    </UiEntity>
  )
}

function SceneSetupScreen() {
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { right: 12, top: 62 },
        width: 340,
        flexDirection: 'column',
      }}
      uiBackground={{ color: C.bg }}
    >
      {/* Header */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: 52,
          flexDirection: 'column',
          justifyContent: 'center',
          padding: { left: 14, right: 14 },
        }}
        uiBackground={{ color: C.bgLight }}
      >
        <Label value="Virvi" fontSize={15} color={C.text} />
        <Label value={state.userName ? `Welcome, ${state.userName}` : 'Scene Setup'} fontSize={10} color={C.textDim} />
      </UiEntity>

      <UiEntity uiTransform={{ padding: { left: 14, right: 14, top: 12, bottom: 14 }, flexDirection: 'column' }}>
        {/* Existing scenes */}
        {state.userScenes.length > 0 && (
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { bottom: 12 } }}>
            <Label value="Your Scenes" fontSize={12} color={C.text}
              uiTransform={{ margin: { bottom: 6 } }} />
            {state.userScenes.slice(0, 5).map((scene, i) => (
              <UiEntity
                key={scene.id || i}
                uiTransform={{
                  width: '100%',
                  height: 40,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: { left: 10, right: 10 },
                  margin: { bottom: 3 },
                }}
                uiBackground={{ color: C.bgCard }}
                onMouseDown={() => { markHudPress(); onSceneAction?.('select_scene', { sceneId: scene.id }) }}
              >
                <UiEntity uiTransform={{ flexDirection: 'column' }}>
                  <Label value={scene.name || 'Untitled'} fontSize={11} color={C.text} />
                  <Label value={scene.id.slice(0, 8) + '...'} fontSize={8} color={C.textMuted} />
                </UiEntity>
                <Label value="Connect >" fontSize={10} color={C.accent} />
              </UiEntity>
            ))}
          </UiEntity>
        )}

        <Divider />

        {/* Create new scene */}
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 8 } }}>
          <Label value={state.userScenes.length > 0 ? 'Or Create New' : 'Create Your First Scene'} fontSize={12} color={C.text}
            uiTransform={{ margin: { bottom: 6 } }} />

          <Label value="Scene Name" fontSize={10} color={C.textDim}
            uiTransform={{ margin: { bottom: 3 } }} />
          <Input
            uiTransform={{ width: '100%', height: 36 }}
            uiBackground={{ color: C.bgCard }}
            color={C.text}
            placeholderColor={C.textMuted}
            placeholder="My Awesome Scene"
            fontSize={12}
            value={state.newSceneName}
            onChange={(value) => { state.newSceneName = value }}
          />

          <UiEntity uiTransform={{ margin: { top: 10 } }}>
            <Button
              label="Create Scene"
              color={C.accent}
              onPress={() => {
                const name = state.newSceneName.trim() || `${state.userName || 'My'}'s Scene`
                onSceneAction?.('create_scene', { name })
              }}
            />
          </UiEntity>
        </UiEntity>

        {/* Info text */}
        <UiEntity uiTransform={{ margin: { top: 12 } }}>
          <Label
            value="Your Decentraland wallet is automatically linked to your Virvi account."
            fontSize={9}
            color={C.textMuted}
          />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

function SetupOfferScreen() {
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { right: 12, top: 62 },
        width: 340,
        flexDirection: 'column',
      }}
      uiBackground={{ color: C.bg }}
    >
      <PanelHeader title="Set up Virvi here" onClose={() => { state.hudVisible = false }} />
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', padding: 12 }}>
        <Label
          value="Manage this scene's screens, streams and events from here, see its visitor analytics, and invite your crew. You'll be the host."
          fontSize={12} color={C.text} textAlign="top-left"
          uiTransform={{ width: '100%', height: 64, margin: { bottom: 8 } }}
        />
        {state.setupMessage && (
          <Label value={state.setupMessage} fontSize={11} color={C.warning} textAlign="top-left"
            uiTransform={{ width: '100%', height: 32, margin: { bottom: 6 } }} />
        )}
        <Button
          label="Set up Virvi here"
          color={C.accent}
          onPress={() => {
            // Hide the card so the connecting spinner shows; showSetupOffer() brings it back on failure
            state.setupOffer = false
            onSceneAction?.('setup_here')
          }}
          width={316}
          height={40}
          fontSize={13}
        />
      </UiEntity>
    </UiEntity>
  )
}

const roleLabel = (role: string) => (role === 'cohost' ? 'Co-host' : role === 'editor' ? 'Editor' : role === 'viewer' ? 'Viewer' : role)
const shortWallet = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`

function RolesPanel() {
  const isHost = state.sceneRole === 'host'
  const assigned = new Set([...state.roles.hostWallets, ...state.roles.roles.map((r) => r.wallet)].map((w) => w.toLowerCase()))
  const here = nearbyPlayers().filter((p) => !assigned.has(p.address))
  const add = (wallet: string) => onSceneAction?.('roles_add', { wallet, role: state.roleDraftRole })

  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="Roles" subtitle={state.currentSceneName || undefined}
        onClose={() => { state.activePanel = null; state.confirmTransfer = null }} />
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', padding: 8 }}>
        {state.rolesError && (
          <Label value={state.rolesError} fontSize={10} color={C.danger} textAlign="top-left"
            uiTransform={{ width: '100%', height: 28 }} />
        )}

        {state.roles.hostWallets.slice(0, 1).map((w) => (
          <UiEntity key={w} uiTransform={{ width: '100%', height: 28, flexDirection: 'row', alignItems: 'center', padding: { left: 8 }, margin: { bottom: 2 } }}
            uiBackground={{ color: C.bgCard }}>
            <Label value={`${shortWallet(w)} — Host`} fontSize={12} color={C.text} />
          </UiEntity>
        ))}

        {state.roles.roles.map((r) => (
          <UiEntity key={r.wallet}
            uiTransform={{ width: '100%', height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: { left: 8, right: 4 }, margin: { bottom: 2 } }}
            uiBackground={{ color: C.bgCard }}>
            <Label value={`${r.displayName || shortWallet(r.wallet)} — ${roleLabel(r.role)}`} fontSize={12} color={C.text}
              textAlign="middle-left" uiTransform={{ width: 170 }} />
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
              {isHost && r.role === 'cohost' && (
                state.confirmTransfer === r.wallet
                  ? <Button label="Confirm" color={C.warning} textColor={C.bg}
                      onPress={() => { state.confirmTransfer = null; onSceneAction?.('roles_transfer', { wallet: r.wallet }) }}
                      width={70} height={24} fontSize={10} />
                  : <Button label="Make host" onPress={() => { state.confirmTransfer = r.wallet }} width={70} height={24} fontSize={10} />
              )}
              <UiEntity uiTransform={{ width: 4 }} />
              <Button label="Remove" color={C.danger} onPress={() => onSceneAction?.('roles_remove', { wallet: r.wallet })}
                width={60} height={24} fontSize={10} />
            </UiEntity>
          </UiEntity>
        ))}
        {state.confirmTransfer && (
          <Label value={`Make ${shortWallet(state.confirmTransfer)} the host? You'll become a co-host.`} fontSize={10} color={C.warning}
            textAlign="top-left" uiTransform={{ width: '100%', height: 22 }} />
        )}

        <Divider />
        <Label value="Add as" fontSize={11} color={C.textDim} uiTransform={{ height: 20 }} />
        <UiEntity uiTransform={{ width: '100%', height: 30, flexDirection: 'row', justifyContent: 'space-between' }}>
          {(['cohost', 'editor', 'viewer'] as const).map((role) => (
            <Button key={role} label={roleLabel(role)} color={state.roleDraftRole === role ? C.accent : undefined}
              onPress={() => { state.roleDraftRole = role }} width={102} height={26} fontSize={11} />
          ))}
        </UiEntity>

        <Label value="People here" fontSize={11} color={C.textDim} uiTransform={{ height: 22 }} />
        {here.length === 0 && <Label value="No one else here right now" fontSize={10} color={C.textMuted} uiTransform={{ height: 20 }} />}
        {here.slice(0, 6).map((p) => (
          <UiEntity key={p.address} uiTransform={{ width: '100%', height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Label value={p.name} fontSize={11} color={C.text} textAlign="middle-left" uiTransform={{ width: 240 }} />
            <Button label="Add" color={C.accent} onPress={() => add(p.address)} width={60} height={24} fontSize={10} />
          </UiEntity>
        ))}

        <Input
          uiTransform={{ width: '100%', height: 36, margin: { top: 6, bottom: 6 } }}
          uiBackground={{ color: C.bgCard }}
          color={C.text}
          placeholderColor={C.textMuted}
          placeholder="or paste a wallet address (0x…)"
          fontSize={11}
          value={state.roleDraftWallet}
          onChange={(v) => { state.roleDraftWallet = v }}
        />
        <Button
          label="Add address"
          color={C.accent}
          onPress={() => {
            const wallet = state.roleDraftWallet.trim()
            if (/^0x[0-9a-fA-F]{40}$/.test(wallet)) add(wallet.toLowerCase())
            else state.rolesError = 'That is not a wallet address'
          }}
          height={30}
        />
      </UiEntity>
    </UiEntity>
  )
}

function ConnectedBanner() {
  if (!state.isNewScene) return null

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { right: 12, top: 62 },
        width: 320,
        flexDirection: 'column',
        padding: 14,
      }}
      uiBackground={{ color: C.bg }}
    >
      <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: 8 } }}>
        <Label value="+" fontSize={14} color={C.success} uiTransform={{ margin: { right: 6 } }} />
        <Label value="Scene Created!" fontSize={14} color={C.text} />
      </UiEntity>
      <Label value={`"${state.currentSceneName || 'New Scene'}" is ready.`} fontSize={11} color={C.textDim} />
      <Label value="Use the Virvi button to manage your scene." fontSize={10} color={C.textMuted}
        uiTransform={{ margin: { top: 4 } }} />
      <UiEntity uiTransform={{ margin: { top: 10 } }}>
        <Button label="Got it" color={C.accent}
          onPress={() => { state.isNewScene = false }} />
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Nav Bar (connected state)
// ---------------------------------------------------------------------------

// Action tab: opens the scene's analytics dashboard in the browser instead of switching panel
const ACTION_STATS = '__stats'

function NavBar() {
  const panels: Array<{ type: HUDPanelType | typeof ACTION_STATS; label: string }> = [
    { type: HUDPanelType.SCENE_LAYOUT, label: 'Layout' },
    { type: HUDPanelType.ASSET_BROWSER, label: 'Assets' },
    { type: HUDPanelType.EVENT_CONTROL, label: 'Events' },
    { type: HUDPanelType.STREAM_CONTROL, label: 'Stream' },
    { type: HUDPanelType.WORLD_STATUS, label: 'Worlds' },
    { type: HUDPanelType.NOTIFICATIONS, label: 'Alerts' },
  ]
  // Host and co-hosts manage who else can work on this setup
  const hasRoles = state.sceneRole === 'host' || state.sceneRole === 'cohost'
  const tabs: Array<{ type: HUDPanelType | typeof ACTION_STATS; label: string }> = [
    ...panels,
    ...(hasRoles ? [{ type: HUDPanelType.ROLES, label: 'Roles' }] : []),
    // The HUD only renders the NavBar for connected role holders, so every role gets Stats
    { type: ACTION_STATS, label: 'Stats' },
  ]

  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: 36,
        flexDirection: 'row',
        alignItems: 'center',
      }}
      uiBackground={{ color: C.bgLight }}
    >
      {tabs.map(p => (
        <UiEntity
          key={p.type}
          // Equal-width tabs so every label fits on one line, however many tabs there are
          uiTransform={{ width: `${100 / tabs.length}%`, height: 36, justifyContent: 'center', alignItems: 'center' }}
          uiBackground={{ color: state.activePanel === p.type ? C.accent : C.transparent }}
          onMouseDown={() => {
            markHudPress()
            if (p.type === ACTION_STATS) {
              onSceneAction?.('open_analytics')
              return
            }
            state.activePanel = state.activePanel === p.type ? null : p.type
            const opened = state.activePanel === p.type
            state.confirmDelete = null
            state.confirmClear = null
            state.editMessage = null
            if (p.type === HUDPanelType.ROLES) {
              state.confirmTransfer = null
              if (opened) onSceneAction?.('roles_refresh')
            } else if (p.type === HUDPanelType.SCENE_LAYOUT) {
              if (opened) onSceneAction?.('layout_refresh')
            } else if (p.type === HUDPanelType.ASSET_BROWSER) {
              if (opened && canEdit()) onSceneAction?.('media_refresh')
            } else if (p.type === HUDPanelType.STREAM_CONTROL) {
              state.streamPicking = null
              state.showingsFor = null
              state.offImagePicking = null
              if (opened && canEdit()) onSceneAction?.('streams_refresh')
            } else if (p.type === HUDPanelType.EVENT_CONTROL) {
              state.presetConfirm = null
              state.presetDraft = null
              if (opened && canEdit()) onSceneAction?.('presets_refresh')
              onPanelAction?.(p.type, 'open')
            } else {
              onPanelAction?.(p.type, 'open')
            }
          }}
        >
          <Label value={p.label} fontSize={tabs.length > 7 ? 10 : 11} textWrap="nowrap" color={state.activePanel === p.type ? C.text : C.textDim}
            uiTransform={{ width: '100%', height: 36 }} />
        </UiEntity>
      ))}
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: Scene Layout
// ---------------------------------------------------------------------------

function EditMessage() {
  if (!state.editMessage) return null
  const { action } = state.editMessage
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <Label value={state.editMessage.text} fontSize={10} color={state.editMessage.error ? C.danger : C.success}
        textAlign="top-left" uiTransform={{ width: '100%', height: 24 }} />
      {action && (
        <UiEntity uiTransform={{ width: '100%', margin: { bottom: 6 } }}>
          <Button label={action.label} color={C.accent} height={26} fontSize={11}
            onPress={() => onSceneAction?.(action.action)} />
        </UiEntity>
      )}
    </UiEntity>
  )
}

function SceneLayoutPanel() {
  const editable = canEdit()
  const elements = state.layout

  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader
        title="Scene Layout"
        subtitle={state.currentSceneName || undefined}
        onClose={() => { state.activePanel = null; state.confirmDelete = null; state.confirmClear = null; state.clicking = null }}
      />
      <UiEntity uiTransform={{ width: '100%', padding: 8, flexDirection: 'column' }}>
        <EditMessage />
        {editable && (
          <UiEntity uiTransform={{ width: '100%', margin: { bottom: 6 } }}>
            <Button label="Edit layout" color={C.accent} height={30} fontSize={11}
              onPress={() => { state.activePanel = null; onSceneAction?.('edit_enter') }} />
          </UiEntity>
        )}
        {elements.length === 0 ? (
          <UiEntity uiTransform={{ width: '100%', padding: 16, flexDirection: 'column', alignItems: 'center' }}>
            <Label value={state.layoutFailed ? "Couldn't load the layout" : state.layoutLoaded ? 'No elements yet' : 'Loading…'} fontSize={12} color={C.textDim} />
            {state.layoutLoaded && !state.layoutFailed && editable && (
              <Label value="Place images and models from the Assets panel" fontSize={10} color={C.textMuted}
                uiTransform={{ margin: { top: 4 } }} />
            )}
          </UiEntity>
        ) : (
          elements.slice(0, 12).map((el) => (
            <UiEntity
              key={el.id}
              uiTransform={{
                width: '100%',
                height: 34,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: { left: 10, right: 4 },
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: C.bgCard }}
            >
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', width: editable ? (CLICKABLE_TYPES.has(el.type) ? 68 : 112) : 260 }}>
                <Label value={el.type.toUpperCase().slice(0, 3)} fontSize={8} color={C.textMuted}
                  uiTransform={{ margin: { right: 6 } }} />
                <Label value={el.name || 'Unnamed'} fontSize={11} color={el.enabled ? C.text : C.textDim} textAlign="middle-left" />
                {el.copies > 1 && (
                  <Label value={`×${el.copies}`} fontSize={9} color={C.textMuted} uiTransform={{ margin: { left: 4 } }} />
                )}
              </UiEntity>
              {!editable ? (
                <Label value={el.enabled ? 'ON' : 'OFF'} fontSize={9} color={el.enabled ? C.success : C.textDim} />
              ) : state.confirmDelete === el.id ? (
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Button label="Delete" color={C.danger}
                    onPress={() => { state.confirmDelete = null; onSceneAction?.('layout_delete', { elementId: el.id }) }}
                    width={56} height={24} fontSize={10} />
                  <UiEntity uiTransform={{ width: 4 }} />
                  <Button label="Cancel" onPress={() => { state.confirmDelete = null }} width={56} height={24} fontSize={10} />
                </UiEntity>
              ) : state.confirmClear === el.id ? (
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Button label="Remove" color={C.danger}
                    onPress={() => { state.confirmClear = null; onSceneAction?.('layout_clear', { elementId: el.id }) }}
                    width={56} height={24} fontSize={10} />
                  <UiEntity uiTransform={{ width: 4 }} />
                  <Button label="Cancel" onPress={() => { state.confirmClear = null }} width={56} height={24} fontSize={10} />
                </UiEntity>
              ) : (
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Button label={el.enabled ? 'Hide' : 'Show'} color={el.enabled ? undefined : C.accent}
                    onPress={() => onSceneAction?.('layout_toggle', { elementId: el.id, enabled: !el.enabled })}
                    width={56} height={24} fontSize={10} />
                  <UiEntity uiTransform={{ width: 4 }} />
                  <Button label="Delete" color={C.danger} onPress={() => { state.confirmClear = null; state.confirmDelete = el.id }}
                    width={56} height={24} fontSize={10} />
                  {el.copies > 0 && <UiEntity uiTransform={{ width: 4 }} />}
                  {el.copies > 0 && (
                    <Button label="Clear" onPress={() => { state.confirmDelete = null; state.confirmClear = el.id }}
                      width={52} height={24} fontSize={10} />
                  )}
                  {CLICKABLE_TYPES.has(el.type) && <UiEntity uiTransform={{ width: 4 }} />}
                  {CLICKABLE_TYPES.has(el.type) && (
                    <Button label="Click" color={state.clicking?.elementId === el.id ? C.accent : undefined}
                      onPress={() => {
                        state.confirmDelete = null
                        state.confirmClear = null
                        state.clickError = null
                        state.clicking = state.clicking?.elementId === el.id ? null : { elementId: el.id, draft: clickDraftOf(el.click) }
                      }}
                      width={40} height={24} fontSize={9} />
                  )}
                </UiEntity>
              )}
            </UiEntity>
          ))
        )}
        {elements.length > 12 && (
          <Label value={`+${elements.length - 12} more — manage them on the dashboard`} fontSize={10} color={C.textMuted}
            uiTransform={{ height: 20 }} />
        )}
        {state.confirmClear && (() => {
          const item = elements.find((el) => el.id === state.confirmClear)
          return item ? (
            <Label value={clearCopiesPrompt(item)} fontSize={10} color={C.warning}
              textAlign="top-left" uiTransform={{ width: '100%', height: 30 }} />
          ) : null
        })()}
        {state.confirmDelete && (
          <Label value="Delete this element and all its copies? This can't be undone." fontSize={10} color={C.warning}
            textAlign="top-left" uiTransform={{ width: '100%', height: 22 }} />
        )}
        {editable && state.clicking && <ClickEditor />}
      </UiEntity>
    </UiEntity>
  )
}

/** One text field of the click editor; `set` writes the draft. */
function ClickInput({ value, placeholder, width, set }: { value: string; placeholder: string; width: number; set: (v: string) => void }) {
  return (
    <Input uiTransform={{ width, height: 28, margin: { right: 4 } }} uiBackground={{ color: C.bgLight }} color={C.text}
      placeholderColor={C.textMuted} placeholder={placeholder} fontSize={10} value={value} onChange={set} />
  )
}

/** What clicking the item does (LIV-126): the same actions as the dashboard's, checked before saving. */
function ClickEditor() {
  const c = state.clicking!
  const item = state.layout.find((el) => el.id === c.elementId)
  if (!item) return null
  const d = c.draft
  const set = (patch: Partial<ClickDraft>) => { if (state.clicking) state.clicking = { ...state.clicking, draft: { ...state.clicking.draft, ...patch } } }
  const save = () => {
    const r = clickFromDraft(state.clicking!.draft)
    if (!r.ok) { state.clickError = r.error; return }
    state.clickError = null
    onSceneAction?.('layout_click', { elementId: c.elementId, clickEvent: r.value })
  }
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', padding: 6, margin: { top: 4 } }} uiBackground={{ color: C.bgCard }}>
      <Label value={`${item.name || 'Unnamed'}: ${clickLabel(item.click)}`} fontSize={10} color={C.textDim} textAlign="middle-left" uiTransform={{ height: 18 }} />
      <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 2, bottom: 4 } }}>
        {CLICK_KIND_LABELS.map(([kind, label]) => (
          <UiEntity key={kind} uiTransform={{ margin: { right: 3 } }}>
            <Button label={label} color={d.kind === kind ? C.accent : undefined} onPress={() => set({ kind })} width={54} height={22} fontSize={9} />
          </UiEntity>
        ))}
      </UiEntity>
      {d.kind === 'link' && <ClickInput value={d.link} placeholder="https://… (Decentraland asks first)" width={280} set={(v) => set({ link: v })} />}
      {d.kind === 'sound' && <ClickInput value={d.sound} placeholder="https://… an mp3 or ogg" width={280} set={(v) => set({ sound: v })} />}
      {d.kind === 'teleport' && <ClickInput value={d.teleport} placeholder="Parcel, like 52,-20" width={140} set={(v) => set({ teleport: v })} />}
      {d.kind === 'move' && (
        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
          <Label value="To" fontSize={10} color={C.textDim} uiTransform={{ width: 20 }} />
          {(['x', 'y', 'z'] as const).map((a, i) => (
            <UiEntity key={a}>
              <ClickInput value={d.move[i]} placeholder={a} width={56}
                set={(v) => { const m = [...d.move] as ClickDraft['move']; m[i] = v; set({ move: m }) }} />
            </UiEntity>
          ))}
        </UiEntity>
      )}
      {d.kind !== 'none' && (
        <UiEntity uiTransform={{ margin: { top: 4 } }}>
          <ClickInput value={d.hoverText} placeholder="Hover text" width={200} set={(v) => set({ hoverText: v.slice(0, 60) })} />
        </UiEntity>
      )}
      {state.clickError && <Label value={state.clickError} fontSize={10} color={C.danger} textAlign="top-left" uiTransform={{ width: '100%', height: 20 }} />}
      <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 4 } }}>
        <Button label="Save" color={C.accent} onPress={save} width={56} height={24} fontSize={10} />
        <UiEntity uiTransform={{ width: 4 }} />
        <Button label="Cancel" onPress={() => { state.clicking = null; state.clickError = null }} width={56} height={24} fontSize={10} />
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: Asset Browser (the signed-in user's Media library)
// ---------------------------------------------------------------------------

// Badge per HUD status: a marker and a word (the marker carries the color)
const MEDIA_BADGE: Record<HUDMediaStatus, { text: string; color: ReturnType<typeof Color4.create> }> = {
  uploading: { text: '• Uploading', color: C.textMuted },
  processing: { text: '• Processing', color: C.textMuted },
  available: { text: '✓ Available', color: C.success },
  needs_sync: { text: '⟳ Needs sync', color: C.warning },
  failed: { text: '✕ Failed', color: C.danger },
}

const closeUploadView = () => onSceneAction?.('media_upload_back')

function RenameRow({ asset }: { asset: HUDMediaItem }) {
  const draft = state.renaming?.draft ?? ''
  const save = () => onSceneAction?.('media_rename', { assetId: asset.id, name: draft })
  return (
    <UiEntity
      uiTransform={{ width: '100%', height: 42, flexDirection: 'row', alignItems: 'center', padding: { left: 6, right: 4 }, margin: { bottom: 2 } }}
      uiBackground={{ color: C.bgCard }}
    >
      <Input
        uiTransform={{ width: 196, height: 36 }}
        uiBackground={{ color: C.bgLight }}
        color={C.text}
        placeholderColor={C.textMuted}
        placeholder={asset.name}
        fontSize={11}
        value={draft}
        onChange={(v) => { if (state.renaming) state.renaming.draft = v }}
        onSubmit={save}
      />
      <UiEntity uiTransform={{ width: 4 }} />
      <Button label="Save" color={C.accent} onPress={save} width={48} height={24} fontSize={10} />
      <UiEntity uiTransform={{ width: 4 }} />
      <Button label="Cancel" onPress={() => { state.renaming = null }} width={52} height={24} fontSize={10} />
    </UiEntity>
  )
}

function MediaRow({ asset }: { asset: HUDMediaItem; key?: string }) {
  if (state.renaming?.id === asset.id) return <RenameRow asset={asset} />
  const badge = MEDIA_BADGE[asset.status]
  const placeable = asset.status === 'available' || asset.status === 'needs_sync'
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: asset.error ? 46 : 34,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: { left: 10, right: 4 },
        margin: { bottom: 2 },
      }}
      uiBackground={{ color: C.bgCard }}
    >
      <UiEntity uiTransform={{ flexDirection: 'column', width: 190 }}>
        <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', width: 190 }}>
          <Label value={asset.kind === 'model' ? 'GLB' : 'IMG'} fontSize={8}
            color={asset.kind === 'model' ? C.warning : C.textMuted} uiTransform={{ margin: { right: 6 } }} />
          <Label value={asset.name} fontSize={11} color={C.text} textAlign="middle-left" uiTransform={{ maxWidth: 100 }} />
          <Label value={badge.text} fontSize={9} color={badge.color} textAlign="middle-left" uiTransform={{ margin: { left: 6 } }} />
        </UiEntity>
        {asset.error && (
          <Label value={asset.error} fontSize={9} color={C.danger} textAlign="middle-left" uiTransform={{ width: 190, height: 12 }} />
        )}
      </UiEntity>
      {placeable && (
        <UiEntity uiTransform={{ flexDirection: 'row' }}>
          <Button label="Rename" onPress={() => { state.renaming = { id: asset.id, draft: asset.name } }}
            width={52} height={24} fontSize={10} />
          <UiEntity uiTransform={{ width: 4 }} />
          <Button label="Place" color={C.accent}
            onPress={() => onSceneAction?.('media_place', { assetId: asset.id })}
            width={56} height={24} fontSize={10} />
        </UiEntity>
      )}
      {asset.status === 'failed' && (
        <Button label="Dismiss"
          onPress={() => onSceneAction?.('media_dismiss', { assetId: asset.id })}
          width={56} height={24} fontSize={10} />
      )}
    </UiEntity>
  )
}

/** Upload link for this computer, the same link as a QR for a phone, and the code to type in by hand. */
function UploadView() {
  const { loading, error, token } = state.upload
  const expires = token ? new Date(token.expiresAt) : null
  const hhmm = expires ? `${String(expires.getHours()).padStart(2, '0')}:${String(expires.getMinutes()).padStart(2, '0')}` : ''
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center', padding: 8 }}>
      <Label value="Upload media" fontSize={13} color={C.text} uiTransform={{ height: 22 }} />
      {loading && <Label value="Making a link…" fontSize={11} color={C.textDim} uiTransform={{ height: 24 }} />}
      {error && <Label value={error} fontSize={11} color={C.danger} uiTransform={{ height: 24 }} />}
      {token && (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
          <Button label="Open on this computer" color={C.accent}
            onPress={() => onSceneAction?.('media_upload_computer')} width={220} height={30} fontSize={11} />
          <UiEntity
            uiTransform={{ width: 168, height: 168, margin: { top: 10, bottom: 6 } }}
            uiBackground={{ texture: { src: token.qrUrl, filterMode: 'point' }, textureMode: 'stretch' }}
          />
          <Label value="Scan to upload from your phone" fontSize={11} color={C.text} uiTransform={{ height: 18 }} />
          <Label value={token.uploadUrl} fontSize={10} color={C.textDim} uiTransform={{ height: 16 }} />
          <Label value={`Code: ${token.code}`} fontSize={12} color={C.text} uiTransform={{ height: 20 }} />
          <Label value={`Link expires ${hhmm} · ${token.maxUploads} uploads`} fontSize={9} color={C.textMuted} uiTransform={{ height: 16 }} />
        </UiEntity>
      )}
      <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 8 } }}>
        <Button label="New link" onPress={() => onSceneAction?.('media_upload_new')} width={100} height={26} fontSize={10} />
        <UiEntity uiTransform={{ width: 8 }} />
        <Button label="Back" onPress={closeUploadView} width={100} height={26} fontSize={10} />
      </UiEntity>
    </UiEntity>
  )
}

function UploadButton() {
  return (
    <Button label="Upload" color={C.accent} onPress={() => onSceneAction?.('media_upload_open')}
      width={80} height={24} fontSize={10} />
  )
}

function AssetBrowserPanel() {
  const editable = canEdit()
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="Media Library" subtitle="Images and GLB models"
        onClose={() => { if (state.upload.open) closeUploadView(); state.activePanel = null }} />
      <UiEntity uiTransform={{ width: '100%', padding: 8, flexDirection: 'column' }}>
        {!editable ? (
          <UiEntity uiTransform={{ width: '100%', padding: 16, flexDirection: 'column', alignItems: 'center' }}>
            <Label value="Only the host, co-hosts and editors can place media" fontSize={11} color={C.textDim} />
          </UiEntity>
        ) : state.upload.open ? (
          <UploadView />
        ) : (
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
            <EditMessage />
            {state.media.length > 0 && (
              <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'flex-end', margin: { bottom: 4 } }}>
                <UploadButton />
              </UiEntity>
            )}
            {state.media.length === 0 ? (
              <UiEntity uiTransform={{ width: '100%', padding: 16, flexDirection: 'column', alignItems: 'center' }}>
                <Label value={state.mediaFailed ? "Couldn't load your media library" : state.mediaLoaded ? 'No images or models yet' : 'Loading…'} fontSize={12} color={C.textDim} />
                {state.mediaLoaded && !state.mediaFailed && (
                  <UiEntity uiTransform={{ margin: { top: 8 } }}>
                    <UploadButton />
                  </UiEntity>
                )}
              </UiEntity>
            ) : (
              state.media.slice(0, 10).map((asset) => <MediaRow key={asset.id} asset={asset} />)
            )}
            {state.media.length > 10 && (
              <Label value={`+${state.media.length - 10} more — place them from the dashboard`} fontSize={10} color={C.textMuted}
                uiTransform={{ height: 20 }} />
            )}
          </UiEntity>
        )}
        {state.budgetUsage && state.budgetLimits && (
          <BudgetMeter usage={state.budgetUsage} limits={state.budgetLimits} />
        )}
      </UiEntity>
    </UiEntity>
  )
}

/** Models placed or listed in this scene whose GLB file isn't deployed with it yet. */
function SyncNotice() {
  const n = state.missingModels
  if (n <= 0) return null
  return (
    <UiEntity uiTransform={{ width: '100%', padding: { left: 10, right: 10, top: 4, bottom: 4 } }}
      uiBackground={{ color: C.bgCard }}>
      <Label value={`${n} model(s) need sync + redeploy — run npx @virvixr/dcl sync`} fontSize={10} color={C.warning}
        textAlign="middle-left" uiTransform={{ width: '100%', height: 20 }} />
    </UiEntity>
  )
}

function BudgetMeter({ usage, limits }: { usage: BudgetUsage; limits: BudgetLimits }) {
  const triPct = limits.maxTriangleCount > 0 ? Math.min(100, (usage.triangleCount / limits.maxTriangleCount) * 100) : 0
  const entPct = limits.maxEntityCount > 0 ? Math.min(100, (usage.entityCount / limits.maxEntityCount) * 100) : 0
  const barColor = (pct: number) => pct > 90 ? C.danger : pct > 70 ? C.warning : C.success

  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 10 }, padding: { top: 8 } }}>
      <Label value="Scene Budget" fontSize={10} color={C.textDim} />
      <UiEntity uiTransform={{ width: '100%', height: 6, margin: { top: 4 } }} uiBackground={{ color: C.bgLight }}>
        <UiEntity uiTransform={{ width: `${triPct}%` as any, height: 6 }} uiBackground={{ color: barColor(triPct) }} />
      </UiEntity>
      <Label value={`Triangles: ${usage.triangleCount} / ${limits.maxTriangleCount}`} fontSize={9} color={C.textMuted} />
      <UiEntity uiTransform={{ width: '100%', height: 6, margin: { top: 4 } }} uiBackground={{ color: C.bgLight }}>
        <UiEntity uiTransform={{ width: `${entPct}%` as any, height: 6 }} uiBackground={{ color: barColor(entPct) }} />
      </UiEntity>
      <Label value={`Entities: ${usage.entityCount} / ${limits.maxEntityCount}`} fontSize={9} color={C.textMuted} />
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: Event Control
// ---------------------------------------------------------------------------

function EventControlPanel() {
  const panelState = state.panelStates.get(HUDPanelType.EVENT_CONTROL) as any
  const events = panelState?.events || []

  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="Event Control" onClose={() => { state.activePanel = null }} />
      <UiEntity uiTransform={{ padding: 8, flexDirection: 'column' }}>
        {events.length === 0 ? (
          <UiEntity uiTransform={{ padding: 16, alignItems: 'center' }}>
            <Label value="No active events" fontSize={12} color={C.textDim} />
          </UiEntity>
        ) : (
          events.slice(0, 10).map((evt: any, i: number) => (
            <UiEntity
              key={evt.id || i}
              uiTransform={{
                width: '100%',
                height: 42,
                flexDirection: 'column',
                padding: { left: 10, right: 10, top: 6 },
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: C.bgCard }}
            >
              <Label value={evt.name} fontSize={11} color={C.text} />
              <Label value={`Visitors: ${evt.visitorCount || 0}`} fontSize={9} color={C.textDim} />
            </UiEntity>
          ))
        )}
        {canEdit() && <PresetsSection />}
      </UiEntity>
    </UiEntity>
  )
}

/**
 * The scene's presets (LIV-84): the live one is marked; tapping another asks first, since everyone here sees the
 * change. New copies the live preset (or starts blank); Rename renames one. Deleting stays on the web dashboard.
 */
function PresetsSection() {
  const draft = state.presetDraft
  const confirm = state.presets.find((p) => p.id === state.presetConfirm)
  const live = state.presets.find((p) => p.id === state.activePresetId)
  const names = state.presets.map((p) => p.name)
  const startNew = () => {
    state.presetConfirm = null
    state.presetsError = null
    state.presetDraft = { mode: 'new', name: live ? copyName(live.name, names) : 'New preset', copy: !!live, targetId: null }
  }
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 10 } }}>
      <Divider />
      <Label value="Presets" fontSize={11} color={C.textDim} textAlign="middle-left" uiTransform={{ width: '100%', height: 20 }} />
      {state.presetsError && (
        <Label value={state.presetsError} fontSize={10} color={C.danger} textAlign="top-left" uiTransform={{ width: '100%', height: 28 }} />
      )}
      {!state.presetsLoaded && !state.presetsError && <Label value="Loading…" fontSize={10} color={C.textMuted} uiTransform={{ height: 20 }} />}
      {state.presets.slice(0, 8).map((p) => {
        const isLive = p.id === state.activePresetId
        return (
          <UiEntity key={p.id}
            uiTransform={{ width: '100%', height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: { left: 8, right: 4 }, margin: { bottom: 2 } }}
            uiBackground={{ color: isLive ? C.bgHover : C.bgCard }}>
            <Label value={`${isLive ? '● ' : ''}${presetLabel(p.name)}${isLive ? ' (live)' : ''}`} fontSize={12} color={isLive ? C.success : C.text}
              textAlign="middle-left" uiTransform={{ width: 170 }} />
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
              <Button label="Rename" onPress={() => { state.presetConfirm = null; state.presetsError = null; state.presetDraft = { mode: 'rename', name: p.name, copy: false, targetId: p.id } }}
                width={60} height={24} fontSize={10} />
              <UiEntity uiTransform={{ width: 4 }} />
              {!isLive && <Button label="Make live" color={C.accent} onPress={() => { state.presetDraft = null; state.presetConfirm = p.id }} width={70} height={24} fontSize={10} />}
            </UiEntity>
          </UiEntity>
        )
      })}

      {state.nextSwitch && (
        <UiEntity uiTransform={{ width: '100%', height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { top: 2 } }}>
          <Label value={nextSwitchText(state.nextSwitch, state.presets, Date.now())} fontSize={10} color={C.textDim} textAlign="middle-left" uiTransform={{ width: 230 }} />
          {state.nextSwitch.skippable && (
            <Button label="Skip" width={50} height={24} fontSize={10}
              onPress={() => { const n = state.nextSwitch; if (n && !state.presetBusy) onSceneAction?.('presets_skip', { scheduleId: n.scheduleId, at: n.at }) }} />
          )}
        </UiEntity>
      )}
      {state.presetSkipped && Date.parse(state.presetSkipped.at) > Date.now() && (
        <UiEntity uiTransform={{ width: '100%', height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Label value="Skipped that run. Change schedules on the dashboard." fontSize={10} color={C.textMuted} textAlign="middle-left" uiTransform={{ width: 230 }} />
          <Button label="Undo" width={50} height={24} fontSize={10}
            onPress={() => { const s = state.presetSkipped; if (s && !state.presetBusy) onSceneAction?.('presets_unskip', s) }} />
        </UiEntity>
      )}

      {confirm && (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 4 } }}>
          <Label value={`Make ${presetLabel(confirm.name)} live? Everyone in the scene sees the change.`} fontSize={10} color={C.warning}
            textAlign="top-left" uiTransform={{ width: '100%', height: 28 }} />
          <UiEntity uiTransform={{ width: '100%', height: 28, flexDirection: 'row' }}>
            <Button label={state.presetBusy ? 'Switching…' : 'Make live'} color={C.warning} textColor={C.bg} width={110} height={26} fontSize={11}
              onPress={() => { if (!state.presetBusy) onSceneAction?.('presets_activate', { presetId: confirm.id }) }} />
            <UiEntity uiTransform={{ width: 6 }} />
            <Button label="Cancel" width={80} height={26} fontSize={11} onPress={() => { state.presetConfirm = null }} />
          </UiEntity>
        </UiEntity>
      )}

      {draft ? (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 4 } }}>
          <Input
            uiTransform={{ width: '100%', height: 34, margin: { bottom: 4 } }}
            uiBackground={{ color: C.bgCard }}
            color={C.text}
            placeholderColor={C.textMuted}
            placeholder={draft.mode === 'new' ? 'New preset name' : 'Preset name'}
            fontSize={11}
            value={draft.name}
            onChange={(v) => { if (state.presetDraft) state.presetDraft = { ...state.presetDraft, name: v.slice(0, PRESET_NAME_MAX) } }}
          />
          {draft.mode === 'new' && live && (
            <UiEntity uiTransform={{ width: '100%', height: 28, flexDirection: 'row', margin: { bottom: 4 } }}>
              <Button label={`Copy of ${presetLabel(live.name)}`} color={draft.copy ? C.accent : undefined} width={170} height={26} fontSize={10}
                onPress={() => { if (state.presetDraft) state.presetDraft = { ...state.presetDraft, copy: true, name: copyName(live.name, names) } }} />
              <UiEntity uiTransform={{ width: 6 }} />
              <Button label="Blank" color={!draft.copy ? C.accent : undefined} width={80} height={26} fontSize={10}
                onPress={() => { if (state.presetDraft) state.presetDraft = { ...state.presetDraft, copy: false, name: 'New preset' } }} />
            </UiEntity>
          )}
          <UiEntity uiTransform={{ width: '100%', height: 28, flexDirection: 'row' }}>
            <Button label={state.presetBusy ? 'Saving…' : draft.mode === 'new' ? 'Create' : 'Save'} color={C.accent} width={110} height={26} fontSize={11}
              onPress={() => {
                const name = draft.name.trim()
                if (!name) { state.presetsError = 'Give the preset a name'; return }
                if (state.presetBusy) return
                if (draft.mode === 'new') onSceneAction?.('presets_create', { name, copyOf: draft.copy ? state.activePresetId : null })
                else onSceneAction?.('presets_rename', { presetId: draft.targetId, name })
              }} />
            <UiEntity uiTransform={{ width: 6 }} />
            <Button label="Cancel" width={80} height={26} fontSize={11} onPress={() => { state.presetDraft = null; state.presetsError = null }} />
          </UiEntity>
        </UiEntity>
      ) : (
        <UiEntity uiTransform={{ width: '100%', margin: { top: 4 } }}>
          <Button label="New preset" onPress={startNew} height={28} fontSize={11} />
        </UiEntity>
      )}
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: Stream Control
// ============================================================================

/** The open screen's showings with End now / Play now / Delay (LIV-87). Times are relative, redrawn every frame. */
function ShowingsList() {
  const busy = state.streamBusy
  const now = Date.now()
  const press = (control: ShowControl, showingId: string, title: string) => {
    if (!busy) onSceneAction?.('showings_control', { showingId, control, title })
  }
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 4 } }}>
      {state.showingsNote && (
        <Label value={state.showingsNote.text} fontSize={10} color={state.showingsNote.error ? C.danger : C.success} textAlign="top-left" uiTransform={{ width: '100%', height: 28 }} />
      )}
      {state.showings === null && <Label value={SHOWINGS_LOADING} fontSize={10} color={C.textMuted} uiTransform={{ height: 20 }} />}
      {state.showings !== null && state.showings.length === 0 && <Label value={NO_SHOWINGS} fontSize={10} color={C.textDim} uiTransform={{ height: 20 }} />}
      {(state.showings ?? []).map((s) => {
        const row = showingRow(s, now)
        return (
          <UiEntity key={row.id} uiTransform={{ width: '100%', flexDirection: 'column', padding: 4, margin: { bottom: 2 } }} uiBackground={{ color: C.bg }}>
            <Label value={row.title} fontSize={11} color={C.text} textAlign="middle-left" uiTransform={{ height: 18 }} />
            <Label value={row.status} fontSize={10} color={row.canEnd ? C.success : C.textDim} textAlign="middle-left" uiTransform={{ height: 16 }} />
            {(row.canEnd || row.canPlay || row.canDelay) && (
              <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 2 } }}>
                {row.canEnd && <Button label="End now" color={C.danger} width={80} height={22} fontSize={10} onPress={() => press('end', row.id, row.title)} />}
                {row.canPlay && <Button label="Play now" color={C.success} width={80} height={22} fontSize={10} onPress={() => press('play-now', row.id, row.title)} />}
                {row.canDelay && <UiEntity uiTransform={{ width: 6 }} />}
                {row.canDelay && <Button label={`Delay ${DELAY_STEP_MINUTES} min`} width={90} height={22} fontSize={10} onPress={() => press('delay', row.id, row.title)} />}
              </UiEntity>
            )}
          </UiEntity>
        )
      })}
    </UiEntity>
  )
}

// ============================================================================
// ---------------------------------------------------------------------------

function StreamControlPanel() {
  const busy = state.streamBusy
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="Stream" subtitle="Each screen's live stream and off image" onClose={() => { state.activePanel = null }} />
      <UiEntity uiTransform={{ padding: 8, flexDirection: 'column' }}>
        {!canEdit() ? (
          <Label value="Only the host, co-hosts and editors can change streams" fontSize={11} color={C.textDim} uiTransform={{ height: 24 }} />
        ) : (
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
            {state.streamsError && (
              <Label value={state.streamsError} fontSize={10} color={C.danger} textAlign="top-left" uiTransform={{ width: '100%', height: 28 }} />
            )}
            {!state.streamsLoaded && !state.streamsError && <Label value="Loading…" fontSize={10} color={C.textMuted} uiTransform={{ height: 20 }} />}
            {state.streamsLoaded && state.streamScreens.length === 0 && (
              <Label value="No video screens in this scene" fontSize={11} color={C.textDim} uiTransform={{ height: 24 }} />
            )}
            {state.streamScreens.map((screen) => (
              <UiEntity key={screen.id} uiTransform={{ width: '100%', flexDirection: 'column', padding: 8, margin: { bottom: 2 } }} uiBackground={{ color: C.bgCard }}>
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', height: 20 }}>
                  <Label value={screen.liveOn ? '* LIVE ON' : '  LIVE OFF'} fontSize={10} color={screen.liveOn ? C.success : C.textDim} />
                  <Label value={screen.name} fontSize={11} color={C.text} uiTransform={{ margin: { left: 8 } }} />
                </UiEntity>
                <Label value={screenSourceLabel(screen, state.streams)} fontSize={10} color={C.textDim} textAlign="middle-left" uiTransform={{ height: 18 }} />
                <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 4 } }}>
                  <Button label={state.streamPicking === screen.id ? 'Close list' : 'Choose stream'} width={100} height={24} fontSize={10}
                    onPress={() => { state.offImagePicking = null; state.streamPicking = state.streamPicking === screen.id ? null : screen.id }} />
                  <UiEntity uiTransform={{ width: 6 }} />
                  <Button label={screen.liveOn ? 'Turn live off' : 'Turn live on'} color={screen.liveOn ? C.danger : C.success} width={100} height={24} fontSize={10}
                    onPress={() => { if (!busy) onSceneAction?.('streams_live', { elementId: screen.id, enabled: !screen.liveOn }) }} />
                </UiEntity>
                {state.streamPicking === screen.id && (
                  <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 4 } }}>
                    {state.streams.length === 0 ? (
                      <Label value="No streams yet: set one up on the Streaming page at virvi.io" fontSize={10} color={C.textDim} uiTransform={{ height: 20 }} />
                    ) : state.streams.map((st) => (
                      <Button key={st.id} label={streamOptionLabel(st)} width={240} height={24} fontSize={10}
                        color={st.hlsPlaylistUrl === screen.liveSrc ? C.accent : undefined}
                        onPress={() => { if (!busy) onSceneAction?.('streams_choose', { elementId: screen.id, streamId: st.id }) }} />
                    ))}
                  </UiEntity>
                )}
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { top: 4 } }}>
                  <Label value={offImageLabel(screen, state.streamImages)} fontSize={10} color={C.textDim} textAlign="middle-left" uiTransform={{ width: 160, height: 24 }} />
                  <Button label={state.offImagePicking === screen.id ? 'Close list' : 'Change'} width={70} height={24} fontSize={10}
                    onPress={() => { state.streamPicking = null; state.offImagePicking = state.offImagePicking === screen.id ? null : screen.id }} />
                </UiEntity>
                {state.offImagePicking === screen.id && (
                  <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: 4 } }}>
                    <Label value="Shown when the screen has nothing to play" fontSize={9} color={C.textMuted} uiTransform={{ height: 16 }} />
                    {state.streamImages.length === 0 && (
                      <Label value="No images yet: upload one from the Assets panel" fontSize={10} color={C.textDim} uiTransform={{ height: 20 }} />
                    )}
                    {state.streamImages.slice(0, 8).map((img) => (
                      <Button key={img.id} label={img.name} width={240} height={24} fontSize={10}
                        color={img.url === screen.offImageSrc ? C.accent : undefined}
                        onPress={() => { if (!busy) onSceneAction?.('streams_off_image', { elementId: screen.id, url: img.url }) }} />
                    ))}
                    {state.streamImages.length > 8 && (
                      <Label value={`+${state.streamImages.length - 8} more: choose them on the dashboard`} fontSize={9} color={C.textMuted} uiTransform={{ height: 16 }} />
                    )}
                    {screen.offImageSrc !== '' && (
                      <Button label="No off image" width={240} height={24} fontSize={10}
                        onPress={() => { if (!busy) onSceneAction?.('streams_off_image', { elementId: screen.id, url: '' }) }} />
                    )}
                  </UiEntity>
                )}
                {screen.scheduled && (
                  <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { top: 4 } }}>
                    <Label value="Schedule mode" fontSize={10} color={C.textDim} textAlign="middle-left" uiTransform={{ width: 160, height: 24 }} />
                    <Button label={state.showingsFor === screen.id ? 'Close showings' : 'Showings'} width={90} height={24} fontSize={10}
                      onPress={() => {
                        if (state.showingsFor === screen.id) { state.showingsFor = null; return }
                        state.streamPicking = null
                        state.offImagePicking = null
                        onSceneAction?.('showings_open', { elementId: screen.id })
                      }} />
                  </UiEntity>
                )}
                {screen.scheduled && state.showingsFor === screen.id && <ShowingsList />}
              </UiEntity>
            ))}
          </UiEntity>
        )}
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: World Status
// ---------------------------------------------------------------------------

function WorldStatusPanel() {
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="World Status" onClose={() => { state.activePanel = null }} />
      <UiEntity uiTransform={{ padding: 8, flexDirection: 'column' }}>
        {state.worlds.length === 0 ? (
          <UiEntity uiTransform={{ padding: 16, alignItems: 'center' }}>
            <Label value="No connected worlds" fontSize={12} color={C.textDim} />
          </UiEntity>
        ) : (
          state.worlds.map((world, i) => (
            <UiEntity
              key={i}
              uiTransform={{
                width: '100%',
                height: 46,
                flexDirection: 'column',
                padding: 10,
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: C.bgCard }}
            >
              <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Label value={(world as any).sceneName || (world as any).platform || 'World'} fontSize={11} color={C.text} />
                <Label value={`${(world as any).visitorCount || 0} visitors`} fontSize={10} color={C.textDim} />
              </UiEntity>
              <Label value={(world as any).deploymentStatus || 'unknown'} fontSize={9}
                color={(world as any).deploymentStatus === 'deployed' ? C.success : C.textDim} />
            </UiEntity>
          ))
        )}
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Panel: Notifications
// ---------------------------------------------------------------------------

function NotificationsPanel() {
  return (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
      <PanelHeader title="Notifications" onClose={() => { state.activePanel = null }} />
      <UiEntity uiTransform={{ padding: 8, flexDirection: 'column' }}>
        {state.notifications.length === 0 ? (
          <UiEntity uiTransform={{ padding: 16, alignItems: 'center' }}>
            <Label value="No notifications" fontSize={12} color={C.textDim} />
          </UiEntity>
        ) : (
          state.notifications.slice(0, 20).map((notif, i) => (
            <UiEntity
              key={i}
              uiTransform={{
                width: '100%',
                height: 32,
                flexDirection: 'row',
                alignItems: 'center',
                padding: { left: 10, right: 10 },
                margin: { bottom: 2 },
              }}
              uiBackground={{ color: C.bgCard }}
            >
              <Label value={notif.message || notif.title || ''} fontSize={10} color={C.text} />
            </UiEntity>
          ))
        )}
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Upgrade Prompt
// ---------------------------------------------------------------------------

function UpgradePrompt() {
  if (!state.upgradePrompt) return null
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: '30%', left: '25%' },
        width: '50%',
        flexDirection: 'column',
        padding: 16,
      }}
      uiBackground={{ color: C.bg }}
      onMouseDown={markHudPress}
    >
      <Label value="Upgrade Required" fontSize={16} color={C.warning} />
      <Label value={`The "${state.upgradePrompt.feature}" feature requires the ${state.upgradePrompt.tier} tier.`}
        fontSize={12} color={C.text} uiTransform={{ margin: { top: 8 } }} />
      <UiEntity uiTransform={{ margin: { top: 12 } }}>
        <Button label="OK" color={C.accent} width={100}
          onPress={() => { state.upgradePrompt = null }} />
      </UiEntity>
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Notification Toast (overlay)
// ---------------------------------------------------------------------------

function NotificationToast() {
  const recent = state.notifications.slice(0, 3)
  if (recent.length === 0) return null

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: 60, right: 12 },
        width: 280,
        flexDirection: 'column',
      }}
      onMouseDown={markHudPress}
    >
      {recent.map((notif, i) => (
        <UiEntity
          key={i}
          uiTransform={{
            width: '100%',
            height: 30,
            alignItems: 'center',
            padding: { left: 10, right: 10 },
            margin: { bottom: 4 },
          }}
          uiBackground={{ color: C.bg }}
        >
          <Label value={notif.message || notif.title || ''} fontSize={10} color={C.text} />
        </UiEntity>
      ))}
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// Main HUD Component
// ---------------------------------------------------------------------------

function VirviHUD() {
  const isSetup = state.connectionState !== 'connected' || state.isNewScene

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}>
      <HUDToggleButton />

      {state.hudVisible && (() => {
        // Land owner/operator/deployer, not set up yet: the one-press setup card
        if (state.setupOffer) {
          return <SetupOfferScreen />
        }

        // Pre-connection: show setup flow
        if (state.connectionState === 'idle' ||
            state.connectionState === 'authenticating' ||
            state.connectionState === 'connecting' ||
            state.connectionState === 'error') {
          return <ConnectingScreen />
        }

        // Authenticated but needs scene selection/creation
        if (state.connectionState === 'authenticated' ||
            state.connectionState === 'discovering_scene') {
          if (state.userScenes.length > 0 || state.connectionState === 'authenticated') {
            return <SceneSetupScreen />
          }
          return <ConnectingScreen />
        }

        // Scene ready but not yet connected to Colyseus
        if (state.connectionState === 'scene_ready') {
          return <ConnectingScreen />
        }

        // Connected — show new scene banner or management panels
        if (state.connectionState === 'connected') {
          if (state.isNewScene) {
            return <ConnectedBanner />
          }

          if (state.activePanel !== null) {
            return (
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { right: 12, top: 62 },
                  width: 340,
                  maxHeight: 520,
                  flexDirection: 'column',
                }}
                uiBackground={{ color: C.bg }}
                onMouseDown={markHudPress}
              >
                <NavBar />
                <SyncNotice />
                {state.activePanel === HUDPanelType.SCENE_LAYOUT && <SceneLayoutPanel />}
                {state.activePanel === HUDPanelType.ASSET_BROWSER && <AssetBrowserPanel />}
                {state.activePanel === HUDPanelType.EVENT_CONTROL && <EventControlPanel />}
                {state.activePanel === HUDPanelType.STREAM_CONTROL && <StreamControlPanel />}
                {state.activePanel === HUDPanelType.WORLD_STATUS && <WorldStatusPanel />}
                {state.activePanel === HUDPanelType.NOTIFICATIONS && <NotificationsPanel />}
                {state.activePanel === HUDPanelType.ROLES && <RolesPanel />}
              </UiEntity>
            )
          }

          // No panel open yet: show the toolbar on its own so a panel can be picked
          // (otherwise the connected HUD renders nothing and the Virvi button appears dead)
          return (
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position: { right: 12, top: 62 },
                width: 340,
                flexDirection: 'column',
              }}
              uiBackground={{ color: C.bg }}
              onMouseDown={markHudPress}
            >
              <NavBar />
              <SyncNotice />
            </UiEntity>
          )
        }

        return null
      })()}

      {state.hudVisible && state.connectionState === 'connected' && !state.isNewScene && <NotificationToast />}
      {/* Stays up when the HUD is toggled off, so Done is always reachable */}
      {state.connectionState === 'connected' && state.editMode.active && canEdit() && (
        <EditModeBar s={state.editMode} act={(a, d) => onSceneAction?.(a, d)} />
      )}
      <UpgradePrompt />
    </UiEntity>
  )
}

// ---------------------------------------------------------------------------
// DclHUDRenderer — implements HUDRenderer + setup state management
// ---------------------------------------------------------------------------

/** Switches the launcher to its text V when the scene's files don't include the icon (unknown: keep the image). */
async function checkHudIcon(): Promise<void> {
  try {
    const { getSceneInformation } = await import('~system/Runtime' as any)
    const info = await getSceneInformation({})
    if (hudIconInScene(info?.content) === false) {
      state.hudIconMissing = true
      console.log(HUD_ICON_MISSING_HINT)
    }
  } catch {
    // Outside the DCL runtime: keep the image
  }
}

export class DclHUDRenderer implements HUDRenderer {
  private initialized = false

  init() {
    if (this.initialized) return
    this.initialized = true
    // Added alongside the scene's own UI (setUiRenderer would replace it). Sizes are 1920x1080 design
    // pixels, scaled to the screen by the SDK's virtual canvas (so the HUD isn't tiny on high-DPI screens);
    // a virtual size set by the scene's main UI takes precedence. zIndex keeps the HUD above the scene's UI.
    ReactEcsRenderer.addUiRenderer(engine.addEntity(), VirviHUD, { virtualWidth: 1920, virtualHeight: 1080, zIndex: 1000 })
    console.log('[Virvi HUD] DCL HUD renderer initialized')
    void checkHudIcon()
  }

  // --- Connection state updates (called by the createVirvi flow) ---

  updateConnectionState(connectionState: VirviConnectionState, detail?: Record<string, unknown>): void {
    state.connectionState = connectionState

    if (detail?.error) {
      state.errorMessage = String(detail.error)
    }
    if (detail?.user) {
      const user = detail.user as any
      state.userName = user.displayName || user.email || null
    }
    if (detail?.scenes) {
      state.userScenes = detail.scenes as Scene[]
    }
    if (detail?.sceneId) {
      state.currentSceneId = detail.sceneId as string
    }
    if (detail?.sceneName) {
      state.currentSceneName = detail.sceneName as string
    }
    if (detail?.isNew) {
      state.isNewScene = true
    }

    // Auto-set status messages
    const messages: Record<string, string> = {
      idle: 'Initializing...',
      authenticating: 'Signing in with your wallet...',
      authenticated: 'Authenticated!',
      discovering_scene: 'Finding your scenes...',
      scene_ready: 'Connecting to scene...',
      connecting: 'Joining scene room...',
      connected: 'Connected!',
      error: 'Something went wrong',
    }
    state.statusMessage = messages[connectionState] || ''
  }

  // --- In-world setup + roles (called by the createVirvi flow) ---

  showSetupOffer(message?: string): void {
    state.setupOffer = true
    state.setupMessage = message ?? null
    state.connectionState = 'idle'
    state.hudVisible = true
  }

  setSceneRole(role: SceneRole): void {
    state.sceneRole = role
    state.setupOffer = false
    if (role !== 'host') state.confirmTransfer = null
    if (role !== 'host' && role !== 'cohost' && state.activePanel === HUDPanelType.ROLES) state.activePanel = null
  }

  setRoles(data: RolesData): void {
    state.roles = data
  }

  setRolesError(msg: string | null): void {
    state.rolesError = msg
  }

  /** Empty the paste-an-address field after a successful add. */
  clearRoleDraft(): void {
    state.roleDraftWallet = ''
  }

  // --- Presets (called by the createVirvi flow; LIV-84) ---

  setPresets(list: HUDPreset[], activeId?: string | null): void {
    state.presets = list
    if (activeId !== undefined) state.activePresetId = activeId
    state.presetsLoaded = true
    if (state.presetConfirm && !list.some((p) => p.id === state.presetConfirm)) state.presetConfirm = null
  }

  setNextSwitch(next: HUDNextSwitch | null): void {
    state.nextSwitch = next
  }

  /** The run just skipped from the HUD (null after Undo). */
  setSkipped(skipped: { scheduleId: string; at: string } | null): void {
    state.presetSkipped = skipped
  }

  setActivePreset(id: string): void {
    state.activePresetId = id
    if (state.presetConfirm === id) state.presetConfirm = null
  }

  // --- Stream panel (called by the createVirvi flow; LIV-53) ---

  setStreams(screens: HUDScreen[], streams: HUDStream[], images: HUDImage[] = []): void {
    state.streamScreens = screens
    state.streams = streams
    state.streamImages = images
    state.streamsLoaded = true
    state.streamsError = null
    if (state.streamPicking && !screens.some((x) => x.id === state.streamPicking)) state.streamPicking = null
    if (state.offImagePicking && !screens.some((x) => x.id === state.offImagePicking)) state.offImagePicking = null
    if (state.showingsFor && !screens.some((x) => x.id === state.showingsFor && x.scheduled)) state.showingsFor = null
  }

  setStreamsError(msg: string | null): void {
    state.streamsError = msg
  }

  setStreamBusy(busy: boolean): void {
    state.streamBusy = busy
  }

  /** Open a screen's showings list (null shows "Loading…"), or fill it in. */
  setShowings(elementId: string, showings: HUDShowing[] | null): void {
    if (state.showingsFor !== elementId) state.showingsNote = null
    state.showingsFor = elementId
    state.showings = showings
  }

  showingsOpenFor(): string | null {
    return state.showingsFor
  }

  setShowingsNote(text: string | null, error = false): void {
    state.showingsNote = text ? { text, error } : null
  }

  /** A stream or off image was chosen: close the list. */
  streamChosen(): void {
    state.streamPicking = null
    state.offImagePicking = null
  }

  setPresetsError(msg: string | null): void {
    state.presetsError = msg
  }

  setPresetBusy(busy: boolean): void {
    state.presetBusy = busy
  }

  /** A create or rename went through, or a switch was made: close the draft / confirmation. */
  presetDone(): void {
    state.presetDraft = null
    state.presetConfirm = null
    state.presetsError = null
  }

  // --- Media library + layout editing (called by the createVirvi flow) ---

  setMedia(list: HUDMediaItem[]): void {
    state.media = list
    state.mediaLoaded = true
    state.mediaFailed = false
  }

  setLayout(list: HUDLayoutItem[]): void {
    state.layout = list
    state.layoutLoaded = true
    state.layoutFailed = false
    if (state.confirmDelete && !list.some((el) => el.id === state.confirmDelete)) state.confirmDelete = null
    if (state.confirmClear && !list.some((el) => el.id === state.confirmClear && el.copies > 0)) state.confirmClear = null
    if (state.clicking && !list.some((el) => el.id === state.clicking!.elementId)) state.clicking = null
  }

  /** A click action was saved (LIV-126): close the editor; or it was refused: say why there. */
  clickSaved(error: string | null = null): void {
    if (error) state.clickError = error
    else {
      state.clicking = null
      state.clickError = null
    }
  }

  /** A media / layout refresh failed: stop showing "Loading…" (the error goes to setEditMessage). */
  setLoadFailed(list: 'media' | 'layout'): void {
    if (list === 'media') {
      state.mediaLoaded = true
      state.mediaFailed = true
    } else {
      state.layoutLoaded = true
      state.layoutFailed = true
    }
  }

  /** Mirrors DclEditMode.state (the bar shows while active). */
  setEditMode(s: EditModeHUDState): void {
    state.editMode = s
  }

  setRenaming(r: { id: string; draft: string } | null): void {
    state.renaming = r
  }

  setUploadView(v: Partial<UploadViewState>): void {
    state.upload = { ...state.upload, ...v }
  }

  setMissingModels(n: number): void {
    state.missingModels = n
  }

  /** A one-line result for the Assets / Layout panels (null clears it). */
  setEditMessage(text: string | null, error = false, action?: { label: string; action: string }): void {
    state.editMessage = text === null ? null : { text, error, action }
  }

  setScenes(scenes: Scene[]): void {
    state.userScenes = scenes
  }

  setCurrentScene(sceneId: string, sceneName: string): void {
    state.currentSceneId = sceneId
    state.currentSceneName = sceneName
  }

  // --- HUDRenderer interface ---

  showPanel(panel: HUDPanelType, panelState: HUDPanelState): void {
    state.activePanel = panel
    state.panelStates.set(panel, panelState)
  }

  hidePanel(panel: HUDPanelType): void {
    if (state.activePanel === panel) {
      state.activePanel = null
    }
  }

  renderAssetGrid(assets: AssetThumbnail[]): void {
    state.assets = assets
  }

  showTransformGizmo(_entity: EntityHandle, _mode: 'move' | 'rotate' | 'scale'): void {
    // DCL doesn't support custom transform gizmos in screen-space UI
  }

  hideTransformGizmo(): void {}

  showNotification(notification: HUDNotification): void {
    state.notifications = [notification, ...state.notifications].slice(0, 50)
    setTimeout(() => {
      state.notifications = state.notifications.filter(n => n !== notification)
    }, 5000)
  }

  renderBudgetMeter(usage: BudgetUsage, limits: BudgetLimits): void {
    state.budgetUsage = usage
    state.budgetLimits = limits
  }

  showUpgradePrompt(feature: string, tier: string): void {
    state.upgradePrompt = { feature, tier }
  }

  renderWorldStatusGrid(worlds: WorldStatus[]): void {
    state.worlds = worlds
  }

  supportsPanel(panel: HUDPanelType): boolean {
    return true
  }
}
