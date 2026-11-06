'use client'
import { useEffect, useRef } from 'react'

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

type Api = { render: (el: HTMLElement, o: Record<string, unknown>) => string; remove: (id: string) => void }
let loading: Promise<Api> | null = null

function load(): Promise<Api> {
  loading ??= new Promise<Api>((resolve, reject) => {
    const w = window as unknown as { turnstile?: Api }
    if (w.turnstile) return resolve(w.turnstile)
    const s = document.createElement('script')
    s.src = SRC
    s.async = true
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('turnstile')))
    s.onerror = () => { loading = null; reject(new Error('turnstile')) }
    document.head.appendChild(s)
  })
  return loading
}

/** Bot check that only shows if a challenge is needed. Calls onToken with a token, or '' when no site key is configured (the server skips the check then). */
export function Turnstile({ onToken }: { onToken: (token: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const cb = useRef(onToken)
  cb.current = onToken
  useEffect(() => {
    if (!SITE_KEY) { cb.current(''); return }
    let id: string | null = null
    let gone = false
    load().then((api) => {
      if (gone || !box.current) return
      id = api.render(box.current, {
        sitekey: SITE_KEY,
        appearance: 'interaction-only',
        callback: (t: string) => cb.current(t),
        // Never leave a waiting caller hanging: an empty token lets the server decide
        'error-callback': () => { cb.current(''); return true },
        'timeout-callback': () => cb.current(''),
      })
    }).catch(() => { if (!gone) cb.current('') })
    return () => {
      gone = true
      if (id) (window as unknown as { turnstile?: Api }).turnstile?.remove(id)
    }
  }, [])
  return <div ref={box} />
}
