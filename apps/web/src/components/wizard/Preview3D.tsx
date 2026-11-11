'use client'
// The wizard's live preview of the plot. Client-only: load it with
// `dynamic(() => import('@/components/wizard/Preview3D'), { ssr: false })`.
//
// Plot coordinates are metres from the south-west corner, x east and z north (see placement.ts).
// In three.js, x stays east, y is up and north is -Z, so the plot spans x 0..width and Z 0..-depth,
// and the default camera sits south of the plot looking north, the way players arrive.
// The mapping (z mirrored, Decentraland's clockwise rotationY as a negative three.js turn, and MODEL_TURN for
// Decentraland's x-mirrored glTFs) is lib/scene-transform.ts, shared with the analytics heatmap.
// A room set's GLB is written that way too: plot point (x, z) at glTF (-x, z), so it draws at the plot origin.
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { DCL_PARCEL_M, plotSizeM, type Plot } from '@virvixr/shared'
import { footprint, type PlacedItem } from '@/lib/wizard/placement'
import { GUIDE_PLOT } from '@/lib/wizard/state'
import { MODEL_TURN, toThreeTransform } from '@/lib/scene-transform'
import { hasWebGL } from '@/lib/webgl'

export interface Preview3DProps {
  /** Null when there is no Decentraland plot: the 2×2 guide plot is drawn instead. */
  plot: Plot | null
  items: PlacedItem[]
  /** The room set's preview GLB (a blob URL), drawn at the plot's origin; not selectable or draggable. */
  room?: string | null
  spawn: { x: number; z: number }
  selectedKey: string | null
  editable: boolean
  /** Whether the arrival point can be dragged while editable (default true). */
  spawnEditable?: boolean
  onMove: (key: string, x: number, z: number) => void
  onRotate: (key: string) => void
  onSelect: (key: string | null) => void
  onMoveSpawn: (x: number, z: number) => void
}

const COLORS = {
  background: '#0b0d10', // gray-950
  surround: '#13161b', // gray-900
  plot: '#1d2128', // gray-800
  metreLine: '#262b33',
  parcelLine: '#474d57', // gray-600
  edge: '#22d3ee', // accent
  guideEdge: '#646b76', // gray-500
  spawn: '#4ade80',
  loading: '#8a919c',
  failed: '#f59e0b',
}

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
/** A plot item's three.js placement: on the ground at (x, z), turned rotationY about Y. */
const placement = (item: { x: number; z: number; rotationY: number }) =>
  toThreeTransform({ position: { x: item.x, y: 0, z: item.z }, rotation: { x: 0, y: item.rotationY, z: 0 }, scale: { x: 1, y: 1, z: 1 } })

export default function Preview3D(props: Preview3DProps) {
  const [webgl] = useState(() => typeof document !== 'undefined' && hasWebGL())
  const { selectedKey, editable, onRotate } = props
  const plan = <PlanView {...props} />
  return (
    <div className="relative h-full min-h-[320px] w-full overflow-hidden rounded-lg border border-gray-800 bg-gray-950">
      {webgl ? (
        <Fallback fallback={plan}>
          <Scene {...props} />
        </Fallback>
      ) : (
        plan
      )}
      {editable && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-3">
          <p className="rounded bg-gray-950/80 px-2 py-1 text-xs text-gray-400">
            Drag items to move them. <span className="text-green-400">●</span> is where people arrive.
          </p>
          <button
            type="button"
            disabled={!selectedKey}
            onClick={() => selectedKey && onRotate(selectedKey)}
            className="pointer-events-auto rounded border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 hover:border-blue-400 hover:text-blue-300 disabled:opacity-40 disabled:hover:border-gray-700 disabled:hover:text-gray-200"
          >
            Turn 90°
          </button>
        </div>
      )}
    </div>
  )
}

