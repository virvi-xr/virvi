/**
 * Assembles the downloadable backup: a Decentraland SDK7 project that runs without Virvi.
 *
 * An imported scene keeps the creator's own files (sceneSourceFor) and gains `src/virvi-baked.ts` plus one
 * `bakeVirviContent()` call first in `main()`; a Creator Hub project's composite is left as it is, so it still opens
 * in Creator Hub. A scene Virvi built gets a fresh project from dcl-runtime/'s package.json, tsconfig.json and
 * scene.json, placed where its destination is. Both get the bundled files and a README saying what was and wasn't
 * carried over (Scene Import Plan 3, rulings R1–R5).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { DCL_MAX_FILE_BYTES } from '@virvixr/shared'
import { db } from '../../db/connection.js'
import { assetLibraryItems, dclWorldDestinations, mediaAssets } from '../../db/schema.js'
import { IMAGE_MAX_BYTES, MODEL_MAX_BYTES, VIDEO_MAX_BYTES } from '../../storage/upload-policy.js'
import { ModelRefused, assertVirviHosted, virviFileFetcher, wizardSceneJson, type ModelFetcher } from '../dcl/assemble.js'
import { defaultSpawn } from '../dcl/world-deployer.js'
import { MAIN_FILES, PACKAGE, importStatements, mainBodyBrace, maskSource, skipBrackets, withFirstStatement, withImportLine } from '../import/install-virvi.js'
import { sceneSourceFor } from '../import/uninstall-virvi.js'
import { bakeModule } from './bake-code.js'
import { backupSnapshot, type AssetPlan, type AssetUse, type BackupSnapshot, type BakedItem } from './snapshot.js'

export class BackupError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code)
    this.name = 'BackupError'
  }
}

const MB = 1024 * 1024
/** R5: the largest backup Virvi hands out. */
export const BACKUP_MAX_BYTES = 500 * MB

/** Per-file caps: the upload limits, and never over Decentraland's own file limit. */
const CAP: Record<AssetUse, { bytes: number; what: string }> = {
  model: { bytes: Math.min(MODEL_MAX_BYTES, DCL_MAX_FILE_BYTES), what: 'Model' },
  texture: { bytes: Math.min(IMAGE_MAX_BYTES, DCL_MAX_FILE_BYTES), what: 'Image' },
  video: { bytes: Math.min(VIDEO_MAX_BYTES, DCL_MAX_FILE_BYTES), what: 'Video' },
  audio: { bytes: DCL_MAX_FILE_BYTES, what: 'Sound' },
}

const TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../dcl-runtime')
const BAKED_FILE = 'src/virvi-baked.ts'
const BAKE_IMPORT = "import { bakeVirviContent } from './virvi-baked'"
const BAKE_CALL = 'bakeVirviContent()'

const dec = new TextDecoder()
const enc = new TextEncoder()
const json = (v: unknown) => enc.encode(JSON.stringify(v, null, 2) + '\n')
/** One line of Markdown text from a stored name or URL. */
const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The main source with `bakeVirviContent()` first in `main()` (and the import if missing); the source unchanged when
 *  main() already calls it; null when there is no exported main() (same locator as installVirvi). */
