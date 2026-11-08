'use client'

import { useState, useEffect, useRef } from 'react'
import { useParams } from 'next/navigation'
import { fileToBase64, mediaContentType } from '@/lib/api'
import { acceptFor, codeFromPath, uploadErrorMessage } from '@/lib/companion'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3010'

interface TokenInfo {
  valid: boolean
  remainingUploads: number
  expiresAt: string
  sceneId: string | null
  kinds: string[] | null
}

/** One picked file and where it is in its upload. */
interface FileRow {
  key: string
  name: string
  sizeBytes: number
  state: 'starting' | 'uploading' | 'processing' | 'done' | 'failed'
  percent: number
  error?: string
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}))
  return uploadErrorMessage(res.status, body)
}

/** POST the bytes with XHR so the page can show upload progress. */
function sendBytes(url: string, body: string, onProgress: (percent: number) => void): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)) }
    xhr.onload = () => {
      let parsed: any = {}
      try { parsed = JSON.parse(xhr.responseText) } catch { /* not json */ }
      resolve({ status: xhr.status, body: parsed })
    }
    xhr.onerror = () => reject(new Error('Network error — check your connection and try again'))
    xhr.send(body)
  })
}

export default function CompanionUploadClient() {
  const params = useParams()
  const [code, setCode] = useState<string | null>(null)
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [rows, setRows] = useState<FileRow[]>([])
  const [remaining, setRemaining] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Validate token on mount (the code comes from the address bar in the static build)
  useEffect(() => {
    const c = codeFromPath(window.location.pathname, params.code as string | undefined)
    if (!c) {
      setError('This upload link is missing its code')
      return
    }
    setCode(c)
    fetch(`${API_URL}/api/upload/${c}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res))
        return res.json()
      })
      .then((data) => {
        setTokenInfo(data)
        setRemaining(data.remainingUploads)
      })
      .catch((err) => setError(err.message))
  }, [params.code])

  const update = (key: string, patch: Partial<FileRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  async function uploadOne(file: File, key: string) {
    const start = await fetch(`${API_URL}/api/upload/${code}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, contentType: mediaContentType(file), sizeBytes: file.size }),
    })
    if (!start.ok) {
      update(key, { state: 'failed', error: await readError(start) })
      return
    }
    const { assetId, remainingUploads } = await start.json()
    setRemaining(remainingUploads)
    update(key, { state: 'uploading' })

    const data = await fileToBase64(file)
    const res = await sendBytes(`${API_URL}/api/upload/${code}/${assetId}`, JSON.stringify({ fileData: data }), (percent) =>
      update(key, percent >= 100 ? { percent, state: 'processing' } : { percent }),
    )
    if (res.status === 201) update(key, { state: 'done', percent: 100 })
    else update(key, { state: 'failed', error: uploadErrorMessage(res.status, res.body) })
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0 || !code) return
    const picked = Array.from(files).map((file, i) => ({ file, key: `${Date.now()}-${i}-${file.name}` }))
    setRows((prev) => [
      ...picked.map(({ file, key }): FileRow => ({ key, name: file.name, sizeBytes: file.size, state: 'starting', percent: 0 })),
      ...prev,
    ])
    setUploading(true)
    // One at a time; a failure on one file doesn't stop the others
    for (const { file, key } of picked) {
      try {
        await uploadOne(file, key)
      } catch (err: any) {
        update(key, { state: 'failed', error: err?.message || 'Upload failed' })
      }
    }
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function rowStatus(r: FileRow): string {
    if (r.state === 'starting') return 'Starting…'
    if (r.state === 'uploading') return `Uploading ${r.percent}%`
    if (r.state === 'processing') return 'Processing…'
    if (r.state === 'done') return 'Done'
    return r.error ?? 'Upload failed'
  }

  // Error state
  if (error && !tokenInfo) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.title}>Upload Link</h1>
          <p style={styles.error}>{error}</p>
          <p style={styles.hint}>Make a new upload link from the 3D Models panel in your HUD.</p>
        </div>
      </div>
    )
  }

  // Loading
  if (!tokenInfo) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <p style={styles.hint}>Checking upload link...</p>
        </div>
      </div>
    )
  }

  const modelsOnly = tokenInfo.kinds?.length === 1 && tokenInfo.kinds[0] === 'model'
  const kindsHint = !tokenInfo.kinds
    ? 'GLB models, images, or video'
    : modelsOnly ? 'GLB models' : tokenInfo.kinds.includes('model') ? 'Images or GLB models' : 'Images'

  // Main upload UI
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Virvi Upload</h1>
        <p style={styles.subtitle}>
          {remaining > 0
            ? `${remaining} upload${remaining !== 1 ? 's' : ''} remaining`
            : 'Upload limit reached'}
        </p>

        {remaining > 0 && (
          <>
            <label style={styles.uploadButton}>
              {uploading ? 'Uploading...' : 'Choose Files'}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={acceptFor(tokenInfo.kinds)}
                onChange={handleFileSelect}
                disabled={uploading || remaining <= 0}
                style={{ display: 'none' }}
              />
            </label>
            <p style={styles.hint}>{kindsHint}</p>
          </>
        )}

        {rows.length > 0 && (
          <div style={styles.uploadList}>
            <h2 style={styles.listTitle}>Uploads</h2>
            {rows.map((r) => (
              <div key={r.key} style={styles.uploadItem}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={styles.assetName}>{r.name}</span>
                  <div style={{ ...styles.assetSize, color: r.state === 'failed' ? '#ef4444' : r.state === 'done' ? '#22c55e' : '#888' }}>
                    {rowStatus(r)} · {formatSize(r.sizeBytes)}
                  </div>
                  {(r.state === 'uploading' || r.state === 'processing') && (
                    <div style={styles.progressTrack}>
                      <div style={{ ...styles.progressFill, width: `${r.percent}%` }} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <p style={styles.footer}>
          Uploads appear in the 3D Models panel in your HUD.
        </p>
      </div>
    </div>
  )
}

// Inline styles for a minimal, mobile-friendly page with no Tailwind dependency
const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem',
    background: '#0a0a0f',
  },
  card: {
    width: '100%',
    maxWidth: '400px',
    background: '#1a1a2e',
    borderRadius: '12px',
    padding: '2rem',
    textAlign: 'center',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: 700,
    marginBottom: '0.25rem',
    color: '#fff',
  },
  subtitle: {
    fontSize: '0.9rem',
    color: '#888',
    marginBottom: '1.5rem',
  },
  uploadButton: {
    display: 'inline-block',
    padding: '0.75rem 2rem',
    background: '#6366f1',
    color: '#fff',
    borderRadius: '8px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
  },
  hint: {
    fontSize: '0.8rem',
    color: '#666',
    marginTop: '0.75rem',
  },
  error: {
    color: '#ef4444',
    fontSize: '0.9rem',
    marginTop: '0.5rem',
  },
  uploadList: {
    marginTop: '1.5rem',
    textAlign: 'left',
  },
  listTitle: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: '#888',
    marginBottom: '0.5rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  uploadItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.5rem 0',
    borderBottom: '1px solid #2a2a3e',
  },
  assetName: {
    fontSize: '0.9rem',
    color: '#e0e0e0',
    wordBreak: 'break-all',
  },
  progressTrack: {
    height: '4px',
    background: '#2a2a3e',
    borderRadius: '2px',
    marginTop: '0.35rem',
    overflow: 'hidden',
  },
  progressFill: {
    height: '4px',
    background: '#6366f1',
  },
  assetSize: {
    fontSize: '0.8rem',
    color: '#666',
  },
  footer: {
    fontSize: '0.75rem',
    color: '#555',
    marginTop: '1.5rem',
  },
}
