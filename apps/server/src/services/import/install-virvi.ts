import { runtimeFiles } from '../dcl/runtime.js'
import { ImportError, type SceneFolder } from './scene-zip.js'

/** 2.5.0 carries the analytics item names; a scene on an older range is raised to it. */
export const VIRVI_DCL_RANGE = '^2.5.0'

const PACKAGE = '@virvixr/dcl'
const HUD_ICON = 'images/virvi/hud-v.png'
const MAIN_FILES = ['src/index.ts', 'src/index.tsx', 'src/index.js']
const IMPORT_LINE = `import { createVirvi } from '${PACKAGE}'`

// Where an exported `main`'s parameter list opens (run on the masked source).
const MAIN_HEADS = [
  /export\s+(?:async\s+)?function\s+main\s*\(/g,
  /export\s+const\s+main\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g,
]

/** Same-length copy with comment text and string contents blanked (newlines and quote marks kept). */
function maskSource(src: string): string {
  const out = src.split('')
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ' }
  let i = 0
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (c === '/' && n === '/') {
      let e = i
      while (e < src.length && src[e] !== '\n') e++
      blank(i, e); i = e
    } else if (c === '/' && n === '*') {
      const close = src.indexOf('*/', i + 2)
      const e = close < 0 ? src.length : close + 2
      blank(i, e); i = e
    } else if (c === '"' || c === "'" || c === '`') {
      let e = i + 1
      while (e < src.length && src[e] !== c && (c === '`' || src[e] !== '\n')) e += src[e] === '\\' ? 2 : 1
      e = Math.min(e, src.length)
      blank(i + 1, e); i = e + 1
    } else i++
  }
  return out.join('')
}

const OPEN = '([{', CLOSE = ')]}'

/** Index just past the bracket that closes the one at `at` (masked source), or -1. */
function skipBrackets(m: string, at: number): number {
  let depth = 0
  for (let i = at; i < m.length; i++) {
    if (OPEN.includes(m[i])) depth++
    else if (CLOSE.includes(m[i]) && --depth === 0) return i + 1
  }
  return -1
}