function withBakeCall(src: string): string | null {
  const m = maskSource(src)
  const open = mainBodyBrace(m)
  if (open < 0) return null
  const close = skipBrackets(m, open)
  if (/(?<![\w$.])bakeVirviContent\s*\(/.test(m.slice(open, close < 0 ? m.length : close))) return src
  const edited = withFirstStatement(src, open, BAKE_CALL)
  const imported = importStatements(src, m).some((st) => !st.typeOnly && st.specifier === './virvi-baked' && /\bbakeVirviContent\b/.test(st.clause))
  return imported ? edited : withImportLine(edited, BAKE_IMPORT)
}

/** scene.json without a `virvi` block; any other scene.json byte for byte. */
function withoutVirviBlock(bytes: Uint8Array): Uint8Array {
  try {
    const j = JSON.parse(dec.decode(bytes))
    if (j && typeof j === 'object' && !Array.isArray(j) && 'virvi' in j) {
      delete j.virvi
      return json(j)
    }
  } catch { /* the creator's own file, left as it is */ }
  return bytes
}

/** The snapshot with every bundled or referenced path moved off the creator's own files (`-2`, `-3`, … as needed). */
function avoiding(snap: BackupSnapshot, taken: Set<string>): BackupSnapshot {
  const planned = new Set<string>()
  for (const it of snap.items) for (const p of Object.values(it.assets)) if (p.kind !== 'link') planned.add(p.path.toLowerCase())
  const moved = new Map<string, string>()
  const move = (path: string): string => {
    const have = moved.get(path)
    if (have) return have
    let out = path
    if (taken.has(path.toLowerCase())) {
      const slash = path.lastIndexOf('/')
      const dot = path.lastIndexOf('.')
      const [stem, ext] = dot > slash ? [path.slice(0, dot), path.slice(dot)] : [path, '']
      let n = 1
      do out = `${stem}-${++n}${ext}`
      while (taken.has(out.toLowerCase()) || planned.has(out.toLowerCase()))
      planned.add(out.toLowerCase())
    }
    moved.set(path, out)
    return out
  }
  const items = snap.items.map((it): BakedItem => ({
    ...it,
    assets: Object.fromEntries(Object.entries(it.assets).map(([k, p]) => [k, p.kind === 'link' ? p : { ...p, path: move(p.path) }])),
  }))
  return { ...snap, items }
}

/** The scene's Decentraland destination: the most recently deployed one, else the newest. */
async function destinationOf(sceneId: string) {
  const [dest] = await db.select().from(dclWorldDestinations)
    .where(eq(dclWorldDestinations.sceneId, sceneId))
    .orderBy(desc(sql`${dclWorldDestinations.lastEntityId} IS NOT NULL`), desc(dclWorldDestinations.updatedAt), desc(dclWorldDestinations.createdAt))
    .limit(1)
  return dest ?? null
}

function npmName(title: string): string {
  const name = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
  return name || 'decentraland-scene'
}

/** dcl-runtime/'s project files for a scene Virvi built, without Virvi in them, placed at the destination. */
function templateFiles(title: string, dest: NonNullable<Awaited<ReturnType<typeof destinationOf>>>): Map<string, Uint8Array> {
  const read = (p: string) => readFileSync(resolve(TEMPLATE_DIR, p))
  const pkg = JSON.parse(read('package.json').toString('utf8')) as Record<string, unknown>
  const deps = { ...(pkg.dependencies as Record<string, string> | undefined) }
  delete deps[PACKAGE]
  delete pkg.dependencies
  const project = {
    ...pkg,
    name: npmName(title),
    description: `${title}, for Decentraland`,
    scripts: { ...(pkg.scripts as Record<string, string> | undefined), start: 'sdk-commands start', deploy: 'sdk-commands deploy' },
    ...(Object.keys(deps).length ? { dependencies: deps } : {}),
  }

  const { virvi: _tplVirvi, ...template } = JSON.parse(read('scene.json').toString('utf8')) as Record<string, unknown>
  const { virvi: _virvi, ...wizard } = wizardSceneJson({
    title, world: dest.worldName ?? '', base: dest.base, parcels: dest.parcels, spawn: dest.spawn ?? defaultSpawn(dest.parcels),
  })
  const scene: Record<string, unknown> = { ...template, ...wizard }
  if (dest.kind === 'parcels') delete scene.worldConfiguration

  return new Map([
    ['package.json', json(project)],
    ['tsconfig.json', new Uint8Array(read('tsconfig.json'))],
    ['scene.json', json(scene)],
    ['src/index.ts', enc.encode(`${BAKE_IMPORT}\n\nexport function main() {\n  ${BAKE_CALL}\n}\n`)],
  ])
}

/** A file size for people: whole KB under 1 MB, else MB to one decimal. */
export const sizeLabel = (n: number) => (n < MB ? `${Math.max(1, Math.ceil(n / 1024))} KB` : `${(n / MB).toFixed(1)} MB`)

type Sized = [path: string, bytes: number]
const sizesOf = (files: Map<string, Uint8Array>): Sized[] => [...files].map(([p, b]) => [p, b.byteLength])

/** R5: throws 413 backup_too_big, naming the largest files, when the files add up to more than 500 MB. */
function assertSize(sizes: Sized[]) {
  const total = sizes.reduce((n, [, b]) => n + b, 0)
  if (total <= BACKUP_MAX_BYTES) return
  const largest = [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, b]) => `${p} (${sizeLabel(b)})`)
  throw new BackupError(413, 'backup_too_big', `This backup would be over the 500 MB limit. The largest files: ${largest.join(', ')}. Remove or shrink some of them in Virvi and try again.`)
}

/** Each bundled file once, by path. */
function bundled(snap: BackupSnapshot): Map<string, Extract<AssetPlan, { kind: 'bundle' }>> {
  const byPath = new Map<string, Extract<AssetPlan, { kind: 'bundle' }>>()
  for (const it of snap.items) for (const p of Object.values(it.assets)) if (p.kind === 'bundle' && !byPath.has(p.path)) byPath.set(p.path, p)
  return byPath
}

