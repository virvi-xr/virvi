#!/usr/bin/env node
// The website's release manifest (LIV-165): the SHA-256 of every file in a static export, so anyone can compare what
// virvi.io serves with a build of the same commit. Prints JSON: { files: { "<path>": "<sha256 hex>" } }, sorted.
//   node scripts/release-manifest.mjs apps/web/out > apps/web/out/release-manifest.json
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export const MANIFEST_NAME = 'release-manifest.json'

/** Every file under `root` (but the manifest itself), as posix paths relative to it. */
export function listFiles(root, dir = root) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return listFiles(root, p)
    const rel = relative(root, p).split(sep).join('/')
    return rel === MANIFEST_NAME ? [] : [rel]
  })
}

export function buildManifest(root) {
  const files = {}
  for (const rel of listFiles(root).sort()) files[rel] = createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')
  return { files }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2]
  if (!root) { console.error('usage: release-manifest.mjs <export dir>'); process.exit(2) }
  process.stdout.write(JSON.stringify(buildManifest(root), null, 1) + '\n')
}
