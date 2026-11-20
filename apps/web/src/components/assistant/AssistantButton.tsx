'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistantAccess } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { SparkleIcon } from '@/components/icons'

/** The assistant's status for the signed-in account (`hidden` until it loads, and when it is off for them). */
export function useAssistantAccess(enabled: boolean): { access: AssistantAccess; refresh: () => void } {
  const api = useApi()
  const [access, setAccess] = useState<AssistantAccess>({ state: 'hidden' })
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const refresh = useCallback(() => {
    if (!enabled) { setAccess({ state: 'hidden' }); return }
    api.getAssistantStatus().then((a) => { if (live.current) setAccess(a) }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])
  useEffect(() => {
    if (!enabled) { setAccess({ state: 'hidden' }); return }
    refresh()
  }, [enabled, refresh])
  return { access, refresh }
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Cmd/Ctrl-K toggles the panel, unless focus is in a text field outside the panel (the panel's own composer is fine). */
export function useAssistantShortcut(enabled: boolean, toggle: () => void) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const t = e.target instanceof HTMLElement ? e.target : null
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      if (typing && !t!.closest('[data-assistant-panel]')) return
      e.preventDefault()
      toggle()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled, toggle])
}

/** The "Assistant" button in the header; the layout leaves it out for trials, scene passes and a hidden assistant. */
export function AssistantButton({ access, open, onToggle }: { access: AssistantAccess; open: boolean; onToggle: () => void }) {
  if (access.state === 'hidden') return null
  return (
    <button type="button" onClick={onToggle} aria-haspopup="dialog" aria-expanded={open} title={`Assistant (${isMac() ? '⌘K' : 'Ctrl K'})`}
      className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-gray-400 transition-colors hover:bg-white/[0.05] hover:text-white">
      <SparkleIcon size={18} />
      <span>Assistant</span>
    </button>
  )
}
