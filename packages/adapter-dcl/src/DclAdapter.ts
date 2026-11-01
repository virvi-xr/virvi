import {
  engine,
  Entity,
  Transform,
  MeshRenderer,
  MeshCollider,
  Material,
  VideoPlayer,
  AudioSource,
  GltfContainer,
  Name,
  ColliderLayer,
  InputAction,
  PointerEvents,
  pointerEventsSystem,
  TextShape,
  VideoEvent,
  videoEventsSystem,
  VideoState as DclVideoState,
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'
import type {
  VirviPlatformAdapter,
  PlatformCapabilities,
  PlatformUser,
  AuthProof,
  SceneInfo,
  PlatformEnvironment,
  EntityHandle,
  TransformData,
  MaterialData,
  VideoMaterialData,
  VideoPlayerOptions,
  VideoState,
  AudioOptions,
  ColliderOptions,
  PointerOptions,
  PointerCallback,
  Vec3,
  Quat,
} from '@virvixr/shared'
import { localModelFile } from '@virvixr/shared'

export class DclAdapter implements VirviPlatformAdapter {
  // Video player entities -- DCL uses a separate entity for the VideoPlayer component
  private videoPlayerEntities: Map<number, Entity> = new Map()

  // Video end callbacks by display entity. `ended` is true while the video sits at its end, so one playback fires once.
  private videoEndWatchers: Map<number, { cb: () => void; ended: boolean }> = new Map()
  private videoEndSystemAdded = false

  // Entities with hover handlers registered; a destroyed entity is dropped so its callbacks never fire.
  private hoverEntities: Set<number> = new Set()

  // Files deployed with this scene (lowercased path -> path as deployed), from getSceneInformation().content.
  // Decentraland can't load GLBs from URLs, so Virvi-hosted models must be synced into models/virvi/.
  // Loaded once; getSceneInfo() awaits it, and Virvi.authenticate() awaits getSceneInfo() before
  // joining the scene room, so the set is ready before any model element is created.
  private sceneFiles: Map<string, string> = new Map()
  private sceneFilesReady: Promise<void>

  constructor() {
    this.sceneFilesReady = this.loadSceneFiles()
  }

  private async loadSceneFiles(): Promise<void> {
    try {
      const { getSceneInformation } = await import('~system/Runtime' as any)
      const info = await getSceneInformation({})
      for (const entry of (info?.content ?? []) as Array<{ file?: string }>) {
        if (entry?.file) this.sceneFiles.set(entry.file.toLowerCase(), entry.file)
      }
    } catch {
      // Outside the DCL runtime: no deployed files known; URL models resolve to null (missing).
    }
  }

  readonly capabilities: PlatformCapabilities = {
    video: true,
    spatialAudio: true,
    gltfModels: true,
    customEmotes: true,
    playerTeleport: true,
    externalUrls: true,
    nftDisplay: true,
    colliders: true,
    spatialUI: false,
    screenSpaceUI: true,
    platformName: 'decentraland',
    platformVersion: '7',
  }

  // ---------------------------------------------------------------------------
  // Identity & Auth
  // ---------------------------------------------------------------------------

  async getPlatformUser(): Promise<PlatformUser> {
    // Try modern getPlayer() first (SDK 7.4+)
    try {
      const { getPlayer } = await import('@dcl/sdk/players' as any)
      const player = getPlayer?.()
      if (player) {
        return {
          id: player.userId || '',
          displayName: player.name,
          walletAddress: player.userId,
          isGuest: player.isGuest ?? true,
        }
      }
    } catch {
      // Fall through to legacy API
    }

    // Fallback to deprecated getUserData
    try {
      const { getUserData } = await import('~system/UserIdentity' as any)
      const data = await getUserData({})
      return {
        id: data.data?.userId || '',
        displayName: data.data?.displayName,
        walletAddress: data.data?.publicKey,
        isGuest: !data.data?.hasConnectedWeb3,
      }
    } catch {
      // Fall through to default
    }

    return { id: '', isGuest: true }
  }

  async getAuthProof(): Promise<AuthProof> {
    try {
      await import('~system/SignedFetch' as any)
      return {
        type: 'signed-fetch',
        payload: {},
      }
    } catch {
      return { type: 'api-key', payload: {} }
    }
  }

  /**
   * Make an HTTP request using DCL's signedFetch.
   * The DCL runtime automatically adds AuthChain headers that prove
   * the request comes from the player's Ethereum wallet.
   */
  async signedRequest(url: string, init: { method: string; body: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
    try {
      const { signedFetch } = await import('~system/SignedFetch' as any)
      const response = await signedFetch({
        url,
        init: {
          method: init.method,
          headers: {
            'Content-Type': 'application/json',
            ...init.headers,
          },
          body: init.body,
        },
      })
      return {
        status: response.ok ? 200 : (response.status || 500),
        body: response.body || '',
      }
    } catch (err) {
      // signedFetch not available (outside DCL runtime) — fall back to regular fetch
      const response = await fetch(url, {
        method: init.method,
        headers: {
          'Content-Type': 'application/json',
          ...init.headers,
        },
        body: init.body,
      })
      return {
        status: response.status,
        body: await response.text(),
      }
    }
  }

  async getSceneInfo(): Promise<SceneInfo> {
    await this.sceneFilesReady
    try {
      const { getSceneInformation } = await import('~system/Runtime' as any)
      const info = await getSceneInformation({})
      const metadata = JSON.parse(info.metadataJson)
      return {
        sceneId: metadata.virvi?.sceneId || '',
        platformSceneId: info.urn,
        location: metadata.scene?.base,
        metadata: {
          parcels: metadata.scene?.parcels,
          title: metadata.display?.title,
          runtimeVersion: metadata.runtimeVersion,
        },
      }
    } catch {
      return { sceneId: '' }
    }
  }

  async getAnalyticsScene() {
    const { getAnalyticsSceneRef } = await import('./analytics.js')
    return getAnalyticsSceneRef()
  }

  async getEnvironment(): Promise<PlatformEnvironment> {
    try {
      const { isPreviewMode, getPlatform, getCurrentRealm } = await import(
        '~system/EnvironmentApi' as any
      )
      const [preview, platform, realm] = await Promise.all([
        isPreviewMode({}),
        getPlatform({}),
        getCurrentRealm({}),
      ])
      return {
        isPreview: preview.isPreview,
        platformName: 'decentraland',
        platformVersion: '7',
        realm: realm.currentRealm?.serverName,
        metadata: { subPlatform: platform.platform },
      }
    } catch {
      return { isPreview: false, platformName: 'decentraland' }
    }
  }

  // ---------------------------------------------------------------------------
  // Entity Lifecycle
  // ---------------------------------------------------------------------------

  createEntity(): EntityHandle {
    return engine.addEntity()
  }

  setName(entity: EntityHandle, name: string): void {
    Name.createOrReplace(entity as Entity, { value: name })
  }

  destroyEntity(handle: EntityHandle): void {
    this.hoverEntities.delete(handle as number)
    this.videoEndWatchers.delete(handle as number)
    engine.removeEntity(handle as Entity)
    // Clean up associated video player entity
    const vpEntity = this.videoPlayerEntities.get(handle as number)
    if (vpEntity) {
      engine.removeEntity(vpEntity)
      this.videoPlayerEntities.delete(handle as number)
    }
  }

  entityExists(handle: EntityHandle): boolean {
    try {
      return (
        Transform.has(handle as Entity) ||
        engine.getEntityState(handle as Entity) !== undefined
      )
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Transform
  // ---------------------------------------------------------------------------

  setTransform(entity: EntityHandle, transform: TransformData): void {
    const { position, rotation, scale } = transform
    Transform.createOrReplace(entity as Entity, {
      position: Vector3.create(position.x, position.y, position.z),
      rotation: Quaternion.fromEulerDegrees(rotation.x, rotation.y, rotation.z),
      scale: Vector3.create(scale.x, scale.y, scale.z),
    })
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  setPlaneRenderer(entity: EntityHandle): void {
    MeshRenderer.setPlane(entity as Entity, [
      // North side UVs
      0, 0, 0, 1, 1, 1, 1, 0,
      // South side UVs
      0, 0, 0, 1, 1, 1, 1, 0,
    ])
  }

  setGltfModel(entity: EntityHandle, src: string): void {
    GltfContainer.createOrReplace(entity as Entity, { src })
  }

  /**
   * Virvi-hosted GLB URL -> its synced `models/virvi/<basename>` file, or null when that file isn't
   * deployed with the scene. Decentraland can't load models from URLs, so any other http(s) URL
   * (.gltf, extensionless, …) is null too (reported missing, never a broken GltfContainer).
   * Non-URL srcs (scene-relative paths) are passed through unchanged.
   */
  resolveModelSrc(src: string): string | null {
    const local = localModelFile(src)
    if (local === null) return /^https?:\/\//i.test(src.trim()) ? null : src
    return this.sceneFiles.get(local.toLowerCase()) ?? null
  }

  setMaterial(entity: EntityHandle, material: MaterialData): void {
    const texture = material.textureSrc
      ? Material.Texture.Common({ src: material.textureSrc })
      : undefined

    Material.setPbrMaterial(entity as Entity, {
      texture,
      emissiveTexture: texture,
      emissiveIntensity: material.emission ?? 0.6,
      emissiveColor: Color3.White(),
      roughness: 1.0,
      metallic: 0,
      specularIntensity: 0,
      transparencyMode: material.isTransparent ? 2 : 0, // ALPHA_TEST_AND_BLEND or OPAQUE
    })
  }

  setVideoMaterial(entity: EntityHandle, video: VideoMaterialData): void {
    const vpEntity = video.videoPlayerEntity as Entity
    const videoTexture = Material.Texture.Video({ videoPlayerEntity: vpEntity })

    Material.setPbrMaterial(entity as Entity, {
      texture: videoTexture,
      emissiveTexture: videoTexture,
      emissiveIntensity: video.emission ?? 0.6,
      emissiveColor: Color3.White(),
      roughness: 1.0,
      metallic: 0,
      specularIntensity: 0,
    })
  }

  // ---------------------------------------------------------------------------
  // Video
  // ---------------------------------------------------------------------------

  createVideoPlayer(entity: EntityHandle, options: VideoPlayerOptions): void {
    // DCL needs a separate entity for the VideoPlayer component.
    // The video texture is then applied to the display entity's material.
    let vpEntity = this.videoPlayerEntities.get(entity as number)
    if (!vpEntity) {
      vpEntity = engine.addEntity()
      this.videoPlayerEntities.set(entity as number, vpEntity)
    }

    VideoPlayer.createOrReplace(vpEntity, {
      src: options.src || '',
      playing: options.playing ?? true,
      volume: options.volume ?? 1,
      loop: options.loop ?? false,
      playbackRate: options.playbackRate ?? 1,
    })

    // Apply video texture to the display entity
    const videoTexture = Material.Texture.Video({ videoPlayerEntity: vpEntity })
    Material.setPbrMaterial(entity as Entity, {
      texture: videoTexture,
      emissiveTexture: videoTexture,
      emissiveIntensity: 0.6,
      emissiveColor: Color3.White(),
      roughness: 1.0,
      metallic: 0,
      specularIntensity: 0,
    })
  }

  updateVideoSource(entity: EntityHandle, src: string): void {
    const vpEntity = this.videoPlayerEntities.get(entity as number)
    if (vpEntity) {
      const vp = VideoPlayer.getMutableOrNull(vpEntity)
      if (vp) {
        vp.src = src
        vp.playing = true
      }
    }
  }

  setVideoVolume(entity: EntityHandle, volume: number): void {
    const vpEntity = this.videoPlayerEntities.get(entity as number)
    if (vpEntity) {
      const vp = VideoPlayer.getMutableOrNull(vpEntity)
      if (vp) {
        vp.volume = volume
      }
    }
  }

  getVideoState(entity: EntityHandle): VideoState {
    // DCL does not expose video state directly via a simple getter.
    // Return PLAYING as default if a video player exists on the mapped entity.
    const vpEntity = this.videoPlayerEntities.get(entity as number)
    if (vpEntity && VideoPlayer.has(vpEntity)) {
      return 3 // VideoState.PLAYING
    }
    return 0 // VideoState.NONE
  }

  onVideoEnded(entity: EntityHandle, cb: () => void): void {
    // A video already sitting at its end must not fire for the new callback; it re-arms once playback leaves the end.
    const vpEntity = this.videoPlayerEntities.get(entity as number)
    const ended = !!vpEntity && this.isVideoAtEnd(vpEntity) === true
    this.videoEndWatchers.set(entity as number, { cb, ended })
    if (this.videoEndSystemAdded) return
    this.videoEndSystemAdded = true
    engine.addSystem(() => {
      for (const [handle, watcher] of this.videoEndWatchers) {
        const vp = this.videoPlayerEntities.get(handle)
        if (!vp) continue
        const atEnd = this.isVideoAtEnd(vp)
        if (atEnd === null) continue
        if (!atEnd) {
          watcher.ended = false
        } else if (!watcher.ended) {
          watcher.ended = true
          try {
            watcher.cb()
          } catch (err) {
            console.error('[Virvi] video end callback failed', err)
          }
        }
      }
    })
  }

  /** True when the video is paused at its end, false while it is in any other state, null when its state is unknown. */
  private isVideoAtEnd(vpEntity: Entity): boolean | null {
    try {
      if (!VideoEvent.has(vpEntity)) return null
      const ev = videoEventsSystem.getVideoState(vpEntity)
      if (!ev) return null
      return (
        ev.state === DclVideoState.VS_PAUSED && ev.videoLength > 0 && ev.currentOffset >= ev.videoLength - 0.5
      )
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------

  setAudioSource(entity: EntityHandle, options: AudioOptions): void {
    AudioSource.createOrReplace(entity as Entity, {
      audioClipUrl: options.src,
      playing: options.playing ?? false,
      loop: options.loop ?? false,
      volume: options.volume ?? 1,
    })
  }

  playAudio(entity: EntityHandle): void {
    const audio = AudioSource.getMutableOrNull(entity as Entity)
    if (audio) audio.playing = true
  }

  stopAudio(entity: EntityHandle): void {
    const audio = AudioSource.getMutableOrNull(entity as Entity)
    if (audio) audio.playing = false
  }

  // ---------------------------------------------------------------------------
  // Physics
  // ---------------------------------------------------------------------------

  setCollider(entity: EntityHandle, options: ColliderOptions): void {
    const layers = options.isTrigger
      ? [ColliderLayer.CL_POINTER]
      : [ColliderLayer.CL_PHYSICS]

    switch (options.type) {
      case 'box':
        MeshCollider.setBox(entity as Entity, layers)
        break
      case 'sphere':
        MeshCollider.setSphere(entity as Entity, layers)
        break
      case 'mesh':
        MeshCollider.setPlane(entity as Entity, layers)
        break
    }
  }

  removeCollider(entity: EntityHandle): void {
    try {
      MeshCollider.deleteFrom(entity as Entity)
    } catch {
      // Entity may not have a collider
    }
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  onPointerDown(
    entity: EntityHandle,
    options: PointerOptions,
    cb: PointerCallback,
  ): void {
    pointerEventsSystem.onPointerDown(
      {
        entity: entity as Entity,
        opts: {
          button: InputAction.IA_POINTER,
          hoverText: options.hoverText || '',
          showFeedback: options.showFeedback ?? true,
        },
      },
      () => {
        cb({
          entityHandle: entity,
          button: 'primary',
          origin: { x: 0, y: 0, z: 0 },
          direction: { x: 0, y: 0, z: 1 },
        })
      },
    )
  }

  removePointerEvents(entity: EntityHandle): void {
    this.hoverEntities.delete(entity as number)
    try {
      if (PointerEvents.has(entity as Entity)) {
        pointerEventsSystem.removeOnPointerDown(entity as Entity)
        pointerEventsSystem.removeOnPointerHoverEnter(entity as Entity)
        pointerEventsSystem.removeOnPointerHoverLeave(entity as Entity)
      }
    } catch {
      // Entity may not have pointer events
    }
  }

  onPointerHover(entity: EntityHandle, onEnter: () => void, onLeave: () => void, maxDistance: number): void {
    this.hoverEntities.add(entity as number)
    const opts = { button: InputAction.IA_POINTER, maxDistance, showFeedback: false }
    pointerEventsSystem.onPointerHoverEnter({ entity: entity as Entity, opts }, () => {
      if (this.hoverEntities.has(entity as number)) onEnter()
    })
    pointerEventsSystem.onPointerHoverLeave({ entity: entity as Entity, opts }, () => {
      if (this.hoverEntities.has(entity as number)) onLeave()
    })
  }

  getCameraPose(): { position: Vec3; rotation: Quat } | null {
    const t = Transform.getOrNull(engine.CameraEntity)
    if (!t) return null
    return {
      position: { x: t.position.x, y: t.position.y, z: t.position.z },
      rotation: { x: t.rotation.x, y: t.rotation.y, z: t.rotation.z, w: t.rotation.w },
    }
  }

  setText(entity: EntityHandle, text: string, opts: { fontSize: number }): void {
    TextShape.createOrReplace(entity as Entity, {
      text,
      fontSize: opts.fontSize,
      textColor: Color4.White(),
      outlineWidth: 0.1,
      outlineColor: Color4.Black(),
    })
  }

  // ---------------------------------------------------------------------------
  // Player Actions
  // ---------------------------------------------------------------------------

  async openUrl(url: string): Promise<void> {
    try {
      const { openExternalUrl } = await import(
        '~system/RestrictedActions' as any
      )
      openExternalUrl({ url })
    } catch {
      // Not available outside DCL runtime
    }
  }

  async teleportPlayer(destination: string): Promise<void> {
    try {
      const { requestTeleport } = await import(
        '~system/UserActionModule' as any
      )
      requestTeleport({ destination })
    } catch {
      // Not available outside DCL runtime
    }
  }

  async movePlayer(
    position: Vec3,
    cameraTarget?: Vec3,
  ): Promise<void> {
    try {
      const { movePlayerTo } = await import(
        '~system/RestrictedActions' as any
      )
      const opts: any = {
        newRelativePosition: Vector3.create(
          position.x,
          position.y,
          position.z,
        ),
      }
      if (cameraTarget) {
        opts.cameraTarget = Vector3.create(
          cameraTarget.x,
          cameraTarget.y,
          cameraTarget.z,
        )
      }
      movePlayerTo(opts)
    } catch {
      // Not available outside DCL runtime
    }
  }

  async triggerEmote(emoteId: string): Promise<void> {
    try {
      const { triggerEmote } = await import(
        '~system/RestrictedActions' as any
      )
      triggerEmote({ predefinedEmote: emoteId })
    } catch {
      // Not available outside DCL runtime
    }
  }

  // ---------------------------------------------------------------------------
  // Frame Loop
  // ---------------------------------------------------------------------------

  registerSystem(update: (dt: number) => void): void {
    engine.addSystem(update)
  }

  unregisterSystem(update: (dt: number) => void): void {
    engine.removeSystem(update)
  }
}
