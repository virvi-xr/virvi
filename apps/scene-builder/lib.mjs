// The scene-builder's pure parts: what a deploy ships, the log tail Virvi gets, and a zip extract that writes nothing
// outside the scene root. build.mjs does the I/O around them.
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import ignore from 'ignore'

export const LOG_LIMIT = 64 * 1024

// The SDK's own deploy ignores: `defaultDclIgnore` plus the extras `getDCLIgnorePatterns` always adds, in
// @dcl/sdk-commands 7.31.0 dist/logic/dcl-ignore.js. Then the brief's: `src` (bundled into the main file, never loaded
// at runtime) and every README.
const SDK_IGNORES = [
  '.*', 'package.json', 'package-lock.json', 'yarn-lock.json', 'build.json', 'export', 'tsconfig.json', 'tslint.json',
  'node_modules', 'dclcontext', '**/*.ts', '**/*.tsx', 'Dockerfile', 'thumbnails', 'dist', 'README.md', '*.blend',
  '*.fbx', '*.zip', '*.rar', '*.map', 'node_modules/**', '*.md',
]
const DEFAULT_IGNORES = [...SDK_IGNORES, 'src', 'README*']

/** A zip entry or scene path as a clean relative path (`a/b.glb`), or null when it is absolute, climbs out, or is odd. */
export function safeEntryPath(name) {
  if (typeof name !== 'string' || name === '' || name.includes('\0') || name.includes('\\')) return null
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null
  const parts = name.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  return parts.join('/')
}

/**
 * A regular file at `root/rel` reached through real directories only, no symlink anywhere on the way: the build
 * could have pointed one anywhere the uploader can read (its own /proc/self/environ holds the token).
 */
function isRegularFile(root, rel) {
  const parts = rel.split('/')
  try {
    for (let i = 1; i < parts.length; i++) {
      if (!lstatSync(join(root, ...parts.slice(0, i))).isDirectory()) return false
    }
    return lstatSync(join(root, rel)).isFile()
  } catch {
    return false
  }
}

/**
 * Every file under `root` a deploy ships, as sorted relative paths: the SDK's default ignores and the scene's
 * `.dclignore` (gitignore syntax) applied, symlinks and other non-regular files skipped and never followed, dot
 * entries and `node_modules` not walked. `scene.json` and its `main` file always stay; either missing throws.
 */
export function deployableFiles(root, dclignore) {
  if (!isRegularFile(root, 'scene.json')) throw new Error('scene.json is missing (or not a regular file) after the build')
  let main
  try {
    main = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8')).main
  } catch {
    throw new Error('scene.json is not valid JSON')
  }
  const mainPath = safeEntryPath(main)
  if (!mainPath) throw new Error(`scene.json's main (${JSON.stringify(main)}) is not a relative path inside the scene`)
  if (!isRegularFile(root, mainPath)) throw new Error(`The build did not produce ${mainPath} (scene.json's main)`)

  // The user's patterns first, the defaults after: a `!pattern` can't bring back what the SDK always drops
  const ig = ignore().add(dclignore ? dclignore.split('\n') : []).add(DEFAULT_IGNORES)
  const found = []
  const walk = (rel) => {
    for (const entry of readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) found.push(path)
    }
  }
  walk('')

  const files = new Set(ig.filter(found))
  files.add('scene.json')
  files.add(mainPath)
  const sorted = [...files].sort()
  // The SDK refuses a deploy whose paths collide once lowercased; so does this
  const seen = new Set()
  for (const f of sorted) {
    const lower = f.toLowerCase()
    if (seen.has(lower)) throw new Error(`Two files differ only by case: ${f}`)
    seen.add(lower)
  }
  return sorted
}

function redact(text, token) {
  let out = token ? text.split(token).join('[redacted]') : text
  out = out.replace(/(:_(?:authToken|auth|password)\s*=\s*)\S+/g, '$1[redacted]')
  out = out.replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1[redacted]')
  return out
}

/**
 * The last `limit` bytes of `log` with the token and npm/HTTP credentials redacted. Redacts before cutting, from a
 * window wider than the limit, so a token straddling the cut can't leave a fragment; never starts mid-character.
 */
export function logTail(log, token, limit = LOG_LIMIT) {
  const margin = 8192 + (token ? token.length : 0)
  const start = Math.max(0, log.length - limit - margin)
  let text = log.subarray(start).toString('utf8')
  // A window that starts inside the token: drop the fragment
  if (start > 0 && token) {
    for (let k = token.length - 1; k > 0; k--) {
      if (text.startsWith(token.slice(-k))) {
        text = text.slice(k)
        break
      }
    }
  }
  let out = Buffer.from(redact(text, token), 'utf8')
  if (out.length > limit) out = out.subarray(out.length - limit)
  let skip = 0
  while (skip < out.length && (out[skip] & 0xc0) === 0x80) skip++
  return out.subarray(skip)
}

/**
 * Extracts a zip into `root` with fflate (never `unzip`/`tar`, which honour links). Every entry name is checked
 * before anything is written; a bad one throws naming it. Files are created exclusively, so nothing is overwritten
 * through an existing path.
 */
export function extractZip(data, root) {
  const entries = unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data))
  const base = resolve(root)
  const plan = []
  for (const [name, body] of Object.entries(entries)) {
    const isDir = name.endsWith('/')
    const rel = safeEntryPath(isDir ? name.slice(0, -1) : name)
    const target = rel && resolve(base, rel)
    if (!rel || !target.startsWith(base + sep)) throw new Error(`Refusing zip entry ${JSON.stringify(name)}`)
    plan.push({ rel, target, isDir, body })
  }
  for (const { target, isDir, body, rel } of plan) {
    if (isDir) {
      mkdirSync(target, { recursive: true })
      continue
    }
    const slash = rel.lastIndexOf('/')
    if (slash > 0) mkdirSync(join(base, rel.slice(0, slash)), { recursive: true })
    writeFileSync(target, body, { flag: 'wx', mode: 0o644 })
  }
}
