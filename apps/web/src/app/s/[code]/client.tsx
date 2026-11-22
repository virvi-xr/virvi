'use client'

import { useEffect, useState } from 'react'
import type { ArMarkerLookup } from '@virvixr/shared'
import { API_URL } from '@/lib/config'
import { shareUrl, spaceCodeFromPath } from '@/lib/ar'

type State = { status: 'loading' } | { status: 'closed' } | { status: 'open'; code: string; space: ArMarkerLookup }

export default function SpaceClient() {
  const [state, setState] = useState<State>({ status: 'loading' })

  // The static export has one page for every code, so the code comes from the address bar.
  useEffect(() => {
    const code = spaceCodeFromPath(window.location.pathname)
    if (!code) {
      setState({ status: 'closed' })
      return
    }
    let cancelled = false
    fetch(`${API_URL}/api/ar/markers/by-code/${code}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('not open')
        return (await res.json()) as ArMarkerLookup
      })
      .then((space) => { if (!cancelled) setState({ status: 'open', code, space }) })
      .catch(() => { if (!cancelled) setState({ status: 'closed' }) })
    return () => { cancelled = true }
  }, [])

  if (state.status === 'loading') {
    return (
      <div style={styles.container}>
        <div style={styles.card}><p style={styles.hint}>Looking up this space...</p></div>
      </div>
    )
  }

  if (state.status === 'closed') {
    return (
      <div style={styles.container}>
        <div style={styles.card}><h1 style={styles.title}>This space isn&apos;t open yet.</h1></div>
      </div>
    )
  }

  const { space, code } = state
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>{space.spaceName}</h1>
        {space.whereText && (
          <>
            <h2 style={styles.label}>Where to find the ring</h2>
            <p style={styles.body}>{space.whereText}</p>
          </>
        )}
        <p style={styles.body}>Look at the ring when you get there</p>
        <a href={shareUrl(code)} style={styles.button}>Open in the Virvi app on Quest</a>
        <p style={styles.hint}>No app yet? <a href="/ar/" style={styles.link}>Get the Virvi apps</a> for Quest, Vision Pro and iPhone.</p>
      </div>
    </div>
  )
}

// Inline styles for a minimal, mobile-friendly page with no Tailwind dependency
const styles: Record<string, React.CSSProperties> = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: '#0a0a0f' },
  card: { width: '100%', maxWidth: '400px', background: '#1a1a2e', borderRadius: '12px', padding: '2rem', textAlign: 'center' },
  title: { fontSize: '1.5rem', fontWeight: 700, marginBottom: '1rem', color: '#fff' },
  label: { fontSize: '0.85rem', fontWeight: 600, color: '#888', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' },
  body: { fontSize: '1rem', color: '#e0e0e0', marginBottom: '1.25rem' },
  button: { display: 'inline-block', padding: '0.75rem 1.5rem', background: '#6366f1', color: '#fff', borderRadius: '8px', fontSize: '1rem', fontWeight: 600, textDecoration: 'none' },
  hint: { fontSize: '0.8rem', color: '#666', marginTop: '0.75rem' },
  link: { color: '#a5b4fc', textDecoration: 'underline' },
}
