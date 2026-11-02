import { unzipSync } from 'fflate'

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

const MAX_FILES = 2000
const MAX_UNZIPPED_BYTES = 300 * 1024 * 1024
const DROPPED_DIRS = new Set(['__MACOSX', 'node_modules', 'bin', '.git'])

/** Normalised path segments, or throws unsafe_path. Backslashes count as separators. */
function safeSegments(name: string): string[] {
  const p = name.replace(/\\/g, '/')
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\0')) throw new ImportError(422, 'unsafe_path', `Unsafe path in zip: ${name}`)
  const segs = p.split('/').filter((s) => s !== '' && s !== '.')
  if (segs.includes('..')) throw new ImportError(422, 'unsafe_path', `Unsafe path in zip: ${name}`)
  return segs
}

const isParcelList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')

/** Reads an uploaded scene zip into a validated, normalised `SceneFolder`. */
export function readSceneZip(zip: Uint8Array): SceneFolder {
  // Paths are checked, dropped entries skipped and sizes counted in the filter, before anything is inflated.
  const segsByName = new Map<string, string[]>()
  let total = 0
  let count = 0
  let raw: Record<string, Uint8Array>
  try {
    raw = unzipSync(zip, {
      filter: (f) => {
        const segs = safeSegments(f.name)
        if (f.name.endsWith('/') || segs.length === 0) return false
        if (segs.slice(0, -1).some((s) => DROPPED_DIRS.has(s)) || segs[segs.length - 1] === '.DS_Store') return false
        if (++count > MAX_FILES) throw new ImportError(413, 'too_many_files', `A scene can have at most ${MAX_FILES} files.`)
        total += f.originalSize
        if (total > MAX_UNZIPPED_BYTES) throw new ImportError(413, 'too_big', 'The unzipped scene is larger than 300 MB.')
        segsByName.set(f.name, segs)
        return true
      },
    })
  } catch (e) {
    if (e instanceof ImportError) throw e
    throw new ImportError(400, 'not_a_zip', 'That file is not a readable zip.')
  }

  let entries = Object.keys(raw).map((name) => ({ segs: segsByName.get(name)!, data: raw[name]! }))
  const atRoot = entries.some((e) => e.segs.length === 1 && e.segs[0] === 'scene.json')
  if (!atRoot && entries.length > 0) {
    const top = entries[0]!.segs[0]
    if (entries.every((e) => e.segs.length > 1 && e.segs[0] === top)) entries = entries.map((e) => ({ ...e, segs: e.segs.slice(1) }))
  }
  const files = new Map<string, Uint8Array>()
  for (const e of entries) files.set(e.segs.join('/'), e.data)

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
  if (!name.endsWith('.eth')) throw new ImportError(422, 'bad_world_name', 'worldConfiguration.name must be a .eth name.')
  return { files, sceneJson, kind, location: { kind: 'world', world: name, parcels, base } }
}
