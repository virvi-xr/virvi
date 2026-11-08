'use client'
// The wizard's note for a World that is connected to another Virvi scene: the disconnect when the caller may do it,
// otherwise who has to. Shown when the World is picked, and on a run that stopped on 409 world_in_use.
import { useState } from 'react'
import Link from 'next/link'
import { useApi, type ConnectedScene } from '@/lib/api'
import { errorCode, wizardErrorMessage } from '@/lib/wizard/run'
import { worldInUseView } from '@/lib/world-disconnect'
import { ConfirmAction } from '@/components/ui'

export function WorldInUseNotice({ world, connected, ownSceneId, onDisconnected }: {
  world: string
  connected: ConnectedScene | null | undefined
  /** The scene this run already made: never reported as holding its own World. */
  ownSceneId?: string | null
  onDisconnected: () => void
}) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = worldInUseView(world, connected, ownSceneId)
  if (!view) return null

  if (view.kind === 'blocked') {
    return <p className="rounded-md border border-yellow-700/60 bg-yellow-950/30 px-3 py-2.5 text-sm text-yellow-100" role="alert">{view.text}</p>
  }

  const disconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.disconnectDclDestination(view.destinationId)
    } catch (err) {
      // Already gone (disconnected from the other scene's page meanwhile): nothing left to do
      if (errorCode(err) !== 'not_found') {
        setError(wizardErrorMessage(err))
        setBusy(false)
        return
      }
    }
    setBusy(false)
    onDisconnected()
  }

  return (
    <div className="space-y-2 rounded-md border border-yellow-700/60 bg-yellow-950/30 px-3 py-2.5 text-sm text-yellow-100" role="alert">
      <p>{view.text}</p>
      <div className="flex flex-wrap items-center gap-3">
        <ConfirmAction disabled={busy} danger={false} confirmLabel="Disconnect" prompt={view.confirm} onConfirm={disconnect}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {busy ? 'Disconnecting…' : view.action}
        </ConfirmAction>
        <Link href={view.sceneHref} target="_blank" className="text-blue-300 hover:text-blue-200">Open “{view.sceneName}”</Link>
      </div>
      {error && <p className="text-red-300">{error}</p>}
    </div>
  )
}
