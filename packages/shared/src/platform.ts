import { Vec3, TransformData } from './types/math.js';
import type { Quat } from './ads.js';
import type { AnalyticsSceneRef } from './analytics.js';

// ---------------------------------------------------------------------------
// Platform adapter — the single interface every metaverse platform implements
// ---------------------------------------------------------------------------

export interface VirviPlatformAdapter {
  // --- Identity & Auth ---
  /** Get the current user's platform-specific identity */
  getPlatformUser(): Promise<PlatformUser>;
  /** Get a signed authentication proof (e.g., wallet signature, platform token) */
  getAuthProof(): Promise<AuthProof>;
  /**
   * Make an authenticated platform request.
   * Platforms like DCL use signedFetch which adds cryptographic auth headers.
   * If not implemented, falls back to regular fetch with proof in body.
   */
  signedRequest?(url: string, init: { method: string; body: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }>;
  /** Optional analytics probe; adapters without one produce no automatic analytics. */
  analytics?: AnalyticsProbe;
  /** Where this scene is, for analytics ingestion. */
  getAnalyticsScene?(): Promise<AnalyticsSceneRef>;

  // --- Scene Metadata ---
  /** Get scene metadata from the platform (ID, location, realm, etc.) */
  getSceneInfo(): Promise<SceneInfo>;
  /** Get platform environment details (preview mode, platform name, etc.) */
  getEnvironment(): Promise<PlatformEnvironment>;

  // --- Entity Lifecycle ---
  createEntity(): EntityHandle;
  /** Optional: give the entity a display name, which analytics report for clicks on it. Without it, clicks on Virvi items are anonymous. */
  setName?(entity: EntityHandle, name: string): void;
  destroyEntity(handle: EntityHandle): void;
  entityExists(handle: EntityHandle): boolean;

  // --- Transform ---
  setTransform(entity: EntityHandle, transform: TransformData): void;

  // --- Rendering ---
  setPlaneRenderer(entity: EntityHandle): void;
  setGltfModel(entity: EntityHandle, src: string): void;
  /**
   * Optional: map an element's modelSrc to what this platform can load.
   * Return the src to use, or null when the model is unavailable (no entity is created).
   * Must be synchronous. Adapters without it use modelSrc as-is.
   */
  resolveModelSrc?(src: string): string | null;
  setMaterial(entity: EntityHandle, material: MaterialData): void;
  setVideoMaterial(entity: EntityHandle, video: VideoMaterialData): void;
  /** Optional: show text on the entity (the "Ad" label). Without it, ads show no label. */
  setText?(entity: EntityHandle, text: string, opts: { fontSize: number }): void;

  // --- Video ---
  createVideoPlayer(entity: EntityHandle, options: VideoPlayerOptions): void;
  updateVideoSource(entity: EntityHandle, src: string): void;
  setVideoVolume(entity: EntityHandle, volume: number): void;
  getVideoState(entity: EntityHandle): VideoState;
  /**
   * Optional: call cb when the video playing on this entity reaches its end. A later call for the same entity
   * replaces the callback. Without it, playlists don't advance and video ads never play.
   */
  onVideoEnded?(entity: EntityHandle, cb: () => void): void;

  // --- Audio ---
  setAudioSource(entity: EntityHandle, options: AudioOptions): void;
  playAudio(entity: EntityHandle): void;
  stopAudio(entity: EntityHandle): void;

  // --- Physics ---
  setCollider(entity: EntityHandle, options: ColliderOptions): void;
  removeCollider(entity: EntityHandle): void;

  // --- Input ---
  onPointerDown(
    entity: EntityHandle,
    options: PointerOptions,
    cb: PointerCallback,
  ): void;
  removePointerEvents(entity: EntityHandle): void;
  /**
   * Optional: call onEnter / onLeave when the pointer starts / stops hovering the entity within maxDistance.
   * removePointerEvents removes these too. Without it, ads record no look events.
   */
  onPointerHover?(entity: EntityHandle, onEnter: () => void, onLeave: () => void, maxDistance: number): void;

  // --- Player Actions ---
  openUrl(url: string): void;
  teleportPlayer(destination: string): void;
  movePlayer(position: Vec3, cameraTarget?: Vec3): void;
  triggerEmote(emoteId: string): void;
  /** Optional: the camera's world pose, or null when unknown. Without it, ads record no on-screen events. */
  getCameraPose?(): { position: Vec3; rotation: Quat } | null;

  // --- Frame Loop ---
  registerSystem(update: (dt: number) => void): void;
  unregisterSystem(update: (dt: number) => void): void;

  // --- Capabilities ---
  readonly capabilities: PlatformCapabilities;
}

export interface AnalyticsProbe {
  getPlayerPose(): { position: Vec3; headingDeg: number } | null;
  getCameraMode(): 'first' | 'third' | null;
  isInsideScene(position: Vec3): boolean;
  pollInteractions(): Array<{ kind: 'click' | 'hover'; target: string }>;
  pollVideoEvents(): Array<{ target: string; state: 'play' | 'pause' | 'end' | 'error' }>;
  pollEmotes(): string[];
  showNotice(text: string): void;
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export type EntityHandle = number | string;

export interface PlatformCapabilities {
  video: boolean;
  spatialAudio: boolean;
  gltfModels: boolean;
  customEmotes: boolean;
  playerTeleport: boolean;
  externalUrls: boolean;
  nftDisplay: boolean;
  colliders: boolean;
  spatialUI: boolean;
  screenSpaceUI: boolean;
  maxEntities?: number;
  platformName: string;
  platformVersion?: string;
}

export interface PlatformUser {
  id: string;
  displayName?: string;
  walletAddress?: string;
  isGuest: boolean;
  avatarUrl?: string;
}

export interface AuthProof {
  type: 'signed-fetch' | 'wallet-signature' | 'platform-token' | 'api-key';
  payload: Record<string, unknown>;
}

export interface SceneInfo {
  sceneId: string;
  platformSceneId?: string;
  location?: string;
  metadata?: Record<string, unknown>;
}

export interface PlatformEnvironment {
  isPreview: boolean;
  platformName: string;
  platformVersion?: string;
  realm?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Parameter types used by the adapter methods
// ---------------------------------------------------------------------------

export interface MaterialData {
  textureSrc?: string;
  bumpSrc?: string;
  emissiveSrc?: string;
  alphaSrc?: string;
  emission?: number;
  castShadows?: boolean;
  isTransparent?: boolean;
  albedoColor?: { r: number; g: number; b: number; a: number };
}

export interface VideoMaterialData {
  videoPlayerEntity: EntityHandle;
  emission?: number;
  isTransparent?: boolean;
}

export interface VideoPlayerOptions {
  src: string;
  playing?: boolean;
  volume?: number;
  loop?: boolean;
  playbackRate?: number;
}

export enum VideoState {
  NONE = 0,
  LOADING = 1,
  READY = 2,
  PLAYING = 3,
  BUFFERING = 4,
  ERROR = 5,
  SEEKING = 6,
  PAUSED = 7,
}

export interface AudioOptions {
  src: string;
  loop?: boolean;
  volume?: number;
  playing?: boolean;
  global?: boolean;
}

export interface ColliderOptions {
  type: 'box' | 'sphere' | 'mesh';
  isTrigger?: boolean;
}

export interface PointerOptions {
  hoverText?: string;
  maxDistance?: number;
  showFeedback?: boolean;
  button?: 'primary' | 'secondary' | 'action3' | 'action4' | 'action5' | 'action6';
}

export type PointerCallback = (event: PointerEventData) => void;

export interface PointerEventData {
  entityHandle: EntityHandle;
  button: string;
  origin: Vec3;
  direction: Vec3;
  hitPosition?: Vec3;
  hitNormal?: Vec3;
}