/** The sizes Virvi already holds for these URLs (uploads, and library items with a recorded size). */
async function knownSizes(urls: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  if (urls.length === 0) return sizes
  const media = await db.select({ url: mediaAssets.publicUrl, bytes: mediaAssets.sizeBytes }).from(mediaAssets).where(inArray(mediaAssets.publicUrl, urls))
  const lib = await db.select({ url: assetLibraryItems.cdnUrl, bytes: assetLibraryItems.fileSizeBytes }).from(assetLibraryItems).where(inArray(assetLibraryItems.cdnUrl, urls))
  for (const r of [...media, ...lib]) if (r.url && r.bytes > 0) sizes.set(r.url, Math.max(sizes.get(r.url) ?? 0, r.bytes))
  return sizes
}

interface Fetched { path: string; url: string; reason?: string }

/** Fetches every bundled file once (host check and per-type cap); failures are reported, never fatal. */
async function fetchBundled(snap: BackupSnapshot, files: Map<string, Uint8Array>, fetch?: ModelFetcher): Promise<Fetched[]> {
  const out: Fetched[] = []
  let total = sizesOf(files).reduce((n, [, b]) => n + b, 0)
  for (const p of bundled(snap).values()) {
    const cap = CAP[p.use]
    try {
      assertVirviHosted(p.url, cap.what)
      const bytes = await (fetch ?? virviFileFetcher(cap.bytes, cap.what))(p.url)
      if (bytes.byteLength > cap.bytes) throw new ModelRefused(`${cap.what} is over the ${Math.round(cap.bytes / MB)} MB file limit`)
      // Refused before the file joins the backup; nothing after it is fetched
      if (total + bytes.byteLength > BACKUP_MAX_BYTES) assertSize([...sizesOf(files), [p.path, bytes.byteLength]])
      files.set(p.path, bytes)
      total += bytes.byteLength
      out.push({ path: p.path, url: p.url })
    } catch (e) {
      if (e instanceof BackupError) throw e
      if (!(e instanceof ModelRefused)) console.error('[backup] file fetch failed:', p.url, (e as Error)?.message ?? e)
      out.push({ path: p.path, url: p.url, reason: e instanceof ModelRefused ? e.reason : 'Virvi could not download it' })
    }
  }
  return out
}

const LABEL: Record<BakedItem['type'], [string, string]> = {
  model: ['model', 'models'], image: ['image', 'images'], video: ['video screen', 'video screens'], sound: ['sound', 'sounds'], ad_space: ['ad space', 'ad spaces'],
}

const isVirviUrl = (url: string) => { try { assertVirviHosted(url); return true } catch { return false } }
/** A screen that bakes as its live stream (bake-code's rule). */
const bakedLive = (it: BakedItem) => it.type === 'video' && !!it.props.isLive && !!it.props.enableLiveStream && !!it.assets.liveSrc
const unique = (xs: string[]) => [...new Set(xs)]

