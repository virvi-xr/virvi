import {
  engine,
  Entity,
  Transform,
  CameraMode,
  CameraType,
  inputSystem,
  InputAction,
  PointerEventType,
  Name,
  GltfContainer,
  VideoPlayer,
  VideoEvent,
  videoEventsSystem,
  VideoState,
  AvatarEmoteCommand,
  TextShape,
  Billboard,
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { Collector, createTransport, resolveApiUrl } from '@virvixr/core'
import { PARCEL_RE, type AnalyticsProbe, type AnalyticsSceneRef, type Vec3 } from '@virvixr/shared'
import { DclAdapter } from './DclAdapter'
import { resolveTargetLabel } from './target-label'

const SDK_VERSION = '2.0.0'

function targetName(entity: number): string {
  return resolveTargetLabel(entity, {
    nameOf: (e) => Name.getOrNull(e as Entity)?.value,
    parentOf: (e) => {
      const parent = Transform.getOrNull(e as Entity)?.parent
      return parent ? (parent as number) : undefined
    },
    modelSrcOf: (e) => GltfContainer.getOrNull(e as Entity)?.src,
  })
}

function headingFromQuaternion(q: { x: number; y: number; z: number; w: number }): number {
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
  return (yaw * 180) / Math.PI
}

export class DclAnalyticsProbe implements AnalyticsProbe {
  private base: [number, number]
  private parcels: Set<string>
  private lastClickTs = -1
  private lastHoverTs = -1
  private videoStates = new Map<Entity, VideoState>()
  private lastVideoScan = 0
  private lastEmoteTs = -1

  constructor(scene: { baseParcel?: string; parcels?: string[] }) {
    const [bx, by] = (scene.baseParcel && PARCEL_RE.test(scene.baseParcel) ? scene.baseParcel : '0,0').split(',').map(Number)
    this.base = [bx, by]
    this.parcels = new Set(scene.parcels && scene.parcels.length ? scene.parcels : [`${bx},${by}`])
  }

  getPlayerPose(): { position: Vec3; headingDeg: number } | null {
    const t = Transform.getOrNull(engine.PlayerEntity)
    if (!t) return null
    return { position: { x: t.position.x, y: t.position.y, z: t.position.z }, headingDeg: headingFromQuaternion(t.rotation) }
  }

  getCameraMode(): 'first' | 'third' | null {
    const c = CameraMode.getOrNull(engine.CameraEntity)
    if (!c) return null
    return c.mode === CameraType.CT_FIRST_PERSON ? 'first' : 'third'
  }

  isInsideScene(p: Vec3): boolean {
    const px = this.base[0] + Math.floor(p.x / 16)
    const py = this.base[1] + Math.floor(p.z / 16)
    return this.parcels.has(`${px},${py}`)
  }

  pollInteractions(): Array<{ kind: 'click' | 'hover'; target: string }> {
    const out: Array<{ kind: 'click' | 'hover'; target: string }> = []
    const click = inputSystem.getInputCommand(InputAction.IA_POINTER, PointerEventType.PET_DOWN)
    if (click && click.timestamp !== this.lastClickTs) {
      this.lastClickTs = click.timestamp
      // Clicks on empty space / the sky hit no entity: nothing to attribute, so skip them
      const entity = click.hit?.entityId
      if (entity !== undefined) out.push({ kind: 'click', target: targetName(entity) })
    }
    const hover = inputSystem.getInputCommand(InputAction.IA_POINTER, PointerEventType.PET_HOVER_ENTER)
    if (hover && hover.timestamp !== this.lastHoverTs) {
      this.lastHoverTs = hover.timestamp
      const entity = hover.hit?.entityId
      if (entity !== undefined) out.push({ kind: 'hover', target: targetName(entity) })
    }
    return out
  }

  pollVideoEvents(): Array<{ target: string; state: 'play' | 'pause' | 'end' | 'error' }> {
    const now = Date.now()
    if (now - this.lastVideoScan < 250) return []
    this.lastVideoScan = now
    const out: Array<{ target: string; state: 'play' | 'pause' | 'end' | 'error' }> = []
    const seen = new Set<Entity>()
    for (const [entity] of engine.getEntitiesWith(VideoPlayer)) {
      seen.add(entity)
      let ev: ReturnType<typeof videoEventsSystem.getVideoState>
      try {
        if (!VideoEvent.has(entity)) continue
        ev = videoEventsSystem.getVideoState(entity)
      } catch {
        continue
      }
      if (!ev) continue
      const prev = this.videoStates.get(entity)
      if (prev === ev.state) continue
      this.videoStates.set(entity, ev.state)
      const target = targetName(entity)
      if (ev.state === VideoState.VS_PLAYING) out.push({ target, state: 'play' })
      else if (ev.state === VideoState.VS_ERROR) out.push({ target, state: 'error' })
      else if (ev.state === VideoState.VS_PAUSED) {
        const ended = ev.videoLength > 0 && ev.currentOffset >= ev.videoLength - 0.5
        out.push({ target, state: ended ? 'end' : 'pause' })
      }
    }
    for (const entity of this.videoStates.keys()) if (!seen.has(entity)) this.videoStates.delete(entity)
    return out
  }

  pollEmotes(): string[] {
    if (!AvatarEmoteCommand.has(engine.PlayerEntity)) return []
    const out: string[] = []
    let max = this.lastEmoteTs
    for (const cmd of AvatarEmoteCommand.get(engine.PlayerEntity).values()) {
      if (cmd.timestamp > this.lastEmoteTs) {
        out.push(cmd.emoteUrn)
        if (cmd.timestamp > max) max = cmd.timestamp
      }
    }
    this.lastEmoteTs = max
    return out
  }

  showNotice(text: string): void {
    const e = engine.addEntity()
    Transform.create(e, { parent: engine.CameraEntity, position: Vector3.create(0, -0.6, 2) })
    TextShape.create(e, { text, fontSize: 1.2, textColor: Color4.White(), outlineWidth: 0.1, outlineColor: Color4.Black() })
    Billboard.create(e)
    let left = 8
    const sys = (dt: number) => {
      left -= dt
      if (left <= 0) {
        engine.removeEntity(e)
        engine.removeSystem(sys)
      }
    }
    engine.addSystem(sys)
  }
}

export async function getAnalyticsSceneRef(): Promise<AnalyticsSceneRef> {
  const { getSceneInformation, getRealm } = await import('~system/Runtime' as any)
  const [info, realm] = await Promise.all([getSceneInformation({}), getRealm({})])
  const metadata = JSON.parse(info.metadataJson || '{}')
  const realmName: string = realm?.realmInfo?.realmName || ''
  const isWorld = /\.eth$/i.test(realmName)
  const entityId = typeof info.urn === 'string' ? info.urn.split('?')[0].split(':').pop() || undefined : undefined
  return {
    realm: realmName || 'unknown',
    isWorld,
    isPreview: !!realm?.realmInfo?.isPreview,
    worldName: isWorld ? realmName : undefined,
    baseParcel: metadata.scene?.base,
    parcels: metadata.scene?.parcels,
    entityId,
    title: metadata.display?.title,
  }
}

// One collector per scene runtime: repeated starts (and every createVirvi call) share it.
let shared: Promise<Collector | null> | null = null

/**
 * Analytics only: no realtime room, no HUD, no login flow. Starts the scene's collector once;
 * later calls return the same collector (their options are ignored).
 */
export function startVirviAnalytics(
  opts: { env?: 'dev' | 'staging' | 'prod'; apiUrl?: string; adapter?: DclAdapter } = {},
): Promise<Collector | null> {
  if (!shared) {
    shared = start(opts).catch((err) => {
      console.log('[Virvi analytics] disabled:', String(err))
      return null
    })
  }
  return shared
}

/** Stop the shared collector (sends session.leave and flushes). A later start creates a new one. */
export async function stopVirviAnalytics(): Promise<void> {
  const current = shared
  shared = null
  const collector = current ? await current : null
  await collector?.destroy()
}

async function start(opts: { env?: 'dev' | 'staging' | 'prod'; apiUrl?: string; adapter?: DclAdapter }): Promise<Collector | null> {
  try {
    const adapter = opts.adapter ?? new DclAdapter()
    const [user, env, scene] = await Promise.all([adapter.getPlatformUser(), adapter.getEnvironment(), getAnalyticsSceneRef()])
    const random = Math.random
    const visitorId = user.walletAddress || user.id || `guest-${Math.floor(random() * 1e12).toString(36)}`
    const collector = new Collector({
      apiUrl: resolveApiUrl(opts),
      probe: new DclAnalyticsProbe(scene),
      transport: createTransport(adapter),
      scene,
      visitor: { visitorId, isGuest: user.isGuest, displayName: user.displayName },
      context: {
        platform: 'decentraland',
        device: String((env.metadata as { subPlatform?: unknown } | undefined)?.subPlatform ?? ''),
        realm: scene.realm,
        sdkVersion: SDK_VERSION,
      },
      log: (m) => console.log(m),
    })
    adapter.registerSystem(() => collector.tick())
    return collector
  } catch (err) {
    console.log('[Virvi analytics] disabled:', String(err))
    return null
  }
}
