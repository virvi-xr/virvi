import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { zipSync, strToU8, Zip, ZipPassThrough } from 'fflate'
import { deployableFiles, logTail, safeEntryPath, extractZip, resultLogHeader, LOG_LIMIT, HEADER_LOG_LIMIT } from '../lib.mjs'

function scene(files) {
  const root = mkdtempSync(join(tmpdir(), 'scene-builder-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return root
}

const BASIC = {
  'scene.json': JSON.stringify({ main: 'bin/index.js' }),
  'bin/index.js': 'built',
  'models/tree.glb': 'glb',
  'images/sign.png': 'png',
  'src/index.ts': 'source',
  'src/helpers.js': 'helper',
  'node_modules/@dcl/sdk/index.js': 'sdk',
  'tsconfig.json': '{}',
  'package.json': '{}',
  'package-lock.json': '{}',
  'README.md': 'readme',
  'README.txt': 'readme',
  '.git/HEAD': 'ref',
  '.dclignore': '',
  'types/env.d.ts': 'types',
  'docs/notes.txt': 'docs',
  'art/tree.blend': 'blend',
}

test('deployableFiles drops the SDK default ignores', () => {
  const root = scene(BASIC)
  const files = deployableFiles(root, null)
  assert.deepEqual(files, ['bin/index.js', 'docs/notes.txt', 'images/sign.png', 'models/tree.glb', 'scene.json'])
})

test('deployableFiles applies .dclignore patterns on top of the defaults', () => {
  const root = scene({ ...BASIC, 'art/tree.png': 'png', 'docs/nested/a.png': 'png' })
  const files = deployableFiles(root, '# comment\n*.blend\ndocs/\n')
  assert.deepEqual(files, ['art/tree.png', 'bin/index.js', 'images/sign.png', 'models/tree.glb', 'scene.json'])
})

test('deployableFiles always keeps scene.json and the main file', () => {
  const root = scene(BASIC)
  const files = deployableFiles(root, 'scene.json\nbin/\n*.js\n')
  assert.ok(files.includes('scene.json'))
  assert.ok(files.includes('bin/index.js'))
  assert.ok(!files.includes('src/helpers.js'))
})

test('deployableFiles keeps a main file in a default-ignored place', () => {
  const root = scene({ 'scene.json': JSON.stringify({ main: 'dist/game.js' }), 'dist/game.js': 'built', 'dist/other.js': 'x' })
  assert.deepEqual(deployableFiles(root, null), ['dist/game.js', 'scene.json'])
})

test('deployableFiles skips symlinks and never follows them', () => {
  const root = scene(BASIC)
  symlinkSync('/etc/hosts', join(root, 'models/hosts.glb'))
  symlinkSync('/etc', join(root, 'linked-dir'))
  const files = deployableFiles(root, null)
  assert.ok(!files.includes('models/hosts.glb'))
  assert.ok(!files.some((f) => f.startsWith('linked-dir')))
})

test('deployableFiles refuses a symlinked scene.json or main file', () => {
  const root = scene({ 'scene.json': JSON.stringify({ main: 'bin/index.js' }) })
  mkdirSync(join(root, 'bin'))
  symlinkSync('/proc/self/environ', join(root, 'bin/index.js'))
  assert.throws(() => deployableFiles(root, null), /bin\/index\.js/)
})

test('deployableFiles refuses a main file reached through a symlinked directory', () => {
  const root = scene({ 'scene.json': JSON.stringify({ main: 'bin/hosts' }) })
  symlinkSync('/etc', join(root, 'bin'))
  assert.throws(() => deployableFiles(root, null), /bin\/hosts/)
})

test('deployableFiles refuses a missing or unsafe main file', () => {
  assert.throws(() => deployableFiles(scene({ 'scene.json': JSON.stringify({ main: 'bin/index.js' }) }), null), /bin\/index\.js/)
  assert.throws(() => deployableFiles(scene({ 'scene.json': JSON.stringify({ main: '../outside.js' }) }), null), /main/)
  assert.throws(() => deployableFiles(scene({ 'scene.json': 'not json' }), null), /scene\.json/)
  assert.throws(() => deployableFiles(scene({ 'bin/index.js': 'x' }), null), /scene\.json/)
})

test('deployableFiles lets a user pattern negate nothing the defaults drop', () => {
  const root = scene(BASIC)
  const files = deployableFiles(root, '!tsconfig.json\n!node_modules\n')
  assert.ok(!files.includes('tsconfig.json'))
  assert.ok(!files.some((f) => f.startsWith('node_modules')))
})

const TOKEN = 'tok_9f8e7d6c5b4a39281706'

test('logTail keeps the last 64 KB', () => {
  const log = Buffer.from('a'.repeat(100_000) + 'THE END')
  const tail = logTail(log, TOKEN)
  assert.equal(LOG_LIMIT, 64 * 1024)
  assert.equal(tail.length, LOG_LIMIT)
  assert.ok(tail.toString().endsWith('THE END'))
})

test('logTail keeps a short log whole', () => {
  assert.equal(logTail(Buffer.from('short log\n'), TOKEN).toString(), 'short log\n')
})

test('logTail redacts the token, including one cut by the tail boundary', () => {
  const tail = logTail(Buffer.from(`start ${TOKEN} middle ${TOKEN} end`), TOKEN).toString()
  assert.ok(!tail.includes(TOKEN))
  assert.match(tail, /start \[redacted\] middle \[redacted\] end/)

  // The token straddles the 64 KB cut: no piece of it may survive
  const straddle = Buffer.from('x'.repeat(200_000) + TOKEN + 'y'.repeat(LOG_LIMIT - 10))
  const cut = logTail(straddle, TOKEN).toString()
  assert.ok(!cut.includes(TOKEN.slice(-10)))
})

test('logTail drops a token fragment at the window start even when redaction shrinks the rest', () => {
  // Many tokens after the cut shrink the redacted text below the limit, pulling the window start into the tail
  const body = Buffer.from(`${TOKEN}\n`.repeat(1000))
  const margin = 8192 + TOKEN.length
  const filler = 'y'.repeat(LOG_LIMIT + margin - body.length - 11)
  const log = Buffer.concat([Buffer.from('x'.repeat(1000) + TOKEN), Buffer.from(filler), body])
  const tail = logTail(log, TOKEN).toString()
  assert.ok(!tail.includes(TOKEN.slice(-11)), 'fragment survived')
  assert.ok(tail.startsWith('y'))
})

test('logTail redacts npm auth lines', () => {
  const log = [
    '//registry.npmjs.org/:_authToken=npm_abcdef123456',
    'npm verb config //npm.pkg.github.com/:_authToken=ghp_secret',
    '//registry.example.com/:_auth=dXNlcjpwYXNz',
    '//registry.example.com/:_password=hunter2',
    'ok line',
  ].join('\n')
  const tail = logTail(Buffer.from(log), TOKEN).toString()
  for (const secret of ['npm_abcdef123456', 'ghp_secret', 'dXNlcjpwYXNz', 'hunter2']) assert.ok(!tail.includes(secret), secret)
  assert.match(tail, /_authToken=\[redacted\]/)
  assert.match(tail, /ok line/)
})

test('logTail does not start with a broken UTF-8 character', () => {
  const log = Buffer.from('é'.repeat(50_000))
  const tail = logTail(log, TOKEN)
  assert.ok(tail.length <= LOG_LIMIT)
  assert.ok(!tail.toString().includes('\uFFFD'))
})

test('safeEntryPath accepts ordinary relative paths', () => {
  assert.equal(safeEntryPath('scene.json'), 'scene.json')
  assert.equal(safeEntryPath('src/index.ts'), 'src/index.ts')
  assert.equal(safeEntryPath('models/a b/tree.glb'), 'models/a b/tree.glb')
})

test('safeEntryPath refuses traversal, absolute and odd paths', () => {
  for (const bad of ['../x', 'a/../../x', 'a/..', '/etc/passwd', '\\\\server\\share', 'C:/x', 'c:x', 'a\\..\\x', 'a/./b', 'a//b', '', 'a\0b', './a']) {
    assert.equal(safeEntryPath(bad), null, JSON.stringify(bad))
  }
})

test('extractZip writes files and directories inside the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'scene-extract-'))
  const zip = zipSync({ 'scene.json': strToU8('{}'), 'src/': new Uint8Array(0), 'src/index.ts': strToU8('code'), 'empty/': new Uint8Array(0) })
  extractZip(zip, root)
  assert.equal(readFileSync(join(root, 'scene.json'), 'utf8'), '{}')
  assert.equal(readFileSync(join(root, 'src/index.ts'), 'utf8'), 'code')
  assert.ok(existsSync(join(root, 'empty')))
})

test('extractZip refuses a traversal entry and writes nothing', () => {
  const parent = mkdtempSync(join(tmpdir(), 'scene-extract-'))
  const root = join(parent, 'scene')
  mkdirSync(root)
  const zip = zipSync({ 'scene.json': strToU8('{}'), '../escape.txt': strToU8('pwned') })
  assert.throws(() => extractZip(zip, root), /escape\.txt/)
  assert.ok(!existsSync(join(parent, 'escape.txt')))
  assert.ok(!existsSync(join(root, 'scene.json')))
  rmSync(parent, { recursive: true })
})

test('extractZip refuses an absolute entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'scene-extract-'))
  assert.throws(() => extractZip(zipSync({ '/tmp/abs.txt': strToU8('x') }), root), /abs\.txt/)
})