function readme(o: {
  snap: BackupSnapshot
  origin: 'original' | 'uninstalled' | 'none'
  leftovers: string[]
  problems: string[]
  references: number
}): string {
  const { snap } = o
  const out: string[] = [`# ${clean(snap.sceneName)}: your scene without Virvi`, '']
  out.push('This folder is a Decentraland SDK7 project that runs on its own: nothing in it connects to Virvi.', '')
  if (o.origin === 'none') {
    out.push('Virvi built this scene, so this is a fresh SDK7 project: `main()` in `src/index.ts` calls `bakeVirviContent()` from `src/virvi-baked.ts`, which places everything.', '')
  } else {
    const how = o.origin === 'original' ? 'as you uploaded it to Virvi' : 'as Virvi last deployed it, with Virvi taken back out'
    out.push(`It holds your own scene, ${how}, plus what was placed with Virvi, written as plain SDK7 code in \`src/virvi-baked.ts\`. \`main()\` calls \`bakeVirviContent()\` first; the rest of your code is unchanged.`, '')
  }

  out.push('## Deploy it', '')
  out.push('1. Install Node.js (version 18 or later).')
  out.push('2. In this folder, run `npm install`.')
  out.push('3. Preview it with `npx @dcl/sdk-commands start`.')
  out.push('4. Deploy it with `npx @dcl/sdk-commands deploy`. For a World, add `--target-content https://worlds-content-server.decentraland.org`.')
  out.push('', 'Or open this folder in Creator Hub and publish it from there.', '')

  out.push('## What was baked', '')
  if (snap.items.length === 0) {
    out.push(`Nothing placed: the live preset "${clean(snap.presetName)}" had nothing in it, so \`bakeVirviContent()\` adds nothing.`, '')
  } else {
    out.push(`Everything placed in the live preset "${clean(snap.presetName)}":`, '')
    for (const type of Object.keys(LABEL) as BakedItem['type'][]) {
      const n = snap.items.filter((i) => i.type === type).length
      if (n) out.push(`- ${n} ${LABEL[type][n === 1 ? 0 : 1]}`)
    }
    out.push('')
    const has = (t: BakedItem['type']) => snap.items.some((i) => i.type === t)
    if (has('ad_space')) out.push('- **Ad spaces** are empty slots: the space\'s own fallback image if it has one, else a plain dark panel. No advertiser\'s creative is included.')
    if (has('video')) out.push('- **Video screens** play their playlist in order, without ads. A screen set to show ads shows its off image, or nothing.')
    if (has('sound')) out.push('- **Sound clips** are placed but only play when your code plays them; looping sounds play from the start.')
    out.push('')
  }

  const sections: Array<[string, string, string[]]> = []
  sections.push(['Click events', 'These items have click events in Virvi, which aren\'t in the backup. Add your own pointer events in `src/virvi-baked.ts` if you want them:', snap.withClickEvents.map(clean)])
  sections.push(['Other presets', `Only the live preset "${clean(snap.presetName)}" is in the backup. These presets aren't:`, snap.otherPresets.map(clean)])
  const live = snap.items.filter(bakedLive)
  sections.push(['Live streams', 'These screens were live when you downloaded the backup, so they play the stream straight from its address. When the stream ends or moves, the screen goes dark:', unique(live.map((i) => `${clean(i.name)}: ${clean((i.assets.liveSrc as { url: string }).url)}`))])
  const empty = snap.items.filter((i) => (i.type === 'sound' && !i.assets.audio) || (i.type === 'model' && !i.assets.model))
  sections.push(['Not shown', 'These items aren\'t in the backup:', unique([
    ...snap.skipped.map((s) => `${clean(s.name)} (${s.type}): ${s.why}`),
    ...empty.map((i) => `${clean(i.name)} (${i.type}): ${i.type === 'sound' ? 'no sound file chosen' : 'no model file chosen'}`),
  ])])
  const links = unique(snap.items.flatMap((i) => Object.entries(i.assets)
    .filter(([k, p]) => p.kind === 'link' && k !== 'liveSrc')
    .map(([, p]) => `${clean(i.name)}: ${clean(p.url)}${isVirviUrl(p.url) ? ' (on Virvi\'s servers)' : ''}`)))
  sections.push(['Files loaded from the web', 'These files aren\'t in the backup; the scene loads them from their address. A file on Virvi\'s servers that didn\'t exactly match one of your uploads or the Virvi library is linked rather than bundled, and stops loading if it is removed from Virvi: to keep a copy, download it into this folder and change its address in `src/virvi-baked.ts`.', links])
  sections.push(['Files you need to add', 'Some files have a licence that doesn\'t let Virvi hand them out:', o.references ? [`\`MISSING-ASSETS.md\` lists where to get each of the ${o.references} and where to save it.`] : []])
  sections.push(['Problems', 'These didn\'t go as planned. The scene still points at each missing file\'s path, so you can add the file there yourself:', o.problems])
  sections.push(['Your own Virvi code', `These files of yours still import ${PACKAGE}, which this project doesn't install. Remove that code, or add the package back, before you build:`, o.leftovers])

  for (const [title, intro, lines] of sections) {
    if (!lines.length) continue
    out.push(`## ${title}`, '', intro, '', ...lines.map((l) => `- ${l}`), '')
  }
  return out.join('\n')
}

function attribution(snap: BackupSnapshot, fetched: Set<string>): string | null {
  const packs = new Map<string, { text: string; paths: Set<string> }>()
  for (const it of snap.items) {
    for (const p of Object.values(it.assets)) {
      if (p.kind !== 'bundle' || !p.attribution || !fetched.has(p.path)) continue
      const pack = packs.get(p.attribution.pack) ?? { text: p.attribution.text, paths: new Set<string>() }
      pack.paths.add(p.path)
      packs.set(p.attribution.pack, pack)
    }
  }
  if (packs.size === 0) return null
  const out = ['# Attribution', '', 'Some files in this scene come from MIT-licensed packs. Keep this notice with them.', '']
  for (const [name, pack] of packs) {
    out.push(`## ${clean(name)}`, '', pack.text.trim(), '', 'Files:', ...[...pack.paths].map((p) => `- \`${p}\``), '')
  }
  return out.join('\n')
}

