'use client'
// "Download backup (no Virvi)": the scene as a Decentraland project that runs without Virvi, on the Import page and the deploy cards.
import { useState } from 'react'
import { useApi } from '@/lib/api'
import { backupErrorMessage } from '@/lib/backup'

/** `destinationId`: a deploy card's destination, where a scene Virvi built is placed in the backup's scene.json. */
export function DownloadBackupButton({ sceneId, destinationId, className }: { sceneId: string; destinationId?: string; className: string }) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The route needs the bearer header, so the zip comes as a blob and is saved under the server's filename.
  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const { blob, filename } = await api.downloadSceneBackup(sceneId, destinationId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      setError(backupErrorMessage(err))
    }
    setBusy(false)
  }

  return (
    <>
      <button type="button" onClick={download} disabled={busy} className={className}>
        {busy ? 'Putting your backup together…' : 'Download backup (no Virvi)'}
      </button>
      {error && <p className="w-full rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300" role="alert">{error}</p>}
    </>
  )
}
