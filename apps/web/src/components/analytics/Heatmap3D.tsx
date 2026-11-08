'use client'
// The 3D heatmap (LIV-85, paid plans). Client-only: HeatmapPanel loads it with next/dynamic, so three.js stays out of
// the analytics page until someone opens 3D. Scene coordinates map to three.js through lib/scene-transform (x east,
// north at -Z), and the camera starts south of the map looking north, as Preview3D's does.
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { feetHeight, heightBand } from '@virvixr/shared/dist/heatmap-height.js'
import type { HeatCell, LiveData } from '@/lib/analytics/types'
import { mapBounds, parcelRects, type MapBounds } from '@/lib/analytics/parcel-map'
import { cellBox, cellValue, colourStep, floorOf, HEAT_COLOURS, LIVE_COLOUR, type HeatMetric } from '@/lib/analytics/heat'
import type { PlacedModel } from '@/lib/analytics/layout'
import { MODEL_TURN } from '@/lib/scene-transform'
import { formatDuration } from '@/lib/analytics/labels'
import { full } from './format'

export interface Heatmap3DProps {
  parcels: string[]
  baseParcel: string | null
  kind: string
  /** The cells to draw (HeatmapPanel has already dropped the empty and, on huge maps, the faintest ones). */
  cells: HeatCell[]
  max: number
  metric: HeatMetric
  /** 'all', or the one floor band shown. */
  floor: number | 'all'
  live?: LiveData['positions']
  models: PlacedModel[]
  /** The canvas couldn't start (lost or missing WebGL): the panel falls back to 2D. */
  onFailed: () => void
}

const COLORS = { background: '#0b0d10', tile: '#1d2128', tileLine: '#30353d', metreLine: '#171a1f', ghost: '#9aa1ab' }
/** The live dot sits at the body's middle, about 0.9 m above the feet. */
const BODY_M = 0.9

class Boundary extends Component<{ onError?: () => void; fallback?: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onError?.()
  }
  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children
  }
}

const fmt = (v: number, metric: HeatMetric) => (metric === 'dwell' ? formatDuration(v) : `${full(v)} visit${v === 1 ? '' : 's'}`)

export default function Heatmap3D(props: Heatmap3DProps) {
  const { parcels, baseParcel, cells, live, models, onFailed } = props
  const bounds = useMemo(
    () => mapBounds(parcels, baseParcel, [...cells, ...(live ?? []), ...models.flatMap((m) => m.footprint)]),
    [parcels, baseParcel, cells, live, models],
  )
  const [hover, setHover] = useState<{ cell: HeatCell; left: number; top: number } | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const onHover = (cell: HeatCell | null, e?: PointerEvent) => {
    const r = wrap.current?.getBoundingClientRect()
    if (!cell || !e || !r) return setHover(null)
    setHover({ cell, left: e.clientX - r.left, top: e.clientY - r.top })
  }
  const width = wrap.current?.clientWidth ?? 0
  return (
    <div ref={wrap} className="relative h-[420px] w-full overflow-hidden rounded-lg border border-gray-800" style={{ background: COLORS.background }} onPointerLeave={() => setHover(null)}>
      <Boundary onError={onFailed}>
        <Canvas frameloop="demand" dpr={[1, 2]} camera={{ fov: 45, near: 0.1, far: 4000 }}>
          <color attach="background" args={[COLORS.background]} />
          <hemisphereLight args={['#ffffff', '#30353d', 1.2]} />
          <directionalLight position={[20, 60, 10]} intensity={1.2} />
          <Ground bounds={bounds} parcels={parcels} baseParcel={baseParcel} />
          {models.map((m) => (
            <Boundary key={`${m.id}:${m.src}`} fallback={<GhostBox model={m} />}>
              <Suspense fallback={null}>{m.src ? <GhostModel model={m} /> : <GhostBox model={m} />}</Suspense>
            </Boundary>
          ))}
          <Cells {...props} onHover={onHover} />
          <LiveDots live={live ?? []} kind={props.kind} floor={props.floor} />
          <Controls bounds={bounds} />
        </Canvas>
      </Boundary>
      {hover && (
        <div
          role="status"
          className="pointer-events-none absolute z-10 rounded-md bg-gray-800 px-3 py-2 text-xs shadow-lg ring-1 ring-white/10 whitespace-nowrap"
          style={{ left: hover.left, top: hover.top, transform: hover.left > width / 2 ? 'translate(calc(-100% - 12px), -100%)' : 'translate(12px, -100%)' }}
        >
          <p className="text-sm font-semibold text-white">{fmt(cellValue(hover.cell, props.metric), props.metric)}</p>
          <p className="text-gray-400">{props.metric === 'dwell' ? `${full(hover.cell.visits)} visit${hover.cell.visits === 1 ? '' : 's'}` : `${formatDuration(hover.cell.dwellSec)} spent`}</p>
          <p className="text-gray-400">x {hover.cell.x} m, z {hover.cell.z} m</p>
          {hover.cell.cellY === null && <p className="text-gray-400">Height not recorded</p>}
          {hover.cell.partlyHeightless && <p className="text-gray-400">Includes days with no height recorded</p>}
        </div>
      )}
      <p className="pointer-events-none absolute bottom-2 left-3 rounded bg-gray-950/80 px-2 py-1 text-xs text-gray-400">
        Drag to orbit, scroll to zoom, right-drag to pan
      </p>
    </div>
  )
}

