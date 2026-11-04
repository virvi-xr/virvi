'use client'
import { useEffect } from 'react'
import { brandTitle } from '@/lib/branding'
import { useInstance } from '@/lib/instance'

/** On a branded self-hosted install, puts its name in the browser tab title and its favicon on the tab. */
export function BrandingHead() {
  const info = useInstance()
  const name = info?.name ?? null
  const favicon = info?.faviconUrl ?? null

  useEffect(() => {
    if (!name) return
    const apply = () => {
      const next = brandTitle(document.title, name)
      if (next !== document.title) document.title = next
    }
    apply()
    // Pages set their own titles as they load and navigate; rebrand each one
    const observer = new MutationObserver(apply)
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [name])

  useEffect(() => {
    if (!favicon) return
    const icons = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')]
    const before = icons.map((l) => l.href)
    icons.forEach((l) => { l.href = favicon })
    const own = document.createElement('link')
    own.rel = 'icon'
    own.type = 'image/png'
    own.href = favicon
    document.head.appendChild(own)
    return () => {
      own.remove()
      icons.forEach((l, i) => { l.href = before[i] })
    }
  }, [favicon])

  return null
}
