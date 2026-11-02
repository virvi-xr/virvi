import { runtimeFiles } from '../dcl/runtime.js'
import { ImportError, type SceneFolder } from './scene-zip.js'

/** 2.5.0 carries the analytics item names; a scene on an older range is raised to it. */
export const VIRVI_DCL_RANGE = '^2.5.0'

const PACKAGE = '@virvixr/dcl'
const HUD_ICON = 'images/virvi/hud-v.png'
const MAIN_FILES = ['src/index.ts', 'src/index.tsx', 'src/index.js']
const IMPORT_LINE = `import { createVirvi } from '${PACKAGE}'`
const ALREADY_IMPORTED = /\bimport\s*(?:type\s+)?\{[^}]*\bcreateVirvi\b[^}]*\}/

// The opening `{` of an exported `main`: function, async function, or arrow assigned to a const.
const MAIN_FORMS = [
  /export\s+(?:async\s+)?function\s+main\s*\([^)]*\)[^{;=]*\{/,
  /export\s+const\s+main\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+?)?=>\s*\{/,
]

type Version = [number, number, number]

/** Minimum version of a simple range (`^2.4.0`, `~2.1`, `>=2`, `2.x`), or null for anything else. */
function minVersion(spec: string): Version | null {
  const m = /^(?:[\^~]|>=|=|v)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(spec.trim())
  if (!m) return null
  const n = (s: string | undefined) => (s === undefined || s === 'x' || s === '*' ? 0 : Number(s))
  return [Number(m[1]), n(m[2]), n(m[3])]
}

const lower = (a: Version, b: Version) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

function withDependency(pkgText: string | undefined): string | null {
  let pkg: Record<string, unknown> = {}
  if (pkgText !== undefined) {
    let parsed: unknown
    try { parsed = JSON.parse(pkgText) } catch { parsed = undefined }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ImportError(422, 'bad_package_json', 'package.json could not be read.')
    pkg = parsed as Record<string, unknown>
  }
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies) ? (pkg.dependencies as Record<string, unknown>) : undefined
  const current = deps?.[PACKAGE]
  const have = typeof current === 'string' ? minVersion(current) : null
  const want = minVersion(VIRVI_DCL_RANGE)!
  if (have && !lower(have, want)) return null
  if (deps) deps[PACKAGE] = VIRVI_DCL_RANGE
  else pkg.dependencies = { [PACKAGE]: VIRVI_DCL_RANGE }
  return JSON.stringify(pkg, null, 2) + '\n'
}

/** The source with `void createVirvi()` first in `main` and the import on top, or null when it already imports createVirvi. */
function withCreateVirvi(src: string): string | null {
  const hit = MAIN_FORMS.map((re) => re.exec(src)).find((m) => m)
  if (!hit) throw new ImportError(422, 'no_main', 'The scene has no exported main() function in src/index.')
  if (ALREADY_IMPORTED.test(src)) return null
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const at = hit.index + hit[0].length
  const rest = src.slice(at)
  const call = `${eol}  void createVirvi()`
  const body =
    /^\s*\}/.test(rest) ? `${call}${eol}${rest.replace(/^\s+/, '')}`
    : /^[ \t]*\r?\n/.test(rest) ? `${call}${rest}`
    : `${call}${eol}${rest}`
  return `${IMPORT_LINE}${eol}${src.slice(0, at)}${body}`
}

/**
 * Edits an uploaded scene so it runs Virvi: the `@virvixr/dcl` dependency, `void createVirvi()` first in `main()`,
 * and the HUD icon. Returns a new file map (the input is untouched) and the edited paths.
 */
export async function installVirvi(folder: SceneFolder): Promise<{ files: Map<string, Uint8Array>; changed: string[] }> {
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  const files = new Map(folder.files)
  const changed: string[] = []

  const mainPath = MAIN_FILES.find((p) => files.has(p))
  if (!mainPath) throw new ImportError(422, 'no_main', 'The scene has no src/index.ts to add Virvi to.')
  const edited = withCreateVirvi(dec.decode(files.get(mainPath)!))

  const pkgBytes = files.get('package.json')
  const pkgText = withDependency(pkgBytes && dec.decode(pkgBytes))
  if (pkgText !== null) { files.set('package.json', enc.encode(pkgText)); changed.push('package.json') }
  if (edited !== null) { files.set(mainPath, enc.encode(edited)); changed.push(mainPath) }

  const icon = (await runtimeFiles()).get(HUD_ICON)
  if (!icon) throw new Error(`Runtime is missing ${HUD_ICON}`)
  const old = files.get(HUD_ICON)
  if (!old || old.length !== icon.length || old.some((b, i) => b !== icon[i])) { files.set(HUD_ICON, icon); changed.push(HUD_ICON) }

  return { files, changed }
}
