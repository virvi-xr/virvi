import { config } from '../config.js'
import { privateStoreFromUri, r2PrivateStore, localPrivateStore, memoryPrivateStore, type PrivateStore } from '../storage/private-store.js'

/**
 * The private studio bucket. Every design file (workspace, GLBs, checker reports, render frames) lives here, never in
 * the public uploads bucket; the browser only ever gets render frames, through signed URLs (render-urls.ts).
 * The implementation is the shared private store (storage/private-store.ts).
 */
export type StudioStore = PrivateStore

export const workspaceKey = (designId: string) => `designs/${designId}/workspace.tar.gz`
export const jobFileKey = (designId: string, jobId: string, path: string) => `designs/${designId}/jobs/${jobId}/${path}`
/** A file the owner uploaded (studio/uploads.ts). */
export const uploadKey = (designId: string, uploadId: string) => `designs/${designId}/uploads/${uploadId}`

// The worker's file paths, from apps/studio-worker/CONTRACT.md
const FILE_PATH = /^(pieces\/([a-z_]+)\/[A-Za-z0-9._-]+\.(glb|json)|checks\/([a-z_]+)\.txt|renders\/([a-z_]+)\/[a-z0-9-]+\/[0-9]{3}\.webp|final\/([a-z_]+)\/package\.zip)$/
const MAX_PATH = 200

export function checkFilePath(
  path: string,
): { ok: true; kind: 'piece' | 'check' | 'render' | 'final'; category: string } | { ok: false; reason: string } {
  if (path.length > MAX_PATH) return { ok: false, reason: `path is longer than ${MAX_PATH} characters` }
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return { ok: false, reason: 'path has a relative segment' }
  const m = FILE_PATH.exec(path)
  if (!m) return { ok: false, reason: 'path is not a piece, check, render or package file' }
  if (m[2]) return { ok: true, kind: 'piece', category: m[2] }
  if (m[4]) return { ok: true, kind: 'check', category: m[4] }
  if (m[5]) return { ok: true, kind: 'render', category: m[5] }
  return { ok: true, kind: 'final', category: m[6] }
}

export function r2StudioStore(uri = config.studioS3Uri): StudioStore {
  if (!uri) throw new Error('STUDIO_S3_URI is not set')
  return r2PrivateStore(uri)
}

export const localStudioStore = localPrivateStore
export const memoryStudioStore = memoryPrivateStore

let store: StudioStore | null = null

/** The configured store: file:// is local, anything else R2. Tests replace it with setStudioStore. */
export function getStudioStore(): StudioStore {
  if (!store) {
    const uri = config.studioS3Uri
    if (!uri) throw new Error('STUDIO_S3_URI is not set')
    store = privateStoreFromUri(uri)
  }
  return store
}

export function setStudioStore(s: StudioStore | null): void {
  store = s
}
