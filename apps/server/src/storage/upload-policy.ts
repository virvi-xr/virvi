const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MB = 1024 * 1024
export const IMAGE_MAX_BYTES = 10 * MB
export const MODEL_MAX_BYTES = 50 * MB
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm'])
/** 70 MiB as base64 JSON (~93 MiB) fits the default 100 MiB request body limit. */
export const VIDEO_MAX_BYTES = 70 * MB

export function classifyUpload(filename: string, contentType: string, size: number):
  | { ok: true; contentType: string }
  | { ok: false; status: 413 | 415; error: 'too_large' | 'unsupported_type' } {
  const type = (contentType || '').toLowerCase()
  const isGlb = /\.glb$/i.test(filename) && (type === 'model/gltf-binary' || type === 'application/octet-stream' || type === '')
  if (IMAGE_TYPES.has(type)) return size > IMAGE_MAX_BYTES ? { ok: false, status: 413, error: 'too_large' } : { ok: true, contentType: type }
  if (VIDEO_TYPES.has(type)) return size > VIDEO_MAX_BYTES ? { ok: false, status: 413, error: 'too_large' } : { ok: true, contentType: type }
  if (isGlb) return size > MODEL_MAX_BYTES ? { ok: false, status: 413, error: 'too_large' } : { ok: true, contentType: 'model/gltf-binary' }
  return { ok: false, status: 415, error: 'unsupported_type' }
}

/** A 3D model file (GLB or glTF), by name or declared type. */
export function isModelFile(filename: string, contentType: string): boolean {
  return /\.(glb|gltf)$/i.test(filename) || /^model\/gltf/i.test(contentType || '')
}

/** Storage extension derived from a classified (allowlisted) content type. */
export function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'model/gltf-binary': return 'glb'
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    case 'video/mp4': return 'mp4'
    case 'video/webm': return 'webm'
    default: return 'bin'
  }
}