/** Renders `fallback` instead of children once they throw (a failed GLB, or a WebGL context that won't start). */
class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function Scene({ plot, items, room, spawn, selectedKey, editable, spawnEditable = true, onMove, onSelect, onMoveSpawn }: Preview3DProps) {
  const p = plot ?? GUIDE_PLOT
  const size = plotSizeM(p)
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      camera={{ fov: 45, near: 0.1, far: 2000 }}
      onPointerMissed={() => editable && onSelect(null)}
    >
      <color attach="background" args={[COLORS.background]} />
      <hemisphereLight args={['#ffffff', '#30353d', 1.2]} />
      <directionalLight position={[size.x * 0.3, 40, size.z * 0.2]} intensity={1.6} />
      <Ground size={size} guide={!plot} />
      {room && (
        <Fallback key={room} fallback={null}>
          <Suspense fallback={null}>
            <RoomModel url={room} />
          </Suspense>
        </Fallback>
      )}
      {items.map((item) => (
        <Item
          key={item.key}
          item={item}
          selected={item.key === selectedKey}
          editable={editable}
          onSelect={onSelect}
          onMove={onMove}
        />
      ))}
      <SpawnMarker spawn={spawn} editable={editable && spawnEditable} onMove={onMoveSpawn} />
      <OrbitControls makeDefault maxPolarAngle={Math.PI / 2 - 0.05} minDistance={2} maxDistance={Math.max(size.x, size.z) * 4 + 40} />
      <Frame size={size} />
    </Canvas>
  )
}

/** Points the camera at the plot from the south whenever the plot's size changes. */
function Frame({ size }: { size: { x: number; z: number } }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const cx = size.x / 2
    const cz = -size.z / 2
    const d = Math.max(size.x, size.z)
    camera.position.set(cx, d * 0.8 + 6, cz + d * 1.1 + 8)
    camera.lookAt(cx, 0, cz)
    if (controls) {
      controls.target.set(cx, 0, cz)
      controls.update()
    }
    invalidate()
  }, [size.x, size.z, camera, controls, invalidate])
  return null
}

/** Lines along x and z, every `step` metres across the plot, as one segments geometry. */
function gridGeometry(size: { x: number; z: number }, step: number) {
  const pts: number[] = []
  for (let x = step; x < size.x; x += step) pts.push(x, 0, 0, x, 0, -size.z)
  for (let z = step; z < size.z; z += step) pts.push(0, 0, -z, size.x, 0, -z)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return g
}

function Ground({ size, guide }: { size: { x: number; z: number }; guide: boolean }) {
  const metres = useMemo(() => gridGeometry(size, 1), [size.x, size.z])
  const parcels = useMemo(() => gridGeometry(size, DCL_PARCEL_M), [size.x, size.z])
  const edge = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, size.x, 0, 0, size.x, 0, -size.z, 0, 0, -size.z], 3))
    return g
  }, [size.x, size.z])
  useEffect(() => () => [metres, parcels, edge].forEach((g) => g.dispose()), [metres, parcels, edge])
  const pad = Math.max(size.x, size.z) * 2
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[size.x / 2, -0.02, -size.z / 2]}>
        <planeGeometry args={[size.x + pad * 2, size.z + pad * 2]} />
        <meshBasicMaterial color={COLORS.surround} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[size.x / 2, -0.01, -size.z / 2]}>
        <planeGeometry args={[size.x, size.z]} />
        <meshStandardMaterial color={COLORS.plot} roughness={1} />
      </mesh>
      <lineSegments geometry={metres} position-y={0.005}>
        <lineBasicMaterial color={COLORS.metreLine} />
      </lineSegments>
      <lineSegments geometry={parcels} position-y={0.01}>
        <lineBasicMaterial color={COLORS.parcelLine} />
      </lineSegments>
      <lineLoop geometry={edge} position-y={0.015}>
        <lineBasicMaterial color={guide ? COLORS.guideEdge : COLORS.edge} />
      </lineLoop>
    </group>
  )
}

/**
 * Pointer handlers that drag something across the ground. Orbit is switched off synchronously on
 * pointer-down (fiber's listener runs before OrbitControls'), so the camera stays put while dragging.
 */
