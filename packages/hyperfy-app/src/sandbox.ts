/**
 * The Hyperfy 0.16 script globals as the Virvi app uses them, and the messages its two halves exchange. Only types:
 * the modules that need a global take it as an argument, so app.ts stays the one place that reads the sandbox.
 */
import type { HyperfyVouchResponse, SerializedScene } from '@virvixr/shared'
import type { RenderedItem } from './edit/controller.js'
import type { GizmoNode } from './edit/gizmo.js'
import type { RenderItem } from './plan.js'
import type { ScriptFetch, ScriptSetTimeout } from './poller.js'
import type { VirviTransform } from './virvi-api.js'

export type Vec = { x: number; y: number; z: number; fromArray(a: number[]): unknown }
export interface HNode {
  position: Vec
  rotation: { set(x: number, y: number, z: number, order: string): unknown }
  scale: Vec
  onPointerDown?: (() => void) | undefined
  play?: () => void
  /** Video nodes: whether it is playing, and where it is and how long it is, in seconds (0 until it loads). */
  playing?: boolean
  time?: number
  duration?: number
  add(child: HNode): void
  [prop: string]: unknown
}
export interface HPlayer {
  id: string
  name?: string
  admin?: boolean
  builder?: boolean
  position: { x: number; y: number; z: number }
}
export type XYZ = { x: number; y: number; z: number }
export interface HButton {
  onPress: (() => boolean | void) | null
  down: boolean
  released: boolean
}
/** What the HUD uses of `app.control()` (client only). */
export interface HControl {
  keyL: HButton
  mouseLeft: HButton
  pointer: { locked: boolean; coords: XYZ }
  camera: { position: XYZ; quaternion: XYZ & { w: number }; zoom: number }
  screen: { width: number; height: number }
  /** Every key press, with its text (`e.key`); returning true captures it. */
  onButtonPress?: (prop: string, text: string) => boolean
}
export interface HWorld {
  isServer: boolean
  isClient: boolean
  on(name: 'enter' | 'leave', cb: (e: { playerId: string }) => void): void
  /** A chat line starting with '/' (kept off the chat log). The client gets its own player's, with `cmd` and `value`. */
  on(
    name: 'command',
    cb: (e: { playerId: string; cmd?: string; value?: string; args?: string[] }) => void,
  ): void
  getPlayers(): HPlayer[]
  /** The local player (client) or the player with this id. */
  getPlayer(id?: string): HPlayer | null
  load(type: 'model', url: string): Promise<HNode>
  open(url: string, newWindow?: boolean): void
}
export type Matrix = { elements: ArrayLike<number> }
export interface HApp {
  /** The app root's world matrix (Hyperfy forwards unknown app props to the root node). */
  matrixWorld: Matrix
  /**
   * A Virvi-hosted world's server half only: the image vouches for a player with Virvi from Node, holding the world secret
   * itself. Undefined anywhere else (self-run worlds, clients, other apps, an edited Virvi script).
   */
  virviVouch?: VirviVouch
  configure(fields: Array<{ key: string; type: 'text'; label: string; initial: string }>): void
  on(name: string, cb: (data: unknown, networkId?: string) => void): void
  send(name: string, data: unknown): void
  sendTo(playerId: string, name: string, data: unknown): void
  create(type: 'video' | 'image' | 'audio' | 'group'): HNode
  create(
    type: 'ui' | 'uiview' | 'uitext' | 'uiimage' | 'prim',
    data?: Record<string, unknown>,
  ): HNode
  add(node: HNode | GizmoNode | object): void
  remove(node: HNode | GizmoNode | object): void
  control(): HControl
}
/** What the server half asks `app.virviVouch` for: the player to vouch for, and their pending pairing when polling. */
export interface VirviVouchRequest {
  hyperfyPlayerId: string
  playerName: string | null
  pendingPairingId?: string
}
/**
 * Virvi's vouch answer as the image passes it on (only the expected fields): `unauthorized` when Virvi refuses the world's
 * secret (HTTP 401), `error` on any other failure.
 */
export type VirviVouchResult = HyperfyVouchResponse | { status: 'unauthorized' } | { status: 'error' }
export type VirviVouch = (req: VirviVouchRequest) => Promise<VirviVouchResult>
export type Matrix4Ctor = new () => Matrix & { copy(m: Matrix): Matrix & { invert(): Matrix } }
/** `hudIcon` is a file prop the .hyp ships (not configurable): the HUD's Virvi V, served from the world's assets. */
export type AppProps = { feedUrl?: string; worldKey?: string; hudIcon?: { url?: string } | null }
export type { ScriptFetch, ScriptSetTimeout }

/** Client asks its server half to link it (and, linked, for a fresh pass); the server half answers that player only. */
export const LINK = 'virvi:link'
/** What the client sends on LINK: its attempt number, which every answer echoes. */
export type LinkRequest = { attempt: number }
/** What the server half sends back on LINK (plus the request's `attempt`). 'self': this world can't vouch, pair from the browser. */
export type LinkReply =
  | { status: 'self' }
  | {
      status: 'linked'
      pass: string
      passExpiresAt: string
      pairingId: string
      sceneId: string
      displayName: string
    }
  | { status: 'unlinked'; code: string; approveUrl: string; qrUrl: string; expiresAt: string }
  | { status: 'expired' }
  | { status: 'lost' }

/** What the client half offers edit mode and the HUD. */
export interface ClientEditHooks {
  /** Swaps every Virvi node's click: select (while editing) or open its link. */
  setEditing(on: boolean, select: (key: string) => void): void
  items(): Map<string, RenderedItem>
  preview(key: string, t: VirviTransform): void
  restore(key: string): void
  /** Called after each snapshot is applied, with the previous and the new plan and the new scene. */
  onPlan(cb: (prev: RenderItem[], next: RenderItem[], scene: SerializedScene | null) => void): void
}
