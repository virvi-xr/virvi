'use client'
import { useEffect, useRef } from 'react'

/**
 * Keyboard behaviour for a modal dialog (LIV-42). Put the returned ref on the element with role="dialog":
 * - focus moves into the dialog when it opens (an [autofocus] or [data-autofocus] element first, else the first control,
 *   else the dialog itself), unless focus is already inside it;
 * - Tab and Shift+Tab stay inside the dialog;
 * - Escape calls onClose, unless `canClose` is false (a payment in progress, a gate that must be answered);
 * - when it closes, focus returns to whatever had it before it opened.
 * With dialogs stacked (a report form over a dialog), only the top one answers the keyboard.
 */
const stack: object[] = []

export function useDialog<T extends HTMLElement = HTMLDivElement>(open: boolean, onClose?: () => void, canClose = true) {
  const ref = useRef<T>(null)
  // Read through refs so a new onClose or canClose each render doesn't re-run the open effect (and steal focus again)
  const close = useRef(onClose)
  const closable = useRef(canClose)
  close.current = onClose
  closable.current = canClose

  useEffect(() => {
    if (!open) return
    const me = {}
    stack.push(me)
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const el = ref.current
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ?? focusables(el)[0]
      if (first) first.focus()
      else { if (!el.hasAttribute('tabindex')) el.tabIndex = -1; el.focus() }
    }
    const onKey = (e: KeyboardEvent) => {
      const box = ref.current
      if (!box || stack[stack.length - 1] !== me) return
      if (e.key === 'Escape') {
        if (closable.current && close.current) { e.stopPropagation(); close.current() }
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables(box)
      if (list.length === 0) { e.preventDefault(); return }
      const next = trapTab(list, document.activeElement, e.shiftKey)
      if (next) { e.preventDefault(); next.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      stack.splice(stack.indexOf(me), 1)
      if (before && before.isConnected) before.focus()
    }
  }, [open])

  return ref
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'

function focusables(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => !n.closest('[inert],[hidden]') && n.getClientRects().length > 0)
}

/**
 * Where Tab should go to stay inside the dialog, or null to let the browser move focus normally. Wraps from the last
 * control to the first (and back with Shift), and pulls focus back in when it is outside the list.
 */
export function trapTab<E>(list: E[], current: unknown, shift: boolean): E | null {
  if (list.length === 0) return null
  const i = list.indexOf(current as E)
  if (i === -1) return shift ? list[list.length - 1] : list[0]
  if (shift && i === 0) return list[list.length - 1]
  if (!shift && i === list.length - 1) return list[0]
  return null
}
