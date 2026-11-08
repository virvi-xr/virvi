'use client'
// Settings → Delete this scene (LIV-83): opens the delete dialog, then goes to the Scenes list, whose toast offers Restore.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DeleteSceneDialog } from '@/components/scenes/DeleteSceneDialog'

export function DeleteSceneSection({ sceneId }: { sceneId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  return (
    <section className="mt-8 rounded-lg border border-red-500/30 bg-gray-900 p-5" aria-labelledby="delete-scene-heading">
      <h2 id="delete-scene-heading" className="text-base font-semibold">Delete this scene</h2>
      <p className="mt-1 text-sm text-gray-400">
        You can restore it for 30 days from Recently deleted on the Scenes page. You choose which hosted worlds and deployments to shut down or remove.
        Only the scene&apos;s host, or an admin of its organization, can delete it.
      </p>
      <button type="button" onClick={() => setOpen(true)} className="mt-3 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500">Delete scene…</button>
      {open && <DeleteSceneDialog sceneId={sceneId} onClose={() => setOpen(false)} onDeleted={() => router.push(`/scenes?deleted=${sceneId}`)} />}
    </section>
  )
}
