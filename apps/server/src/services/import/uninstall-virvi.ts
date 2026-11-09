import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { sceneImports } from '../../db/schema.js'
import { getImportStore } from '../../storage/private-store.js'
import { readSceneZip } from './scene-zip.js'
import { HUD_ICON, IMPORT_LINE, MAIN_FILES, MAIN_HEADS, PACKAGE, SOURCE_FILE, VIRVI_DCL_RANGES_WRITTEN, findBodyBrace, headerEnd, importStatements, maskSource, skipBrackets } from './install-virvi.js'

const CREATOR_HUB_SCRIPT = 'assets/scene/Scripts/VirviManager.ts'
const SYNC_MANIFEST = 'models/virvi/.virvi-sync.json'
const SYNCED_MODEL = /^models\/virvi\/[^/]+$/
/** Files whose text can name a model path. */
const TEXT_FILE = /\.(?:ts|tsx|js|json|composite|md)$/i
const CALL = 'void createVirvi()'

const dec = new TextDecoder()
const enc = new TextEncoder()

/** The main file's source without the `void createVirvi()` call and import line installVirvi adds, or null if none. */
function withoutCreateVirvi(src: string): string | null {
  const m = maskSource(src)
  const hits = MAIN_HEADS.flatMap((re, form) => [...m.matchAll(re)].map((h) => ({ index: h.index!, paren: h.index! + h[0].length - 1, arrow: form === 1 })))
  const hit = hits.sort((a, b) => a.index - b.index)[0]
  const open = hit ? findBodyBrace(m, hit.paren, hit.arrow) : -1
  if (open < 0) return null
  const lead = /^(\r?\n)  void createVirvi\(\)/.exec(src.slice(open + 1))
  if (!lead) return null
  const eol = lead[1]
  const callEnd = open + 1 + lead[0].length
  const close = skipBrackets(m, open)
  // installVirvi's three shapes: an empty body, text after `{` on the brace's own line, and an ordinary body
  const afterEol = callEnd + eol.length
  const nextLineEnd = src.indexOf('\n', afterEol)
  const closeAt = close < 0 ? -1 : close - 1
  const joined = src.startsWith(eol, callEnd) && (src[afterEol] === '}' || (closeAt >= afterEol && (nextLineEnd < 0 || closeAt < nextLineEnd)))
  let out = src.slice(0, open + 1) + (joined ? src.slice(afterEol) : src.slice(callEnd))
  const h = headerEnd(out)
  if (out.startsWith(IMPORT_LINE, h)) {
    const nl = /^\r?\n/.exec(out.slice(h + IMPORT_LINE.length))
    out = out.slice(0, h) + out.slice(h + IMPORT_LINE.length + (nl ? nl[0].length : 0))
  }
  return out
}

/** Whether a source still imports @virvixr/dcl (a value or a type, or one of its subpaths). */
function importsVirvi(src: string): boolean {
  return importStatements(src, maskSource(src)).some((st) => st.specifier === PACKAGE || st.specifier.startsWith(`${PACKAGE}/`))
}

/** The source files (sorted paths) that import @virvixr/dcl. */
function virviImporters(files: Map<string, Uint8Array>): string[] {
  return [...files].filter(([path, bytes]) => SOURCE_FILE.test(path) && importsVirvi(dec.decode(bytes))).map(([path]) => path).sort()
}

/** package.json without the @virvixr/dcl range installVirvi adds, or null to leave it alone. */
function withoutDependency(pkgText: string): string | null {
  let pkg: unknown
  try { pkg = JSON.parse(pkgText) } catch { return null }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return null
  const record = pkg as Record<string, unknown>
  let edited = false
  for (const key of ['dependencies', 'devDependencies']) {
    const holder = record[key]
    // A range Virvi never wrote was the creator's own (installVirvi only adds, or raises to, its range of the day)
    if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue
    const range = (holder as Record<string, unknown>)[PACKAGE]
    if (typeof range !== 'string' || !VIRVI_DCL_RANGES_WRITTEN.includes(range)) continue
    delete (holder as Record<string, unknown>)[PACKAGE]
    if (Object.keys(holder).length === 0 && key === 'dependencies') delete record[key]
    edited = true
  }
  return edited ? JSON.stringify(record, null, 2) + '\n' : null
}

