// The Import page's zip of a picked scene folder, made in the browser with the same rules the server reads it by
// (apps/server/src/services/import/scene-zip.ts): build output and tooling folders never leave the computer.
import { zip, zipSync, type AsyncZippable } from 'fflate'
import { SCENE_IMPORT_MAX_FILES, SCENE_IMPORT_MAX_UNZIPPED_BYTES } from '@virvixr/shared'

/** Dropped wherever they appear (Ruling R4); `bin/` only at the scene root. */
const DROPPED_DIRS = new Set(['__MACOSX', 'node_modules', '.git'])

const segments = (path: string) => path.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
const alwaysDropped = (segs: string[]) => segs.slice(0, -1).some((s) => DROPPED_DIRS.has(s)) || segs[segs.length - 1] === '.DS_Store'

/**
 * Each kept file's path inside the scene, by its picked path. A folder picker's `webkitRelativePath` starts with the
 * folder's own name ("my-scene/scene.json"): that single top folder is stripped unless scene.json is already at the top.
 */
export function scenePathMap(paths: string[]): Map<string, string> {
  const candidates = paths.map((p) => [p, segments(p)] as const).filter(([, s]) => s.length > 0 && !alwaysDropped(s))
  const atRoot = candidates.some(([, s]) => s.length === 1 && s[0] === 'scene.json')
  const top = candidates[0]?.[1][0]
  const strip = !atRoot && candidates.length > 0 && candidates.every(([, s]) => s.length > 1 && s[0] === top) ? 1 : 0
  const out = new Map<string, string>()
  for (const [path, segs] of candidates) {
    const rel = segs.slice(strip)
    if (rel.length === 0 || (rel.length > 1 && rel[0] === 'bin')) continue
    out.set(path, rel.join('/'))
  }
  return out
}

/**
 * Why the kept files can't be imported, before any is read: the server's limits on the unzipped scene
 * (scene-zip.ts), or null.
 */
export function folderTooBig(kept: { size: number }[]): string | null {
  if (kept.length > SCENE_IMPORT_MAX_FILES) {
    return `The scene has ${kept.length} files, over the ${SCENE_IMPORT_MAX_FILES} an import takes. Remove the ones it doesn't use, then try again.`
  }
  const bytes = kept.reduce((n, f) => n + f.size, 0)
  if (bytes > SCENE_IMPORT_MAX_UNZIPPED_BYTES) {
    return `The scene's files add up to more than the ${SCENE_IMPORT_MAX_UNZIPPED_BYTES / 1024 / 1024} MB an import takes. Remove large files it doesn't use, then try again.`
  }
  return null
}

/** Formats that are compressed already: deflating them again costs time and saves next to nothing. */
const STORED = /\.(glb|gltf|png|jpe?g|webp|gif|ktx2|basis|mp4|webm|mp3|ogg|wav|zip)$/i

function entries(files: { path: string; bytes: Uint8Array }[]): AsyncZippable {
  const kept = scenePathMap(files.map((f) => f.path))
  const out: AsyncZippable = {}
  for (const f of files) {
    const rel = kept.get(f.path)
    if (rel) out[rel] = STORED.test(rel) ? [f.bytes, { level: 0 }] : f.bytes
  }
  return out
}

/** The scene's files as one zip, paths relative to the scene, without node_modules/, the root bin/, .git/ and .DS_Store. */
export function zipSceneFiles(files: { path: string; bytes: Uint8Array }[]): Uint8Array {
  return zipSync(entries(files))
}

/** As zipSceneFiles, deflated off the main thread (fflate's workers), so the page doesn't freeze. */
export function zipSceneFilesAsync(files: { path: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip(entries(files), (err, data) => (err ? reject(err) : resolve(data))))
}
