// The Import page's zip of a picked scene folder, made in the browser with the same rules the server reads it by
// (apps/server/src/services/import/scene-zip.ts): build output and tooling folders never leave the computer.
import { zipSync } from 'fflate'

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

/** The scene's files as one zip, paths relative to the scene, without node_modules/, the root bin/, .git/ and .DS_Store. */
export function zipSceneFiles(files: { path: string; bytes: Uint8Array }[]): Uint8Array {
  const kept = scenePathMap(files.map((f) => f.path))
  const entries: Record<string, Uint8Array> = {}
  for (const f of files) {
    const rel = kept.get(f.path)
    if (rel) entries[rel] = f.bytes
  }
  return zipSync(entries)
}
