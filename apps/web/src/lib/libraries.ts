/**
 * The two libraries (LIV-132), in the words every page uses. They stay separate:
 * - Images & Video (/media) holds images and video for your scenes, no 3D models;
 * - 3D Models (/assets) holds 3D models only: your own (private when uploaded) and shared ones.
 * Routes and code keep their old names (media, assets); only the words people see changed.
 * Files in either are stored at unguessable public links, so the copy never says a file is hidden from the web.
 */
export const MEDIA_LIBRARY = {
  name: 'Images & Video',
  purpose: 'Images and video for your scenes',
  subtitle: 'Images and video for your scenes. 3D models go in 3D Models.',
  uploadHelp: 'Only you see your uploads in this list. Visitors see a file in scenes you place it in, and anyone with the link can open it.',
} as const

export const ASSET_LIBRARY = {
  name: '3D Models',
  purpose: '3D models, your own and shared ones',
  subtitle: '3D models, your own and shared ones. Images and video go in Images & Video.',
  uploadHelp: 'Your upload is private: only you see it here, under My Models. Visitors see it in scenes you place it in, and anyone with the link can open the file.',
} as const

export const MEDIA_UPLOAD_RULES = 'Only PNG, JPG, WebP, GIF (≤ 10 MB) or MP4/WebM video (≤ 70 MB)'

export const MODEL_NOT_MEDIA = '3D models go in 3D Models, not Images & Video: upload GLB files on the 3D Models page.'

/** A 3D model file (GLB or glTF), by name or type: Images & Video doesn't take these. */
export function isModelFile(file: { name: string; type?: string }): boolean {
  return /\.(glb|gltf)$/i.test(file.name) || /^model\/gltf/i.test(file.type ?? '')
}

/** A picked set, split into what Images & Video takes and the 3D models it refuses. */
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

/** A 3D Models item as the scene editor's picker lists files (it shows media rows: filename, publicUrl, contentType). */
export function asPickerModel(a: { id: string; name: string; cdnUrl?: string | null }): { id: string; filename: string; publicUrl: string; contentType: string } {
  return { id: a.id, filename: a.name, publicUrl: a.cdnUrl ?? '', contentType: 'model/gltf-binary' }
}

/** The model picker pages through your 3D Models (newest first, LIV-132), optionally searched by name. */
export const MODEL_PICKER_PAGE = 50

/** The 3D Models request for one picker page: yours, `search` by name or description when given. */
export function modelPickerQuery(search: string, offset: number): { mine: 'all'; limit: string; offset: string; q?: string } {
  const q = search.trim()
  return { mine: 'all', limit: String(MODEL_PICKER_PAGE), offset: String(offset), ...(q ? { q } : {}) }
}
