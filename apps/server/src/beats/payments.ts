import { BeatError } from './errors.js'

/**
 * Payment-side BEAT operations. Stubs until Task 6 fills the bodies in place (the imports stay put).
 */

/** Refunds a paid BEAT's payment(s) before it starts. */
export async function refundBeat(_beatId: string, _now: Date): Promise<void> {
  throw new BeatError(501, 'not_implemented', 'Refunds are not available yet.')
}

/** Copies the BEAT's image to a frozen public file and records its URL on the BEAT. */
export async function copyBeatImage(_beatId: string): Promise<void> {
  throw new BeatError(501, 'not_implemented', 'Image copies are not available yet.')
}