function useGroundDrag(enabled: boolean, at: { x: number; z: number }, onMove: (x: number, z: number) => void, onDown?: () => void) {
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null
  const gl = useThree((s) => s.gl)
  const drag = useRef<{ dx: number; dz: number } | null>(null)
  const hit = new THREE.Vector3()
  const ground = (e: ThreeEvent<PointerEvent>) => e.ray.intersectPlane(GROUND, hit)
  const end = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current) return
    drag.current = null
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    if (controls) controls.enabled = true
  }
  if (!enabled) return {}
  return {
    onPointerDown: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation()
      onDown?.()
      const p = ground(e)
      if (!p) return
      drag.current = { dx: at.x - p.x, dz: at.z + p.z }
      ;(e.target as Element).setPointerCapture(e.pointerId)
      if (controls) controls.enabled = false
    },
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      if (!drag.current) return
      e.stopPropagation()
      const p = ground(e)
      if (p) onMove(p.x + drag.current.dx, -p.z + drag.current.dz)
    },
    onPointerUp: end,
    onPointerCancel: end,
    onPointerOver: () => void (gl.domElement.style.cursor = 'grab'),
    onPointerOut: () => void (gl.domElement.style.cursor = ''),
  }
}

function Item({ item, selected, editable, onSelect, onMove }: {
  item: PlacedItem
  selected: boolean
  editable: boolean
  onSelect: (key: string) => void
  onMove: (key: string, x: number, z: number) => void
}) {
  const handlers = useGroundDrag(editable, item, (x, z) => onMove(item.key, x, z), () => onSelect(item.key))
  const url = item.asset.cdnUrl
  const t = placement(item)
  return (
    <group position={t.position}>
      <group rotation-y={t.rotation[1]} {...handlers}>
        {url ? (
          <Fallback key={url} fallback={<StandIn item={item} color={COLORS.failed} />}>
            <Suspense fallback={<StandIn item={item} color={COLORS.loading} />}>
              <Model url={url} />
            </Suspense>
          </Fallback>
        ) : (
          <StandIn item={item} color={COLORS.failed} />
        )}
      </group>
      {selected && <Outline item={item} />}
    </group>
  )
}

/** A GLB as Decentraland shows it; `_collider` meshes stay hidden. */
function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url)
  const object = useMemo(() => {
    const o = scene.clone(true)
    o.traverse((c) => { if (c.name.includes('_collider')) c.visible = false })
    return o
  }, [scene])
  return <primitive object={object} rotation-y={MODEL_TURN} />
}

/**
 * The room set: an ordinary model at the plot origin, drawn like every item. Each preview is a new blob URL, so
 * the old one is dropped from the loader's cache.
 */
function RoomModel({ url }: { url: string }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    invalidate()
    return () => useGLTF.clear(url)
  }, [url, invalidate])
  return <Model url={url} />
}

/** A translucent box the size of the item's footprint × height, shown while its GLB loads or when it can't. */
function StandIn({ item, color }: { item: PlacedItem; color: string }) {
  const f = footprint(item.asset)
  const h = item.asset.dimensions?.y || 1
  return (
    <mesh position-y={h / 2}>
      <boxGeometry args={[f.x, h, f.z]} />
      <meshStandardMaterial color={color} transparent opacity={0.35} depthWrite={false} />
    </mesh>
  )
}

/** The selected item's footprint outlined on the ground. */
function Outline({ item }: { item: PlacedItem }) {
  const f = footprint(item.asset, item.rotationY)
  const geometry = useMemo(() => {
    const hx = f.x / 2
    const hz = f.z / 2
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-hx, 0, -hz, hx, 0, -hz, hx, 0, hz, -hx, 0, hz], 3))
    return g
  }, [f.x, f.z])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <lineLoop geometry={geometry} position-y={0.03}>
      <lineBasicMaterial color={COLORS.edge} />
    </lineLoop>
  )
}

