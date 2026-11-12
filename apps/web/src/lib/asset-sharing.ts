// Sharing 3D models with other Virvi users (LIV-20): who can do what with a model, and the words for it.
import { shareLicense } from '@virvixr/shared'

type Viewed = { mine?: boolean; packId?: string | null; isPublic?: boolean | null; license?: string | null }

/** The owner edits, shares and deletes their model; a catalog model is Virvi's. */
export const canManage = (a: Viewed) => !!a.mine && !a.packId

/** Someone else's shared model can be reported. */
export const canReport = (a: Viewed) => !a.mine && !!a.isPublic && !a.packId

/** What a shared model lets you do, from its license; null when it isn't shared under one. */
export function sharedNote(a: Viewed): string | null {
  if (!a.isPublic) return null
  return shareLicense(a.license)?.summary ?? null
}

export const REPORT_REASONS: readonly (readonly [string, string])[] = [
  ['copyright', 'It’s my work, or someone else’s, shared without permission'],
  ['offensive', 'It’s offensive or hateful'],
  ['private_info', 'It shows someone’s home or private information'],
  ['broken', 'It’s broken or doesn’t load'],
  ['spam', 'It’s spam'],
  ['other', 'Something else'],
]

const MESSAGES: Record<string, string> = {
  rights_not_confirmed: 'Confirm you made this model or have the right to share it.',
  unknown_license: 'Pick one of the licenses.',
  room_assets_private: 'Models made from a room scan stay private: they show the layout of a home.',
  not_ready: 'This model is still uploading. Try again once it’s finished.',
  forbidden: 'Only the person who added this model can do that.',
}

/** A refusal from the sharing routes as a sentence to show. */
export function shareErrorMessage(err: unknown): string {
  const e = err as { message?: string; body?: { error?: string; message?: string } } | null
  const code = e?.body?.error
  if (code && MESSAGES[code]) return MESSAGES[code]
  return e?.body?.message || e?.message || 'That didn’t work. Try again.'
}
