import { unzipSync } from 'fflate'
import { SCENE_IMPORT_MAX_FILES, SCENE_IMPORT_MAX_UNZIPPED_BYTES } from '@virvixr/shared'

export class ImportError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code)
    this.name = 'ImportError'
  }
}

export interface SceneFolder {
  files: Map<string, Uint8Array>
  sceneJson: Record<string, unknown>
  kind: 'creator-hub' | 'sdk7'
  location:
    | { kind: 'world'; world: string; parcels: string[]; base: string }
    | { kind: 'parcels'; parcels: string[]; base: string }
}

const MAX_FILES = SCENE_IMPORT_MAX_FILES
const MAX_UNZIPPED_BYTES = SCENE_IMPORT_MAX_UNZIPPED_BYTES
const DROPPED_DIRS = new Set(['__MACOSX', 'node_modules', 'bin', '.git'])

/** Normalised path segments, or throws unsafe_path. Backslashes count as separators. */
export function safeSegments(name: string): string[] {
  const p = name.replace(/\\/g, '/')
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\0')) throw new ImportError(422, 'unsafe_path', `Unsafe path in zip: ${name}`)
  const segs = p.split('/').filter((s) => s !== '' && s !== '.')
  if (segs.includes('..')) throw new ImportError(422, 'unsafe_path', `Unsafe path in zip: ${name}`)
  return segs
}

const isParcelList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')

const WORLD_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/
/** Dropped wherever they appear; `bin/` is dropped only at the scene root. */
const alwaysDropped = (segs: string[]) => segs.slice(0, -1).some((s) => s !== 'bin' && DROPPED_DIRS.has(s)) || segs[segs.length - 1] === '.DS_Store'

/** Reads an uploaded scene zip into a validated, normalised `SceneFolder`. */
export function readSceneZip(zip: Uint8Array): SceneFolder {
  const notAZip = () => new ImportError(400, 'not_a_zip', 'That file is not a readable zip.')

  // Pass 1: names only (nothing is inflated). Checks paths and decides the wrapper-folder strip.
  const segsByName = new Map<string, string[]>()
  const seen = new Set<string>()
  try {
    unzipSync(zip, {
      filter: (f) => {
        const segs = safeSegments(f.name)
        if (f.name.endsWith('/') || segs.length === 0) return false
        const joined = segs.join('/')
        if (seen.has(joined)) throw new ImportError(422, 'unsafe_path', `Duplicate path in zip: ${f.name}`)
        seen.add(joined)
        segsByName.set(f.name, segs)
        return false
      },
    })
  } catch (e) {
    if (e instanceof ImportError) throw e
    throw notAZip()
  }
  const candidates = [...segsByName.values()].filter((s) => !alwaysDropped(s))
  const atRoot = candidates.some((s) => s.length === 1 && s[0] === 'scene.json')
  const top = candidates[0]?.[0]
  const strip = !atRoot && candidates.length > 0 && candidates.every((s) => s.length > 1 && s[0] === top) ? 1 : 0
  const keptSegs = (name: string): string[] | null => {
    const segs = segsByName.get(name)!
    if (alwaysDropped(segs)) return null
    const rel = segs.slice(strip)
    if (rel.length === 0 || (rel.length > 1 && rel[0] === 'bin')) return null
    return rel
  }

  // Pass 2: inflate kept entries only, counting files and declared bytes before each is expanded.
  const relByName = new Map<string, string[]>()
  let total = 0
  let raw: Record<string, Uint8Array>
  try {
    raw = unzipSync(zip, {
      filter: (f) => {
        const rel = segsByName.has(f.name) ? keptSegs(f.name) : null
        if (!rel) return false
        if (relByName.size + 1 > MAX_FILES) throw new ImportError(413, 'too_many_files', `A scene can have at most ${MAX_FILES} files.`)
        total += f.originalSize
        if (total > MAX_UNZIPPED_BYTES) throw new ImportError(413, 'too_big', 'The unzipped scene is larger than 300 MB.')
        relByName.set(f.name, rel)
        return true
      },
    })
  } catch (e) {
    if (e instanceof ImportError) throw e
    throw notAZip()
  }

  const files = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(raw)) files.set(relByName.get(name)!.join('/'), data)

  const sceneBytes = files.get('scene.json')
  if (!sceneBytes) throw new ImportError(422, 'no_scene_json', 'The zip has no scene.json.')
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder().decode(sceneBytes)) } catch { parsed = undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ImportError(422, 'bad_scene_json', 'scene.json could not be read.')
  const sceneJson = parsed as Record<string, unknown>

  if (typeof sceneJson.main !== 'string' || !sceneJson.main || !(sceneJson.runtimeVersion === '7' || sceneJson.ecs7 === true)) {
    throw new ImportError(422, 'not_sdk7', 'Only SDK7 scenes can be imported.')
  }
  const scene = sceneJson.scene as { parcels?: unknown; base?: unknown } | undefined
  if (!scene || !isParcelList(scene.parcels) || typeof scene.base !== 'string') {
    throw new ImportError(422, 'bad_scene_json', 'scene.json needs scene.parcels and scene.base.')
  }
  const { parcels, base } = { parcels: scene.parcels, base: scene.base }

  const kind = files.has('assets/scene/main.composite') ? 'creator-hub' : 'sdk7'
  const wc = sceneJson.worldConfiguration as { name?: unknown } | undefined
  if (wc === undefined || wc === null) return { files, sceneJson, kind, location: { kind: 'parcels', parcels, base } }
  const name = typeof wc.name === 'string' ? wc.name.toLowerCase() : ''
  if (!WORLD_NAME.test(name)) throw new ImportError(422, 'bad_world_name', 'worldConfiguration.name must be a .eth name.')
  return { files, sceneJson, kind, location: { kind: 'world', world: name, parcels, base } }
}
