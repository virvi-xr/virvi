// The scene-builder's three steps, each run by entrypoint.sh as its own user:
//   node build.mjs fetch          as `runner`, with the token: download the source zip, extract it into /work/scene
//   node build.mjs build          as `builder`, no token, no Virvi access: npm install, then the scene's build
//   node build.mjs upload ok|failed   as `runner`, with the token, after every builder process is gone: zip the
//                                 deployable files and POST the result, or POST the failure with the log tail
//   node build.mjs                all three in one process, in the current directory: the server's dev-only `local`
//                                 runner. No users, no firewall: nothing is isolated, so never for real imports.
// The token only ever travels in the environment and the Authorization header; nothing here prints it.
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { deployableFiles, extractZip, logTail } from './lib.mjs'

const [step, arg] = process.argv.slice(2)
const LOCAL = step === undefined
const SCENE = LOCAL ? join(process.cwd(), 'scene') : '/work/scene'
const LOG = LOCAL ? join(process.cwd(), 'build.log') : '/work/log/build.log'
// In the box entrypoint.sh points our stdout at the log; locally we write it ourselves
const OUT = LOCAL ? openSync(LOG, 'a') : 1
const INSTALL_LIMIT_MS = 5 * 60_000
const BUILD_LIMIT_MS = 10 * 60_000
const HTTP_LIMIT_MS = 5 * 60_000

const say = (line) => {
  writeSync(OUT, `[scene-builder] ${line}\n`)
  if (LOCAL) process.stdout.write(`[scene-builder] ${line}\n`)
}

function env(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

// ── fetch ──────────────────────────────────────────────────────────────────────────────────────────────────────────

async function fetchSource() {
  const res = await fetch(env('BUILD_SOURCE_URL'), {
    headers: { Authorization: `Bearer ${env('BUILD_TOKEN')}` },
    signal: AbortSignal.timeout(HTTP_LIMIT_MS),
  })
  if (!res.ok) throw new Error(`Downloading the source failed: HTTP ${res.status}`)
  const zip = new Uint8Array(await res.arrayBuffer())
  say(`Downloaded the source (${zip.length} bytes)`)
  if (LOCAL) mkdirSync(SCENE)
  extractZip(zip, SCENE)
  say('Extracted the source')
}

// ── build ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Runs a command in its own process group, output straight to ours (the log); past `limitMs` the whole group dies. */
function run(command, args, limitMs, label) {
  say(`> ${[command, ...args].join(' ')}`)
  return new Promise((resolvePromise, reject) => {
    // The scene's code never sees the BUILD_* variables (in the box they are already gone)
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUILD_')))
    const child = spawn(command, args, { cwd: SCENE, env: childEnv, stdio: ['ignore', OUT, OUT], detached: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, limitMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${label} could not start: ${err.message}`))
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      // Whatever the step left running in its group goes with it
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
      if (timedOut) reject(new Error(`${label} took longer than ${limitMs / 60_000} minutes and was stopped`))
      else if (code !== 0) reject(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit code ${code}`})`))
      else resolvePromise()
    })
  })
}

async function buildScene() {
  if (!existsSync(join(SCENE, 'package.json'))) throw new Error('The scene has no package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(SCENE, 'package.json'), 'utf8'))
  } catch {
    throw new Error('The scene\'s package.json is not valid JSON')
  }
  await run('npm', ['install', '--no-audit', '--no-fund'], INSTALL_LIMIT_MS, 'npm install')
  // The SDK's CLI comes with @dcl/sdk; a scene without it builds with its own `build` script
  const hasSdkCommands = existsSync(join(SCENE, 'node_modules/.bin/sdk-commands'))
  if (hasSdkCommands) await run('npx', ['--no', 'sdk-commands', 'build', '--production'], BUILD_LIMIT_MS, 'The build')
  else if (typeof pkg.scripts?.build === 'string') await run('npm', ['run', 'build'], BUILD_LIMIT_MS, 'The build')
  else throw new Error('The scene has neither @dcl/sdk-commands nor a build script')
}

// ── upload ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function readLog() {
  try {
    return readFileSync(LOG)
  } catch {
    return Buffer.alloc(0)
  }
}

function readDclignore() {
  const path = join(SCENE, '.dclignore')
  try {
    if (!lstatSync(path).isFile()) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

async function post(url, contentType, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('BUILD_TOKEN')}`, 'Content-Type': contentType, ...extraHeaders },
    body,
    signal: AbortSignal.timeout(HTTP_LIMIT_MS),
  })
  await res.arrayBuffer().catch(() => {})
  return res
}

async function upload(outcome) {
  const token = env('BUILD_TOKEN')
  const notes = []
  // Locally say() already appends to the log file; in the box the log is closed by now, so notes ride along
  const note = (line) => {
    say(line)
    if (!LOCAL) notes.push(`[scene-builder] ${line}\n`)
  }
  const tail = () => logTail(Buffer.concat([readLog(), Buffer.from(notes.join(''))]), token)

  if (outcome === 'ok') {
    try {
      const files = deployableFiles(SCENE, readDclignore())
      const entries = {}
      for (const f of files) entries[f] = new Uint8Array(readFileSync(join(SCENE, f)))
      const zip = zipSync(entries, { level: 6 })
      note(`Packaged ${files.length} deployable files (${zip.length} bytes)`)
      const res = await post(env('BUILD_RESULT_URL'), 'application/zip', zip, {
        'X-Build-Log': tail().toString('base64'),
      })
      if (res.ok) {
        say('Result accepted')
        return 0
      }
      note(`Virvi did not accept the result: HTTP ${res.status}`)
    } catch (err) {
      note(`Packaging the build failed: ${err.message}`)
    }
  }

  const log = tail()
  process.stdout.write(log)
  try {
    const res = await post(env('BUILD_FAILED_URL'), 'text/plain', log)
    say(res.ok ? 'Failure reported' : `Reporting the failure failed: HTTP ${res.status}`)
  } catch (err) {
    say(`Reporting the failure failed: ${err.message}`)
  }
  return 1
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────────────────────

try {
  if (LOCAL) {
    let outcome = 'failed'
    try {
      await fetchSource()
      await buildScene()
      outcome = 'ok'
    } catch (err) {
      say(err.message)
    }
    process.exitCode = await upload(outcome)
  } else if (step === 'fetch') await fetchSource()
  else if (step === 'build') await buildScene()
  else if (step === 'upload') process.exitCode = await upload(arg)
  else throw new Error(`Unknown step ${step}`)
} catch (err) {
  say(err.message)
  process.exitCode = 1
}
