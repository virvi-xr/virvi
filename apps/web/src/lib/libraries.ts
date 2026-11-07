/**
 * The two libraries (LIV-132), in the words every page uses. They stay separate:
 * - the Media Library (/media) holds images and video for your scenes, no 3D models;
 * - the 3D Asset Library (/assets) holds 3D models only: your own (private when uploaded) and shared ones.
 * Files in either are stored at unguessable public links, so the copy never says a file is hidden from the web.
 */
export const MEDIA_LIBRARY = {
  name: 'Media Library',
  purpose: 'Images and video for your scenes',
  subtitle: 'Images and video for your scenes. 3D models go in the 3D Asset Library.',
  uploadHelp: 'Only you see your uploads in this list. Visitors see a file in scenes you place it in, and anyone with the link can open it.',
} as const

export const ASSET_LIBRARY = {
  name: '3D Asset Library',
  purpose: '3D models, your own and shared ones',
  subtitle: '3D models, your own and shared ones. Images and video go in the Media Library.',
  uploadHelp: 'Your upload is private: only you see it here, under My Assets. Visitors see it in scenes you place it in, and anyone with the link can open the file.',
} as const

export const MEDIA_UPLOAD_RULES = 'Only PNG, JPG, WebP, GIF (≤ 10 MB) or MP4/WebM video (≤ 70 MB)'

export const MODEL_NOT_MEDIA = '3D models go in the 3D Asset Library: upload GLB files on the Assets page.'

/** A 3D model file (GLB or glTF), by name or type: the Media Library doesn't take these. */
export function isModelFile(file: { name: string; type?: string }): boolean {
  return /\.(glb|gltf)$/i.test(file.name) || /^model\/gltf/i.test(file.type ?? '')
}

/** A picked set, split into what the Media Library takes and the 3D models it refuses. */
export function splitModelFiles<F extends { name: string; type?: string }>(files: F[]): { media: F[]; models: F[] } {
  return { media: files.filter((f) => !isModelFile(f)), models: files.filter(isModelFile) }
}

/** Human-readable message for a failed media upload. */
export function uploadErrorMessage(err: any): string {
  const msg = err?.message || ''
  if (msg === 'use_asset_library') return MODEL_NOT_MEDIA
  // 'HTTP 413' is a non-JSON 413 (e.g. a proxy's body-size page) — still a size problem.
  if (msg === 'unsupported_type' || msg === 'too_large' || msg === 'HTTP 413') return MEDIA_UPLOAD_RULES
  return msg || 'Upload failed'
}