test('extractZip refuses a file that collides with a directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'scene-extract-'))
  assert.throws(() => extractZip(zipSync({ a: strToU8('file'), 'a/b': strToU8('x') }), root))
})

test('deployableFiles skips filesystem names that are not clean entry paths', () => {
  const root = scene({ ...BASIC, 'models/back\\slash.glb': 'x', 'models/new\nline.glb': 'x', 'models/tab\tname.glb': 'x' })
  const files = deployableFiles(root, null)
  assert.deepEqual(files, ['bin/index.js', 'docs/notes.txt', 'images/sign.png', 'models/tree.glb', 'scene.json'])
})

test('safeEntryPath refuses control characters', () => {
  for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\x7fb', 'a\x01b']) assert.equal(safeEntryPath(bad), null, JSON.stringify(bad))
})

test('extractZip refuses a zip with a duplicate entry name', () => {
  const chunks = []
  const zip = new Zip((err, chunk) => {
    if (err) throw err
    chunks.push(chunk)
  })
  for (const body of ['first', 'second']) {
    const f = new ZipPassThrough('scene.json')
    zip.add(f)
    f.push(strToU8(body), true)
  }
  zip.end()
  const data = new Uint8Array(Buffer.concat(chunks))
  const root = mkdtempSync(join(tmpdir(), 'scene-extract-'))
  assert.throws(() => extractZip(data, root), /scene\.json/)
  assert.ok(!existsSync(join(root, 'scene.json')))
})

test('resultLogHeader is the base64 of at most the last 8 KB, redacted', () => {
  assert.equal(HEADER_LOG_LIMIT, 8 * 1024)
  const log = Buffer.from('a'.repeat(100_000) + TOKEN + ' THE END')
  const header = resultLogHeader(log, TOKEN)
  const decoded = Buffer.from(header, 'base64')
  assert.ok(decoded.length <= HEADER_LOG_LIMIT)
  assert.ok(header.length <= Math.ceil(HEADER_LOG_LIMIT / 3) * 4)
  assert.ok(decoded.toString().endsWith('[redacted] THE END'))
  assert.ok(!decoded.toString().includes(TOKEN))
  assert.equal(Buffer.from(resultLogHeader(Buffer.from('short'), TOKEN), 'base64').toString(), 'short')
})
