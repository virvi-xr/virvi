// The published package must type-check in a scene that has only @dcl/sdk installed: a scene's build runs tsc over
// node_modules/@virvixr/dcl/dist/index.d.ts, and none of Virvi's workspace packages are on npm. Bundles first, so it
// never checks a stale dist (the package's `build` script is a no-op).
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// npm passes its own settings to scripts as npm_config_* (under `npm publish --dry-run`, a dry run that makes the
// nested `npm pack` write nothing); the scene's npm gets none of them
const NPM_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)))

before(() => execFileSync('pnpm', ['run', 'bundle'], { cwd: PKG, stdio: 'pipe' }), { timeout: 180_000 })

/** Packs the package the way `npm publish` would and npm-installs it into a bare scene beside @dcl/sdk, as a scene's build does. */
function sceneWithPackedPackage() {
  const scene = fs.mkdtempSync(path.join(os.tmpdir(), 'virvi-dcl-consumer-'))
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', scene], { cwd: PKG, encoding: 'utf8', env: NPM_ENV }).trim().split('\n').pop()
  const sdk = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).devDependencies['@dcl/sdk']
  fs.writeFileSync(path.join(scene, 'package.json'), JSON.stringify({ name: 'bare-scene', private: true }))
  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', `@dcl/sdk@${sdk}`, `./${tarball}`], { cwd: scene, stdio: 'pipe', env: NPM_ENV })
  return scene
}

test('dist/index.d.ts only imports packages a scene has', () => {
  const dts = fs.readFileSync(path.join(PKG, 'dist/index.d.ts'), 'utf8')
  // Statements only (a line starting with import/export), not usage examples inside doc comments
  const specifiers = [...dts.matchAll(/^(?:import|export)\b[^\n]*?from\s*['"]([^'"]+)['"]/gm), ...dts.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const stray = specifiers.filter((s) => !s.startsWith('@dcl/') && !s.startsWith('~system/') && !s.startsWith('.'))
  assert.deepEqual(stray, [])
})

test('a Decentraland scene with only @dcl/sdk type-checks against the packed package', { timeout: 180_000 }, () => {
  const scene = sceneWithPackedPackage()
  fs.mkdirSync(path.join(scene, 'src'))
  fs.writeFileSync(path.join(scene, 'src/index.ts'), [
    "import { createVirvi, type Virvi, type VirviInitConfig } from '@virvixr/dcl'",
    'export function main() {',
    '  const config: VirviInitConfig | undefined = undefined',
    '  const virvi: Promise<Virvi> = createVirvi(config)',
    '  void virvi',
    '}',
  ].join('\n'))
  fs.writeFileSync(path.join(scene, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true },
    include: ['src/**/*.ts'],
    extends: '@dcl/sdk/types/tsconfig.ecs7.json',
  }))
  try {
    execFileSync('node', [path.join(scene, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: scene, encoding: 'utf8', stdio: 'pipe' })
  } catch (err) {
    assert.fail(`tsc failed in a bare scene:\n${err.stdout}${err.stderr}`)
  } finally {
    fs.rmSync(scene, { recursive: true, force: true })
  }
})
