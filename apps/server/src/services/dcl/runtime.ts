/**
 * The generic Virvi Decentraland runtime: one pre-built scene bundle deployed for every wizard World.
 *
 * Contract: the runtime reads `scene.json`'s `virvi.{apiUrl,wssUrl}` through
 * `getSceneInformation().metadataJson` and calls `createVirvi({ apiUrl, wssUrl })` with no `sceneId`.
 * The scene is found through the location setup (created in Task 7), the same path every `@virvixr/dcl`
 * scene uses; that setup is also what grants in-world edit rights, so no separate scene-id file exists.
 * Models load from `models/virvi/<basename>.glb`, as `DclAdapter.resolveModelSrc` does.
 *
 * Built output is committed under apps/server/dcl-runtime/<version>/ (rebuild with `bash dcl-runtime/build.sh`):
 * bin/index.js and the HUD icon images/virvi/hud-v.png. Every file in the version's directory is a
 * runtime file, deployed at the same scene-relative path. Versions before 3 spoke the pre-Virvi protocol and were
 * removed; a deployment waiting to be signed rebuilds its runtime files by version (world-deployer rebuildNewFiles),
 * so one left over from those versions fails and is started again.
 * Resolved relative to this module, so it works from src/ and dist/services/dcl/.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DCL_RUNTIME_VERSION = 4

const RUNTIME_ROOT = fileURLToPath(new URL('../../../dcl-runtime/', import.meta.url))

/** Files under `dir`, as '/'-separated paths relative to it (dotfiles skipped). */
async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), `${prefix}${e.name}/`)))
    else if (e.isFile()) out.push(`${prefix}${e.name}`)
  }
  return out
}

export async function runtimeFiles(version: number = DCL_RUNTIME_VERSION): Promise<Map<string, Uint8Array>> {
  if (!Number.isInteger(version) || version < 1) throw new Error(`Unknown Decentraland runtime version: ${version}`)
  const root = `${RUNTIME_ROOT}${version}`
  let paths: string[]
  try {
    paths = (await walk(root)).sort()
  } catch {
    throw new Error(`Unknown Decentraland runtime version: ${version}`)
  }
  if (!paths.includes('bin/index.js')) throw new Error(`Unknown Decentraland runtime version: ${version}`)
  const files = new Map<string, Uint8Array>()
  for (const p of paths) files.set(p, new Uint8Array(await readFile(join(root, p))))
  return files
}