/** Orbit, zoom and pan, starting south of the map looking north. */
function Controls({ bounds }: { bounds: MapBounds }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null
  const invalidate = useThree((s) => s.invalidate)
  const w = bounds.maxX - bounds.minX
  const d = bounds.maxZ - bounds.minZ
  const cx = (bounds.minX + bounds.maxX) / 2
  const cz = -(bounds.minZ + bounds.maxZ) / 2
  const size = Math.max(w, d)
  useEffect(() => {
    camera.position.set(cx, size * 0.8 + 6, cz + size * 1.1 + 8)
    camera.lookAt(cx, 0, cz)
    if (controls) {
      controls.target.set(cx, 0, cz)
      controls.update()
    }
    invalidate()
  }, [cx, cz, size, camera, controls, invalidate])
  return <OrbitControls makeDefault maxPolarAngle={Math.PI / 2 - 0.05} minDistance={2} maxDistance={size * 4 + 40} />
}

function Ground({ bounds, parcels, baseParcel }: { bounds: MapBounds; parcels: string[]; baseParcel: string | null }) {
  const tiles = useMemo(() => {
    const rects = parcelRects(parcels, baseParcel).map((t) => ({ key: t.label, x: t.x, z: t.z, w: t.size, d: t.size }))
    return rects.length ? rects : [{ key: 'map', x: bounds.minX, z: bounds.minZ, w: bounds.maxX - bounds.minX, d: bounds.maxZ - bounds.minZ }]
  }, [parcels, baseParcel, bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ])
  const [metres, edges] = useMemo(() => {
    const grid: number[] = []
    for (let x = Math.ceil(bounds.minX); x <= bounds.maxX; x++) grid.push(x, 0, -bounds.minZ, x, 0, -bounds.maxZ)
    for (let z = Math.ceil(bounds.minZ); z <= bounds.maxZ; z++) grid.push(bounds.minX, 0, -z, bounds.maxX, 0, -z)
    const edge: number[] = []
    for (const t of tiles) {
      const [x0, x1, z0, z1] = [t.x, t.x + t.w, -t.z, -(t.z + t.d)]
      edge.push(x0, 0, z0, x1, 0, z0, x1, 0, z0, x1, 0, z1, x1, 0, z1, x0, 0, z1, x0, 0, z1, x0, 0, z0)
    }
    return [grid, edge].map((pts) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      return g
    })
  }, [tiles, bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ])
  useEffect(() => () => { metres.dispose(); edges.dispose() }, [metres, edges])
  return (
    <group>
      {tiles.map((t) => (
        <mesh key={t.key} rotation-x={-Math.PI / 2} position={[t.x + t.w / 2, -0.02, -(t.z + t.d / 2)]} raycast={() => null}>
          <planeGeometry args={[t.w, t.d]} />
          <meshStandardMaterial color={COLORS.tile} roughness={1} />
        </mesh>
      ))}
      <lineSegments geometry={metres} position-y={0.005} raycast={() => null}>
        <lineBasicMaterial color={COLORS.metreLine} />
      </lineSegments>
      <lineSegments geometry={edges} position-y={0.01} raycast={() => null}>
        <lineBasicMaterial color={COLORS.tileLine} />
      </lineSegments>
    </group>
  )
}

const ghostMaterial = () => new THREE.MeshStandardMaterial({ color: COLORS.ghost, transparent: true, opacity: 0.16, depthWrite: false })

