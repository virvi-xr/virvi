import { runtimeFiles } from '../dcl/runtime.js'
import { ImportError, type SceneFolder } from './scene-zip.js'

/** 2.5.0 carries the analytics item names; a scene on an older range is raised to it. */
export const VIRVI_DCL_RANGE = '^2.13.0'
/** Every range installVirvi has ever written (VIRVI_DCL_RANGE included), so uninstalling recognises an older install's own dependency. Add the old value here whenever VIRVI_DCL_RANGE moves. */
export const VIRVI_DCL_RANGES_WRITTEN: readonly string[] = ['^2.5.0', '^2.6.0', '^2.7.0', '^2.8.0', VIRVI_DCL_RANGE]

export const PACKAGE = '@virvixr/dcl'
export const HUD_ICON = 'images/virvi/hud-v.png'
export const MAIN_FILES = ['src/index.ts', 'src/index.tsx', 'src/index.js']
export const IMPORT_LINE = `import { createVirvi } from '${PACKAGE}'`

// Where an exported `main`'s parameter list opens (run on the masked source). Every repeat is bounded, so no match
// attempt can scan to the end of a hostile file from every position (N2).
export const MAIN_HEADS = [
  /export\s{1,200}(?:async\s{1,200})?function\s{1,200}main\s{0,200}\(/g,
  /export\s{1,200}const\s{1,200}main\s{0,200}(?::[^=]{1,500})?=\s{0,200}(?:async\s{0,200})?\(/g,
]

/** Same-length copy with comment text and string contents blanked (newlines and quote marks kept). */
export function maskSource(src: string): string {
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
export function skipBrackets(m: string, at: number): number {
  let depth = 0
  for (let i = at; i < m.length; i++) {
    if (OPEN.includes(m[i])) depth++
    else if (CLOSE.includes(m[i]) && --depth === 0) return i + 1
  }
  return -1
}

/** Index of main's body `{` given the `(` that opens its parameters, or -1 when there is no block body. */
export function findBodyBrace(m: string, paren: number, arrow: boolean): number {
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

/** The longest import clause read (`import … from`); a longer one is not an import Virvi cares about. */
const MAX_CLAUSE = 2000
const QUOTES = `'"\``
const isWord = (c: string | undefined) => !!c && /[\w$]/.test(c)
const wordAt = (m: string, i: number, w: string) => m.startsWith(w, i) && !isWord(m[i - 1]) && !isWord(m[i + w.length])

interface ImportStatement { typeOnly: boolean; clause: string; specifier: string }

/**
 * Every `import … from '…'` statement, read in one pass over the masked source (comments and string contents blank)
 * instead of a backtracking regex (N2). A statement's scan stops at the first `;`, quote or next `import`, and after
 * MAX_CLAUSE characters, so the whole read is linear in the file's size. The specifier comes from the original text.
 */
export function importStatements(src: string, m: string): ImportStatement[] {
  const out: ImportStatement[] = []
  const skipWs = (i: number) => { while (i < m.length && /\s/.test(m[i])) i++; return i }
  for (let i = m.indexOf('import'); i >= 0; i = m.indexOf('import', i + 1)) {
    if (!wordAt(m, i, 'import')) continue
    let j = skipWs(i + 6)
    const typeOnly = wordAt(m, j, 'type')
    if (typeOnly) j = skipWs(j + 4)
    let depth = 0
    let from = -1
    for (let k = j; k < m.length && k - j <= MAX_CLAUSE; k++) {
      const c = m[k]
      if (c === ';' || QUOTES.includes(c) || (k > j && wordAt(m, k, 'import'))) break
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (depth === 0 && wordAt(m, k, 'from')) { from = k; break }
    }
    if (from < 0) continue
    const q = skipWs(from + 4)
    if (!QUOTES.includes(m[q] ?? '')) continue
    const close = m.indexOf(m[q], q + 1)
    const nl = m.indexOf('\n', q + 1)
    if (close < 0 || (nl >= 0 && nl < close)) continue
    out.push({ typeOnly, clause: m.slice(j, from).trim(), specifier: src.slice(q + 1, close) })
    i = close
  }
  return out
}

/** The `{ … }` specifiers of a clause that import a value (not `type X`), as [imported, local]. */
function valueSpecifiers(clause: string): Array<[string, string]> {
  const braces = /\{([^}]*)\}/.exec(clause)
  const out: Array<[string, string]> = []
  for (const spec of braces ? braces[1].split(',') : []) {
    const mm = /^\s*(?!type\s)(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(spec)
    if (mm) out.push([mm[1], mm[2] ?? mm[1]])
  }
  return out
}

/** Where `import { … } from` statements put createVirvi: the local name of a value import, if any. */
function importedName(src: string, m: string): string | null {
  for (const st of importStatements(src, m)) {
    if (st.typeOnly) continue
    const hit = valueSpecifiers(st.clause).find(([name]) => name === 'createVirvi')
    if (hit) return hit[1]
  }
  return null
}

/** Scene code Virvi may already be started from: anything under src/, and Creator Hub scripts under assets/. */
export const SOURCE_FILE = /^(?:src|assets)\/.+\.(?:ts|tsx|js)$/

/**
 * The names a source value-imports from @virvixr/dcl (`*` for a default or namespace import). `import type` and
 * `type X` specifiers don't count.
 */
function virviValueImports(src: string, m: string): string[] {
  const names: string[] = []
  for (const st of importStatements(src, m)) {
    if (st.typeOnly || st.specifier !== PACKAGE) continue
    names.push(...valueSpecifiers(st.clause).map(([name]) => name))
    if (st.clause.replace(/\{[^}]*\}/, '').replace(/[\s,]/g, '')) names.push('*')
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
export function headerEnd(src: string): number {
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

/** Index of the `{` that opens the first exported `main`'s body in the masked source, or -1 when there is none. */
export function mainBodyBrace(m: string): number {
  const hits = MAIN_HEADS.flatMap((re, form) => [...m.matchAll(re)].map((h) => ({ index: h.index!, paren: h.index! + h[0].length - 1, arrow: form === 1 })))
  const hit = hits.sort((a, b) => a.index - b.index)[0]
  return hit ? findBodyBrace(m, hit.paren, hit.arrow) : -1
}

/** The source with `statement` on its own line just inside the body brace at `open` (indented two spaces). */
export function withFirstStatement(src: string, open: number, statement: string): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const at = open + 1
  const rest = src.slice(at)
  const call = `${eol}  ${statement}`
  const body =
    /^\s*\}/.test(rest) ? `${call}${eol}${rest.replace(/^\s+/, '')}`
    : /^[ \t]*\r?\n/.test(rest) ? `${call}${rest}`
    : `${call}${eol}${rest}`
  return src.slice(0, at) + body
}

/** The source with `line` (an import) after any leading reference lines and 'use strict'. */
export function withImportLine(src: string, line: string): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const h = headerEnd(src)
  return `${src.slice(0, h)}${line}${eol}${src.slice(h)}`
}

/** The source with `void createVirvi()` first in `main` (and the import if missing), or null when nothing needs adding. */
function withCreateVirvi(src: string): string | null {
  const m = maskSource(src)
  const open = mainBodyBrace(m)
  if (open < 0) throw new ImportError(422, 'no_main', 'The scene has no exported main() function in src/index.')
  const close = skipBrackets(m, open)
  const local = importedName(src, m)
  const name = local ?? 'createVirvi'
  if (local && new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`).test(m.slice(open, close < 0 ? m.length : close))) return null
  const edited = withFirstStatement(src, open, `void ${name}()`)
  return local ? edited : withImportLine(edited, IMPORT_LINE)
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