/** Index of main's body `{` given the `(` that opens its parameters, or -1 when there is no block body. */
function findBodyBrace(m: string, paren: number, arrow: boolean): number {
  let i = skipBrackets(m, paren)
  if (i < 0) return -1
  let depth = 0 // () [] {} and <> inside the return type
  for (; i < m.length; i++) {
    const c = m[i]
    if (c === '=' && m[i + 1] === '>') {
      i++
      if (depth === 0 && arrow) { while (/\s/.test(m[i + 1] ?? '')) i++; return m[i + 1] === '{' ? i + 1 : -1 }
      continue
    }
    if (depth === 0 && c === '{' && !arrow) {
      let j = i - 1
      while (j >= 0 && /\s/.test(m[j])) j--
      const prev = m[j] ?? ''
      const typeLiteral = /[:|&,(<]/.test(prev) || (prev === '>' && m[j - 1] === '=')
      if (!typeLiteral) return i
    }
    if (depth === 0 && !arrow && (c === ';' || c === '}')) return -1
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--
    if (depth < 0) return -1
  }
  return -1
}

/** Where `import { … } from` statements put createVirvi: the local name of a value import, if any. */
function importedName(src: string, m: string): string | null {
  const re = /\bimport\s*(type\s+)?\{([^}]*)\}\s*from\s*(['"`])( *)\3/g
  for (let hit = re.exec(m); hit; hit = re.exec(m)) {
    if (hit[1]) continue
    for (const spec of hit[2].split(',')) {
      const mm = /^\s*(?!type\s)(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(spec)
      if (mm && mm[1] === 'createVirvi') return mm[2] ?? mm[1]
    }
  }
  return null
}

/** Scene code Virvi may already be started from: anything under src/, and Creator Hub scripts under assets/. */
const SOURCE_FILE = /^(?:src|assets)\/.+\.(?:ts|tsx|js)$/

/**
 * The names a source value-imports from @virvixr/dcl (`*` for a default or namespace import), read on the masked
 * source with the module specifier taken from the original. `import type` and `type X` specifiers don't count.
 */
function virviValueImports(src: string, m: string): string[] {
  const re = /\bimport\s+(type\s+)?([^;'"`]*?)\s*from\s*(['"`])( *)\3/g
  const names: string[] = []
  for (let hit = re.exec(m); hit; hit = re.exec(m)) {
    const end = hit.index + hit[0].length - 1
    if (hit[1] || src.slice(end - hit[4].length, end) !== PACKAGE) continue
    const clause = hit[2]
    const braces = /\{([^}]*)\}/.exec(clause)
    for (const spec of braces ? braces[1].split(',') : []) {
      const mm = /^\s*(?!type\s)(\w+)(?:\s+as\s+\w+)?\s*$/.exec(spec)
      if (mm) names.push(mm[1])
    }
    if (clause.replace(/\{[^}]*\}/, '').replace(/[\s,]/g, '')) names.push('*')
  }
  return names
}

/**
 * Whether the scene already starts Virvi somewhere: another source file imports @virvixr/dcl (the Creator Hub
 * VirviManager script, a createVirvi call in another module), or the main file imports more than createVirvi from it, or
 * calls the createVirvi it imports anywhere. A main file that imports createVirvi and never calls it is not (Ruling R7).
 */
function virviPresent(sources: Map<string, string>, mainPath: string): boolean {
  for (const [path, src] of sources) {
    const m = maskSource(src)
    const names = virviValueImports(src, m)
    if (!names.length) continue
    if (path !== mainPath || names.some((n) => n !== 'createVirvi')) return true
    const local = importedName(src, m)
    if (local && new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}\\s*\\(`).test(m)) return true
  }
  return false
}

/** Offset just after any leading `/// <reference …/>` lines and a 'use strict' directive. */
function headerEnd(src: string): number {
  let at = 0
  for (const line of src.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (!/^\s*\/\/\/\s*<reference\b/.test(line) && !/^\s*(['"])use strict\1;?\s*$/.test(line)) break
    at += line.length
    if (!line.endsWith('\n')) return at
  }
  return at
}

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
  const want = minVersion(VIRVI_DCL_RANGE)!
  const obj = (k: string) => (pkg[k] && typeof pkg[k] === 'object' && !Array.isArray(pkg[k]) ? (pkg[k] as Record<string, unknown>) : undefined)
  const holders = ['dependencies', 'devDependencies'].map(obj).filter((o): o is Record<string, unknown> => !!o && PACKAGE in o)
  if (holders.length === 0) {
    const deps = obj('dependencies')
    if (deps) deps[PACKAGE] = VIRVI_DCL_RANGE
    else pkg.dependencies = { [PACKAGE]: VIRVI_DCL_RANGE }
    return JSON.stringify(pkg, null, 2) + '\n'
  }
  let edited = false
  for (const h of holders) {
    const have = typeof h[PACKAGE] === 'string' ? minVersion(h[PACKAGE] as string) : null
    if (have && !lower(have, want)) continue
    h[PACKAGE] = VIRVI_DCL_RANGE
    edited = true
  }
  return edited ? JSON.stringify(pkg, null, 2) + '\n' : null
}

/** The source with `void createVirvi()` first in `main` (and the import if missing), or null when nothing needs adding. */
function withCreateVirvi(src: string): string | null {
  const m = maskSource(src)
  const hits = MAIN_HEADS.flatMap((re, form) => [...m.matchAll(re)].map((h) => ({ index: h.index!, paren: h.index! + h[0].length - 1, arrow: form === 1 })))
  const hit = hits.sort((a, b) => a.index - b.index)[0]
  const open = hit ? findBodyBrace(m, hit.paren, hit.arrow) : -1
  if (open < 0) throw new ImportError(422, 'no_main', 'The scene has no exported main() function in src/index.')
  const close = skipBrackets(m, open)
  const local = importedName(src, m)
  const name = local ?? 'createVirvi'
  if (local && new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`).test(m.slice(open, close < 0 ? m.length : close))) return null
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const at = open + 1
  const rest = src.slice(at)
  const call = `${eol}  void ${name}()`
  const body =
    /^\s*\}/.test(rest) ? `${call}${eol}${rest.replace(/^\s+/, '')}`
    : /^[ \t]*\r?\n/.test(rest) ? `${call}${rest}`
    : `${call}${eol}${rest}`
  const edited = src.slice(0, at) + body
  if (local) return edited
  const h = headerEnd(src)
  return `${edited.slice(0, h)}${IMPORT_LINE}${eol}${edited.slice(h)}`
}

/**
 * Edits an uploaded scene so it runs Virvi: the `@virvixr/dcl` dependency, `void createVirvi()` first in `main()`,
 * and the HUD icon. A scene that already starts Virvi (virviPresent) gets no code edit, only the dependency range and
 * the icon, and `alreadyInstalled`. Returns a new file map (the input is untouched) and the edited paths.
 */
export async function installVirvi(folder: SceneFolder): Promise<{ files: Map<string, Uint8Array>; changed: string[]; alreadyInstalled: boolean }> {
  const dec = new TextDecoder()
  const strict = new TextDecoder('utf-8', { fatal: true })
  const enc = new TextEncoder()
  const files = new Map(folder.files)
  const changed: string[] = []

  const mainPath = MAIN_FILES.find((p) => files.has(p))
  if (!mainPath) throw new ImportError(422, 'no_main', 'The scene has no src/index.ts to add Virvi to.')
  let source: string
  try { source = strict.decode(files.get(mainPath)!) } catch { throw new ImportError(422, 'bad_source_encoding', `${mainPath} is not valid UTF-8 text.`) }
  const sources = new Map<string, string>()
  for (const [path, bytes] of files) if (SOURCE_FILE.test(path)) sources.set(path, path === mainPath ? source : dec.decode(bytes))
  const alreadyInstalled = virviPresent(sources, mainPath)
  const edited = alreadyInstalled ? null : withCreateVirvi(source)

  const pkgBytes = files.get('package.json')
  const pkgText = withDependency(pkgBytes && dec.decode(pkgBytes))
  if (pkgText !== null) { files.set('package.json', enc.encode(pkgText)); changed.push('package.json') }
  if (edited !== null) { files.set(mainPath, enc.encode(edited)); changed.push(mainPath) }

  const icon = (await runtimeFiles()).get(HUD_ICON)
  if (!icon) throw new Error(`Runtime is missing ${HUD_ICON}`)
  const old = files.get(HUD_ICON)
  if (!old || old.length !== icon.length || old.some((b, i) => b !== icon[i])) { files.set(HUD_ICON, icon); changed.push(HUD_ICON) }

  return { files, changed, alreadyInstalled }
}
