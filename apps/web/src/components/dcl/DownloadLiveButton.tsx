'use client'
// "Download what went live": a World deployment's exact files as a zip, on the Import page and the World's card.
import { useState } from 'react'
import { useApi } from '@/lib/api'
import { importFailure } from '@/lib/import'

export function DownloadLiveButton({ deploymentId, className }: { deploymentId: string; className: string }) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The route needs the bearer header, so the zip comes as a blob and is saved under the server's filename (Ruling R23).
  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const { blob, filename } = await api.downloadDeployFiles(deploymentId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      setError(importFailure(err).message)
    }
    setBusy(false)
  }

  return (
    <>
      <button type="button" onClick={download} disabled={busy} className={className}>
        {busy ? 'Preparing the zip…' : 'Download what went live'}
      </button>
      {error && <p className="w-full rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300" role="alert">{error}</p>}
    </>
  )
}