/**
 * Takes Virvi back out of a scene installVirvi edited: the exact reverse of its three edits (the dependency, the import
 * and `void createVirvi()`, the HUD icon), plus the Creator Hub VirviManager script and the `virvi-dcl sync` leftovers
 * (the manifest and models no file names). The original's byte layout can only be guessed from the result, so this is
 * for imports that predate the kept original upload. `alreadyInstalled` (the scene started Virvi itself) removes
 * nothing: the code, the dependency, the icon, the script and the synced models may all be the creator's own. `leftovers` are the files that still import @virvixr/dcl: the creator's own Virvi code.
 */
export function uninstallVirvi(input: Map<string, Uint8Array>, opts: { alreadyInstalled?: boolean } = {}): { files: Map<string, Uint8Array>; leftovers: string[] } {
  const files = new Map(input)
  if (!opts.alreadyInstalled) {
    files.delete(HUD_ICON)
    files.delete(CREATOR_HUB_SCRIPT)
    files.delete(SYNC_MANIFEST)
  }

  const mainPath = MAIN_FILES.find((p) => files.has(p))
  if (mainPath && !opts.alreadyInstalled) {
    const edited = withoutCreateVirvi(dec.decode(files.get(mainPath)!))
    if (edited !== null) files.set(mainPath, enc.encode(edited))
  }

  const named = new Set<string>()
  for (const [path, bytes] of files) if (TEXT_FILE.test(path) && path !== 'package.json') named.add(dec.decode(bytes))
  const text = [...named].join('\n')
  for (const path of opts.alreadyInstalled ? [] : [...files.keys()]) {
    if (SYNCED_MODEL.test(path) && !text.includes(path)) files.delete(path)
  }

  const leftovers = virviImporters(files)

  const pkgBytes = files.get('package.json')
  if (pkgBytes && leftovers.length === 0 && !opts.alreadyInstalled) {
    const edited = withoutDependency(dec.decode(pkgBytes))
    if (edited !== null) files.set('package.json', enc.encode(edited))
  }
  return { files, leftovers }
}

export interface SceneSource {
  files: Map<string, Uint8Array>
  leftovers: string[]
  /**
   * 'original': the creator's upload as kept; 'uninstalled': the stored source with Virvi taken back out; 'withheld':
   * the scene was imported, but the caller is neither its importer nor a full-access member; 'expired': the scene was
   * imported, but Virvi no longer has its code (the files were deleted or are unreadable, or no import ever deployed);
   * 'none': never imported.
   */
  origin: 'original' | 'uninstalled' | 'withheld' | 'expired' | 'none'
}

/** Who is asking for the creator's source (Ruling F1). */
export interface SourceCaller {
  userId: string
  fullAccess: boolean
}

const readable = (bytes: Buffer) => {
  try { return readSceneZip(new Uint8Array(bytes)).files } catch { return null }
}

/**
 * The creator's own scene source from the newest deployed import of the scene (any World or parcels): the kept
 * original.zip, else source.zip un-installed. Only that import's importer and full-access members get it (F1); the
 * newest import of any status decides who that is when none deployed.
 */
export async function sceneSourceFor(sceneId: string, caller: SourceCaller): Promise<SceneSource> {
  const without = (origin: SceneSource['origin']): SceneSource => ({ files: new Map(), leftovers: [], origin })
  const newest = (where: SQL | undefined) => db.select().from(sceneImports).where(where)
    .orderBy(desc(sql`COALESCE(${sceneImports.finishedAt}, ${sceneImports.createdAt})`), desc(sceneImports.createdAt), sceneImports.id)
    .limit(1)
  const [deployed] = await newest(and(eq(sceneImports.sceneId, sceneId), eq(sceneImports.status, 'deployed')))
  const row = deployed ?? (await newest(eq(sceneImports.sceneId, sceneId)))[0]
  if (!row) return without('none')
  if (row.userId !== caller.userId && !caller.fullAccess) return without('withheld')
  if (!deployed) return without('expired')

  const store = getImportStore()
  if (row.originalKey) {
    const original = await store.get(row.originalKey)
    const files = original && readable(original.body)
    if (files) return { files, leftovers: virviImporters(files), origin: 'original' }
  }
  const source = await store.get(row.sourceKey)
  const files = source && readable(source.body)
  if (!files) return without('expired')
  const out = uninstallVirvi(files, { alreadyInstalled: row.virviAlreadyPresent })
  return { ...out, origin: 'uninstalled' }
}
