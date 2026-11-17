import type { ContractResult } from './results.js'
import { getStudioStore, jobFileKey, soundFile } from './store.js'

const MB = 1024 * 1024
/** Decentraland's cap on an emote item: its model and sound together (check_emote.py's "GLB + audio"). */
export const EMOTE_ALLOWANCE_BYTES = 3 * MB

/**
 * A prompt result whose emote (its biggest GLB plus its sound, as stored) is over the allowance becomes an error that
 * keeps the other pieces: the emote never becomes a revision, the prompt isn't counted, and the note says why.
 * An uploaded sound may be far bigger than this (it's raw material); only what ships is held to it.
 */
export async function enforceEmoteAllowance(job: { id: string; designId: string }, result: ContractResult): Promise<ContractResult> {
  const emote = result.pieces.find((p) => p.category === 'emote' && p.files?.length)
  if (!emote) return result
  const stored = await getStudioStore().list(jobFileKey(job.designId, job.id, 'pieces/emote/'))
  const size = (path: string | null) => (path ? stored.find((o) => o.key === jobFileKey(job.designId, job.id, path))?.size ?? 0 : 0)
  const glb = Math.max(0, ...emote.files!.filter((f) => f.startsWith('pieces/emote/') && f.endsWith('.glb')).map(size))
  const total = glb + size(soundFile('emote', emote.files!))
  if (total <= EMOTE_ALLOWANCE_BYTES) return result
  return {
    ...result,
    outcome: 'error',
    error: `the emote and its sound came to ${(total / MB).toFixed(1)} MB, over Decentraland's 3 MB limit for an emote`,
    pieces: result.pieces.filter((p) => p !== emote),
  }
}