function missingAssets(snap: BackupSnapshot): { text: string; count: number } | null {
  const byPath = new Map<string, { plan: Extract<AssetPlan, { kind: 'reference' }>; names: Set<string> }>()
  for (const it of snap.items) {
    for (const p of Object.values(it.assets)) {
      if (p.kind !== 'reference') continue
      const entry = byPath.get(p.path) ?? { plan: p, names: new Set<string>() }
      entry.names.add(clean(it.name))
      byPath.set(p.path, entry)
    }
  }
  if (byPath.size === 0) return null
  const out = [
    '# Files to add', '',
    'The scene uses these files, but their licence doesn\'t let Virvi hand them out. Download each one from its source and save it at the path shown; until then that item is missing in-world.', '',
  ]
  for (const [path, { plan, names }] of byPath) {
    out.push(`- \`${path}\` (${[...names].join(', ')}), from "${clean(plan.pack)}", licence ${plan.license}. Source: ${clean(plan.sourceUrl)}`)
  }
  out.push('')
  return { text: out.join('\n'), count: byPath.size }
}

/**
 * The backup project's files, and what went wrong putting it together (files that couldn't be fetched, a main()
 * that couldn't be found). Throws BackupError 422 `not_decentraland` for a scene with no import and no Decentraland
 * destination, and 413 `backup_too_big` over 500 MB.
 */
export async function backupProject(sceneId: string, opts: { fetch?: ModelFetcher } = {}): Promise<{ files: Map<string, Uint8Array>; problems: string[] }> {
  const source = await sceneSourceFor(sceneId)
  const problems: string[] = []
  const files = new Map<string, Uint8Array>()
  let snap = await backupSnapshot(sceneId)

  if (source.origin !== 'none') {
    for (const [p, b] of source.files) files.set(p, b)
    const sj = files.get('scene.json')
    if (sj) files.set('scene.json', withoutVirviBlock(sj))
    const mainPath = MAIN_FILES.find((p) => files.has(p))
    const edited = mainPath ? withBakeCall(dec.decode(files.get(mainPath)!)) : null
    if (mainPath && edited !== null) files.set(mainPath, enc.encode(edited))
    else problems.push(`${mainPath ?? 'src/index.ts'} has no exported main() to call bakeVirviContent() from: add \`${BAKE_IMPORT}\` and call \`${BAKE_CALL}\` when your scene starts.`)
    snap = avoiding(snap, new Set([...files.keys()].map((p) => p.toLowerCase())))
  } else {
    const dest = await destinationOf(sceneId)
    if (!dest) throw new BackupError(422, 'not_decentraland', 'This scene has no Decentraland World or parcels to back up.')
    if (dest.kind !== 'parcels' && !dest.worldName) throw new BackupError(422, 'not_decentraland', 'This scene\'s Decentraland World has no name to back up to.')
    for (const [p, b] of templateFiles(snap.sceneName, dest)) files.set(p, b)
  }
  files.set(BAKED_FILE, enc.encode(bakeModule(snap)))
  // Refused up front, before any download, when the sizes Virvi already knows are over the limit
  const plans = bundled(snap)
  const known = await knownSizes([...new Set([...plans.values()].map((p) => p.url))])
  assertSize([...sizesOf(files), ...[...plans].flatMap(([path, p]): Sized[] => (known.has(p.url) ? [[path, known.get(p.url)!]] : []))])

  const fetched = await fetchBundled(snap, files, opts.fetch)
  for (const f of fetched) if (f.reason) problems.push(`${f.path} (from ${f.url}) is missing: ${f.reason}`)

  // A note the creator already has keeps its text, under the backup's
  const note = (path: string, text: string) => {
    const theirPath = [...source.files.keys()].find((k) => k.toLowerCase() === path.toLowerCase())
    const theirs = theirPath === undefined ? undefined : source.files.get(theirPath)
    if (theirPath !== undefined) files.delete(theirPath)
    files.set(path, enc.encode(theirs ? `${text}\n---\n\n${dec.decode(theirs)}` : text))
  }
  const attr = attribution(snap, new Set(fetched.filter((f) => !f.reason).map((f) => f.path)))
  if (attr) note('ATTRIBUTION.md', attr)
  const missing = missingAssets(snap)
  if (missing) note('MISSING-ASSETS.md', missing.text)
  note('README.md', readme({ snap, origin: source.origin, leftovers: source.leftovers, problems, references: missing?.count ?? 0 }))
  assertSize(sizesOf(files))
  return { files, problems }
}
