'use client'
// The linked scene's models seen straight down (LIV-85), under the 2D heatmap. Client-only: ParcelMap loads it with
// next/dynamic. An orthographic camera over the map's bounds (orthoTopDown) lines the render up with the SVG layers
// exactly; each model sits at its world matrix from lib/scene-transform, with Decentraland's MODEL_TURN.
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { MODEL_TURN, orthoTopDown } from '@/lib/scene-transform'
import type { MapBounds } from '@/lib/analytics/parcel-map'
import type { PlacedModel } from '@/lib/analytics/layout'

class Boundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onError()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

function TopDownCamera({ bounds }: { bounds: MapBounds }) {
  const set = useThree((s) => s.set)
  const invalidate = useThree((s) => s.invalidate)
  const camera = useMemo(() => {
    const o = orthoTopDown(bounds)
    const c = new THREE.OrthographicCamera(o.left, o.right, o.top, o.bottom, o.near, o.far)
    c.position.set(...o.position)
    c.up.set(...o.up)
    c.lookAt(...o.target)
    c.updateProjectionMatrix()
    // Keep this frustum on resize (fiber otherwise refits an orthographic camera to the canvas in pixels).
    ;(c as unknown as { manual: boolean }).manual = true
    return c
  }, [bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ])
  useLayoutEffect(() => {
    set({ camera })
    invalidate()
  }, [camera, set, invalidate])
  return null
}

function Model({ model, onDrawn }: { model: PlacedModel; onDrawn: (id: string, ok: boolean) => void }) {
  const { scene } = useGLTF(model.src!)
  const object = useMemo(() => {
    const o = scene.clone(true)
    o.traverse((c) => { if (c.name.includes('_collider')) c.visible = false })
    return o
  }, [scene])
  const matrix = useMemo(() => new THREE.Matrix4().fromArray(model.matrix), [model.matrix])
  useEffect(() => {
    onDrawn(model.id, true)
    return () => onDrawn(model.id, false)
  }, [model.id, onDrawn])
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <primitive object={object} rotation-y={MODEL_TURN} />
    </group>
  )
}

export default function BirdsEyeModels({ bounds, models, onDrawn, onHover }: {
  bounds: MapBounds
  models: PlacedModel[]
  onDrawn: (id: string, ok: boolean) => void
  /** A model's name and where the pointer is, in % of the map; null when it leaves. */
  onHover: (name: string | null, left: number, top: number) => void
}) {
  // A WebGL context that won't start: no render, every model keeps its footprint.
  return (
    <Boundary onError={() => models.forEach((m) => onDrawn(m.id, false))}>
    <div className="absolute inset-0">
      <Canvas frameloop="demand" dpr={[1, 2]} gl={{ alpha: true }} style={{ position: 'absolute', inset: 0 }}>
        <TopDownCamera bounds={bounds} />
        <hemisphereLight args={['#ffffff', '#30353d', 1.4]} />
        <directionalLight position={[10, 40, 5]} intensity={1.4} />
        {models.map((m) => (
          <Boundary key={`${m.id}:${m.src}`} onError={() => onDrawn(m.id, false)}>
            <Suspense fallback={null}>
              <group
                onPointerOver={(e) => {
                  e.stopPropagation()
                  const r = (e.nativeEvent.target as HTMLElement).getBoundingClientRect()
                  onHover(m.name, ((e.nativeEvent.clientX - r.left) / r.width) * 100, ((e.nativeEvent.clientY - r.top) / r.height) * 100)
                }}
                onPointerOut={() => onHover(null, 0, 0)}
              >
                <Model model={m} onDrawn={onDrawn} />
              </group>
            </Suspense>
          </Boundary>
        ))}
      </Canvas>
    </div>
    </Boundary>
  )
}
