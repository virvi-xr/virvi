'use client'
import { useEffect, useRef, useState } from 'react'
import { frameAt } from '@/lib/studio'

const LOOP_FPS = 12 // an on-avatar emote spin; an emote view plays at the rate it was rendered

/** Loads every frame before resolving, so a new view never replaces the old one half-drawn. */
function preload(urls: string[]): Promise<void> {
  return Promise.all(urls.map((src) => new Promise<void>((resolve) => {
    const img = new Image()
    img.onload = img.onerror = () => resolve()
    img.src = src
  }))).then(() => undefined)
}

/**
 * A rendered view on the stage: drag to turn it (one stage width is one full turn); `loop` also plays it at `fps`
 * (12 unless given), for an animation. The frames shown stay until the next view's frames have all loaded.
 */
export default function SpinStage({ view, urls, loop, label, fps = LOOP_FPS }: { view: string; urls: string[]; loop: boolean; label: string; fps?: number }) {
  const [shown, setShown] = useState<string[]>([])
  const [frame, setFrame] = useState(0)
  const [loading, setLoading] = useState(true)
  const drag = useRef<{ x: number; start: number; width: number } | null>(null)
  const shownView = useRef<string | null>(null)
  const key = urls.join('\n')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    preload(urls).then(() => {
      if (cancelled) return
      // Fresh URLs for the same view (a refresh) keep the frame; a new view starts at the front
      if (shownView.current !== view) setFrame(0)
      shownView.current = view
      setShown(urls)
      setLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (!loop || shown.length < 2) return
    const t = setInterval(() => {
      if (!drag.current) setFrame((f) => (f + 1) % shown.length)
    }, 1000 / fps)
    return () => clearInterval(t)
  }, [loop, shown.length, fps])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (shown.length < 2) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, start: frame, width: e.currentTarget.clientWidth }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d) setFrame(frameAt(d.start, e.clientX - d.x, d.width, shown.length))
  }
  const onPointerUp = () => { drag.current = null }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (shown.length < 2) return
    if (e.key === 'ArrowLeft') setFrame((f) => (f + 1) % shown.length)
    if (e.key === 'ArrowRight') setFrame((f) => (f - 1 + shown.length) % shown.length)
  }

  return (
    <div
      role="img" aria-label={`${label}. Drag or use the arrow keys to turn it.`} tabIndex={0}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className="relative h-full w-full cursor-grab touch-none select-none active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      {shown[frame] && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={shown[frame]} alt="" draggable={false} className="pointer-events-none h-full w-full object-contain" />
      )}
      {loading && (
        <span className="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-gray-300">Loading…</span>
      )}
    </div>
  )
}