function SpawnMarker({ spawn, editable, onMove }: { spawn: { x: number; z: number }; editable: boolean; onMove: (x: number, z: number) => void }) {
  const handlers = useGroundDrag(editable, spawn, onMove)
  return (
    <group position={[spawn.x, 0, -spawn.z]} {...handlers}>
      <mesh rotation-x={-Math.PI / 2} position-y={0.04}>
        <ringGeometry args={[0.45, 0.7, 32]} />
        <meshBasicMaterial color={COLORS.spawn} side={THREE.DoubleSide} />
      </mesh>
      <mesh position-y={0.9}>
        <cylinderGeometry args={[0.12, 0.12, 1.8, 12]} />
        <meshStandardMaterial color={COLORS.spawn} emissive={COLORS.spawn} emissiveIntensity={0.3} />
      </mesh>
      <mesh position-y={2.05} rotation-x={Math.PI}>
        <coneGeometry args={[0.35, 0.5, 16]} />
        <meshStandardMaterial color={COLORS.spawn} emissive={COLORS.spawn} emissiveIntensity={0.3} />
      </mesh>
    </group>
  )
}

/** Without WebGL: the plot from above, north up, with each item's footprint. Drag and select still work. */
function PlanView({ plot, items, spawn, selectedKey, editable, spawnEditable = true, onMove, onSelect, onMoveSpawn }: Preview3DProps) {
  const p = plot ?? GUIDE_PLOT
  const size = plotSizeM(p)
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ move: (x: number, z: number) => void; dx: number; dz: number } | null>(null)
  // SVG y runs down, so plot z (north) is size.z - y.
  const toPlot = (e: React.PointerEvent) => {
    const m = svg.current?.getScreenCTM()
    if (!m) return null
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
    return { x: pt.x, z: size.z - pt.y }
  }
  const start = (e: React.PointerEvent, at: { x: number; z: number }, move: (x: number, z: number) => void) => {
    if (!editable) return
    e.stopPropagation()
    const q = toPlot(e)
    if (!q) return
    drag.current = { move, dx: at.x - q.x, dz: at.z - q.z }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const lines: ReactNode[] = []
  for (let x = DCL_PARCEL_M; x < size.x; x += DCL_PARCEL_M) lines.push(<line key={`x${x}`} x1={x} y1={0} x2={x} y2={size.z} />)
  for (let z = DCL_PARCEL_M; z < size.z; z += DCL_PARCEL_M) lines.push(<line key={`z${z}`} x1={0} y1={z} x2={size.x} y2={z} />)
  return (
    <svg
      ref={svg}
      viewBox={`-2 -2 ${size.x + 4} ${size.z + 4}`}
      className="h-full w-full touch-none select-none"
      role="img"
      aria-label="Top-down plan of the plot"
      onPointerDown={() => editable && onSelect(null)}
      onPointerMove={(e) => {
        if (!drag.current) return
        const q = toPlot(e)
        if (q) drag.current.move(q.x + drag.current.dx, q.z + drag.current.dz)
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <rect x={0} y={0} width={size.x} height={size.z} fill={COLORS.plot} stroke={plot ? COLORS.edge : COLORS.guideEdge} strokeWidth={0.15} />
      <g stroke={COLORS.parcelLine} strokeWidth={0.08}>{lines}</g>
      {items.map((item) => {
        const f = footprint(item.asset, item.rotationY)
        const selected = item.key === selectedKey
        return (
          <rect
            key={item.key}
            x={item.x - f.x / 2}
            y={size.z - item.z - f.z / 2}
            width={f.x}
            height={f.z}
            fill={selected ? 'rgba(34,211,238,0.3)' : 'rgba(138,145,156,0.35)'}
            stroke={selected ? COLORS.edge : COLORS.loading}
            strokeWidth={0.1}
            className={editable ? 'cursor-grab' : undefined}
            onPointerDown={(e) => {
              if (!editable) return
              onSelect(item.key)
              start(e, item, (x, z) => onMove(item.key, x, z))
            }}
          >
            <title>{item.asset.name}</title>
          </rect>
        )
      })}
      <circle
        cx={spawn.x}
        cy={size.z - spawn.z}
        r={0.7}
        fill={COLORS.spawn}
        className={editable && spawnEditable ? 'cursor-grab' : undefined}
        onPointerDown={(e) => spawnEditable && start(e, spawn, onMoveSpawn)}
      >
        <title>Spawn point</title>
      </circle>
    </svg>
  )
}
