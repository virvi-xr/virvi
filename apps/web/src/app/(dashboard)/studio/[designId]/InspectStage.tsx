'use client'
import { useEffect, useRef, useState } from 'react'
import { EYE_LEVEL_ROW, ORBIT_COLS, orbitDrag, orbitFrame } from '@/lib/studio'

const ROWS = 7

/**
 * Inspect: the piece alone, turned any way. Drag sideways to turn it round, up and down to look from above or below;
 * the arrow keys move one step. Until the whole sphere has rendered, tipping stops at the eye-level ring.
 */
export default function InspectStage({ urls, label, note, onRetry }: { urls: string[]; label: string; note: 'loading' | 'retry' | null; onRetry: () => void }) {
  const [pos, setPos] = useState({ row: EYE_LEVEL_ROW, col: 0 })
  const drag = useRef<{ x: number; y: number; start: { row: number; col: number }; width: number; height: number } | null>(null)

  // Load every angle in the background, so a drag never waits on a frame
  useEffect(() => {
    for (const src of urls) new Image().src = src
  }, [urls.join('\n')]) // eslint-disable-line react-hooks/exhaustive-deps

  const frame = orbitFrame(pos.row, pos.col, urls.length)
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, start: pos, width: e.currentTarget.clientWidth, height: e.currentTarget.clientHeight }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d) setPos(orbitDrag(d.start, e.clientX - d.x, e.clientY - d.y, d.width, d.height))
  }
  const onPointerUp = () => { drag.current = null }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, [number, number]> = { ArrowLeft: [0, 1], ArrowRight: [0, -1], ArrowUp: [1, 0], ArrowDown: [-1, 0] }
    const s = step[e.key]
    if (!s) return
    e.preventDefault()
    setPos((p) => ({ row: Math.max(0, Math.min(ROWS - 1, p.row + s[0])), col: (p.col + s[1] + ORBIT_COLS) % ORBIT_COLS }))
  }

  return (
    <div role="img" aria-label={`${label}. Drag or use the arrow keys to turn it and look from above or below.`} tabIndex={0}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className="relative h-full w-full cursor-grab touch-none select-none active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
      {urls[frame] && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={urls[frame]} alt="" draggable={false} className="pointer-events-none h-full w-full object-contain" />
      )}
      {note === 'loading' && (
        <span className="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-gray-300" aria-live="polite">Loading more angles…</span>
      )}
      {note === 'retry' && (
        <span className="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-gray-300">
          More angles didn’t render.{' '}
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onRetry} className="text-blue-300 underline">Try again</button>
        </span>
      )}
    </div>
  )
}
