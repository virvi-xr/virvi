import { createHmac } from 'node:crypto'
import { config } from '../config.js'

/**
 * A verified viewer's key in ad_events (LIV-167): `h:` and a keyed hash of the scene and the wallet, never the wallet
 * itself. Per scene, so one person's rows can't be joined across scenes; the same in a scene, so once-per-viewer
 * counting still holds. The key is derived from JWT_SECRET with a fixed label (never JWT_SECRET itself); rotating it
 * only resets the day's once-per-viewer counts.
 */
const key = () => createHmac('sha256', config.jwtSecret).update('virvi-ad-viewer').digest()

export const adViewerKey = (sceneId: string, wallet: string) =>
  `h:${createHmac('sha256', key()).update(`${sceneId}:${wallet.toLowerCase()}`).digest('hex')}`

/** Every key a wallet's ad rows can carry in these scenes: the hashed ones, and the raw `w:` key rows written before LIV-167. */
export const adViewerKeysFor = (sceneIds: string[], wallets: string[]): string[] => [
  ...sceneIds.flatMap((s) => wallets.map((w) => adViewerKey(s, w))),
  ...wallets.map((w) => `w:${w.toLowerCase()}`),
]
