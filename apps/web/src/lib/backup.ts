// "Download backup (no Virvi)": what a failed backup download says.
import { errorCode, wizardErrorMessage } from './wizard/run'

/** The backup route for a scene; `destinationId` (a deploy card's) places a scene Virvi built at that destination. */
export function backupPath(sceneId: string, destinationId?: string): string {
  const path = `/api/scenes/${encodeURIComponent(sceneId)}/backup.zip`
  return destinationId ? `${path}?destination=${encodeURIComponent(destinationId)}` : path
}

const CODE_MESSAGES: Record<string, string> = {
  backup_too_big: 'This backup would be over the 500 MB limit. Remove or shrink some of the scene\'s large files in Virvi and try again.',
  not_decentraland: 'This scene has no Decentraland World or parcels to back up.',
  destination_not_found: 'That World or those parcels are no longer connected to this scene. Reload the page and try again.',
  backup_busy: 'Virvi is putting together other backups right now. Try again in a minute.',
  backup_timeout: 'This backup took too long to put together. Try again in a few minutes.',
}

/** A failed backup download as a sentence: the server's own message (it names the largest files when too big), else the code's, else a network or generic one. */
export function backupErrorMessage(err: unknown): string {
  const body = (err as { body?: { message?: unknown } } | null)?.body
  if (typeof body?.message === 'string' && body.message) return body.message
  const code = errorCode(err)
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  if (err instanceof TypeError) return "Virvi couldn't be reached. Check your connection and try again."
  return wizardErrorMessage(err)
}