/** A model as faint, see-through grey, so the heat shows inside the buildings. */
function GhostModel({ model }: { model: PlacedModel }) {
  const { scene } = useGLTF(model.src!)
  const object = useMemo(() => {
    const o = scene.clone(true)
    const material = ghostMaterial()
    o.traverse((c) => {
      if (c.name.includes('_collider')) c.visible = false
      if ((c as THREE.Mesh).isMesh) (c as THREE.Mesh).material = material
    })
    return o
  }, [scene])
  const matrix = useMemo(() => new THREE.Matrix4().fromArray(model.matrix), [model.matrix])
  return (
    <group matrix={matrix} matrixAutoUpdate={false} raycast={() => null}>
      <primitive object={object} rotation-y={MODEL_TURN} raycast={() => null} />
    </group>
  )
}

/** A model without a loadable GLB: its footprint as a faint 1 m slab (heights aren't known without the GLB). */
function GhostBox({ model }: { model: PlacedModel }) {
  const shape = useMemo(() => new THREE.Shape(model.footprint.map((p) => new THREE.Vector2(p.x, p.z))), [model.footprint])
  return (
    <mesh rotation-x={-Math.PI / 2} raycast={() => null}>
      <extrudeGeometry args={[shape, { depth: 1, bevelEnabled: false }]} />
      <meshStandardMaterial color={COLORS.ghost} transparent opacity={0.12} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}

/** Every cell as one instanced, translucent box spanning its floor band, coloured by the 6-step ramp. */
function Cells({ cells, max, metric, floor, onHover }: Heatmap3DProps & { onHover: (cell: HeatCell | null, e?: PointerEvent) => void }) {
  const shown = useMemo(() => (floor === 'all' ? cells : cells.filter((c) => floorOf(c) === floor)), [cells, floor])
  const mesh = useRef<THREE.InstancedMesh>(null)
  const invalidate = useThree((s) => s.invalidate)
  const palette = useMemo(() => HEAT_COLOURS.map((c) => new THREE.Color(c)), [])
  useEffect(() => {
    const m = mesh.current
    if (!m) return
    // The first setColorAt adds the instance colours, which the material's shader then has to be rebuilt for.
    const fresh = !m.instanceColor
    const o = new THREE.Object3D()
    shown.forEach((c, i) => {
      const b = cellBox(c)
      o.position.set(b.x, b.bottom + b.height / 2, -b.z)
      o.scale.set(0.94, b.height, 0.94)
      o.updateMatrix()
      m.setMatrixAt(i, o.matrix)
      m.setColorAt(i, palette[colourStep(cellValue(c, metric), max)])
    })
    m.count = shown.length
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    if (fresh) (m.material as THREE.Material).needsUpdate = true
    m.computeBoundingSphere()
    invalidate()
  }, [shown, metric, max, palette, invalidate])
  if (!shown.length) return null
  return (
    <instancedMesh
      // A new mesh when the count grows past what was allocated.
      key={Math.max(64, 2 ** Math.ceil(Math.log2(shown.length)))}
      ref={mesh}
      args={[undefined, undefined, Math.max(64, 2 ** Math.ceil(Math.log2(shown.length)))]}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation()
        const c = e.instanceId !== undefined ? shown[e.instanceId] : undefined
        onHover(c ?? null, e.nativeEvent)
      }}
      onPointerOut={() => onHover(null)}
    >
      <boxGeometry args={[1, 1, 1]} />
      {/* With every floor shown the boxes are see-through, so higher floors never hide the ones below. */}
      <meshBasicMaterial transparent opacity={floor === 'all' ? 0.45 : 0.8} depthWrite={false} />
    </instancedMesh>
  )
}

/** "Here now" visitors at their real position and height; dimmed when they're off the floor being shown. */
function LiveDots({ live, kind, floor }: { live: NonNullable<LiveData['positions']>; kind: string; floor: number | 'all' }) {
  return (
    <group>
      {live.map((d, i) => {
        const y = d.y ?? null
        const on = floor === 'all' || y === null || heightBand(y, kind) === floor
        const h = y === null ? 0 : Math.max(0, feetHeight(y, kind))
        return (
          <mesh key={i} position={[d.x, h + BODY_M, -d.z]} raycast={() => null}>
            <sphereGeometry args={[0.35, 16, 12]} />
            <meshBasicMaterial color={LIVE_COLOUR} transparent opacity={on ? 1 : 0.25} />
          </mesh>
        )
      })}
    </group>
  )
}
