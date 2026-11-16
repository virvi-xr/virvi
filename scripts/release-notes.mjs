#!/usr/bin/env node
// Posts a push's release notes to Discord (release.yml, after the image is built and signed). Each message names the
// release the way /transparency does (the commit's first 12 characters), with the push time, the commits as bullets
// grouped by kind, and links to the commit, the signed build and /transparency.
//
//   node scripts/release-notes.mjs --before <sha> --after <sha> [--result success|failure] [--dry-run]
//
// The webhook comes from DISCORD_RELEASE_WEBHOOK (a GitHub Actions secret); it is never printed. --dry-run prints the
// messages as JSON instead of sending them.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const REPO_URL = 'https://github.com/virvi-xr/virvi'
export const TRANSPARENCY_URL = 'https://virvi.io/transparency'
const MAX_COMMITS = 100
const MAX_LINE = 220
// Discord limits: 4096 characters per embed description, 6000 per message across its embeds
const EMBED_BUDGET = 3800
const MESSAGE_BUDGET = 5500

const SECTIONS = [
  { key: 'feat', title: '✨ New' },
  { key: 'fix', title: '🛠️ Fixes' },
  { key: 'perf', title: '⚡ Faster' },
  { key: 'security', title: '🔒 Security' },
  { key: 'docs', title: '📖 Docs' },
  { key: 'other', title: '🧰 Other changes' },
]
const KIND_OF = { feat: 'feat', fix: 'fix', perf: 'perf', security: 'security', sec: 'security', docs: 'docs' }

/** A commit subject's kind, area and text: `feat(beats): x (LIV-11)` → feat, Beats, `x (LIV-11)`. */
export function parseSubject(subject) {
  const m = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(subject.trim())
  if (!m) return { kind: 'other', area: null, text: subject.trim() }
  const area = m[2] ? m[2].split(/[,/]/).map((a) => a.trim()).filter(Boolean).map(label).join(', ') : null
  return { kind: KIND_OF[m[1].toLowerCase()] ?? 'other', area, text: m[3].trim() }
}

function label(area) {
  return area.split(/[-_]/).map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}

function clip(s, n) {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`
}

/** One bullet: `- **Beats:** text · [`abc1234`](url)`. Markdown links in the text are kept out of Discord's way. */
export function bullet(c) {
  const { area, text } = parseSubject(c.subject)
  const body = clip(text.replace(/\]\(/g, '] ('), MAX_LINE)
  return `- ${area ? `**${area}:** ` : ''}${body} · [\`${c.sha.slice(0, 7)}\`](${REPO_URL}/commit/${c.sha})`
}

/** `Monday, 16 November 2026 · 22:57 UTC` */
export function utcLine(date) {
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(date)
  return `${day} · ${time} UTC`
}

/**
 * The Discord messages for one push. `commits` newest first ({ sha, subject }), `more` how many were left out,
 * `at` the push time, `result` the build's result, `runUrl` its run. Returns webhook bodies, one per message.
 */
export function buildMessages({ commits, more = 0, after, at, result = 'success', runUrl = null, compareUrl = null }) {
  const release = after.slice(0, 12)
  const ok = result === 'success'
  const unix = Math.floor(at.getTime() / 1000)
  const head = [
    `## 📅 ${utcLine(at)}`,
    `-# <t:${unix}:F> your time · <t:${unix}:R>`,
    ok
      ? `Release \`${release}\` is built and signed. virvi.io runs it from its next deploy: [/transparency](${TRANSPARENCY_URL}) shows the commit that's live.`
      : `⚠️ Release \`${release}\` didn't build (**${result}**), so it can't be deployed.`,
  ].join('\n')

  const blocks = []
  const groups = new Map()
  for (const c of commits) {
    const { kind } = parseSubject(c.subject)
    if (!groups.has(kind)) groups.set(kind, [])
    groups.get(kind).push(c)
  }
  for (const s of SECTIONS) {
    const list = groups.get(s.key)
    if (!list) continue
    blocks.push({ title: `**${s.title}**`, lines: list.map(bullet) })
  }
  if (!commits.length) blocks.push({ title: '**Changes**', lines: ['- No new commits (a rebuild of an earlier release).'] })
  if (more > 0) blocks.push({ title: '', lines: [`-# …and ${more} more, in [the full comparison](${compareUrl ?? `${REPO_URL}/commits/${after}`}).`] })

  // Pack the sections into embed descriptions, splitting a long section across embeds
  const descriptions = [head]
  const add = (line) => {
    const cur = descriptions[descriptions.length - 1]
    if (cur.length + line.length + 1 > EMBED_BUDGET) descriptions.push(line)
    else descriptions[descriptions.length - 1] = cur ? `${cur}\n${line}` : line
  }
  for (const b of blocks) {
    add('')
    if (b.title) add(b.title)
    for (const l of b.lines) add(l)
  }

  const color = ok ? 0x22c55e : 0xef4444
  const links = [
    `[Commit](${REPO_URL}/commit/${after})`,
    compareUrl ? `[All changes](${compareUrl})` : null,
    runUrl ? `[Signed build](${runUrl})` : null,
    `[Check what's live](${TRANSPARENCY_URL})`,
  ].filter(Boolean).join(' · ')
  const embeds = descriptions.map((d, i) => ({ color, description: d.trim(), ...(i === 0 ? { title: `Virvi release ${release}`, url: `${REPO_URL}/commit/${after}` } : {}) }))
  const last = embeds[embeds.length - 1]
  last.fields = [{ name: 'Links', value: links }]
  last.footer = { text: `virvi-xr/virvi · main · ${commits.length + more} commit${commits.length + more === 1 ? '' : 's'}` }
  last.timestamp = at.toISOString()

  // Up to 10 embeds and MESSAGE_BUDGET characters per message
  const messages = []
  let cur = []
  let size = 0
  for (const e of embeds) {
    const n = JSON.stringify(e).length
    if (cur.length && (cur.length === 10 || size + n > MESSAGE_BUDGET)) {
      messages.push(cur)
      cur = []
      size = 0
    }
    cur.push(e)
    size += n
  }
  if (cur.length) messages.push(cur)
  return messages.map((embeds) => ({ username: 'Virvi releases', embeds, allowed_mentions: { parse: [] } }))
}

const ZERO = /^0+$/

/** The push's commits, newest first, without merge commits; the head commit alone when `before` is unknown. */
export function pushCommits(before, after, cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  let range = [after, '-1']
  if (before && !ZERO.test(before)) {
    try {
      git('merge-base', '--is-ancestor', before, after)
      range = [`${before}..${after}`]
    } catch { /* a force push or an unknown commit: just the head */ }
  }
  const out = git('log', '--no-merges', '--format=%H%x1f%s%x1e', ...range)
  const all = out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, subject] = r.split('\x1f')
    return { sha, subject }
  })
  return { commits: all.slice(0, MAX_COMMITS), more: Math.max(0, all.length - MAX_COMMITS), ranged: range.length === 1 }
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : process.argv[i + 1]
}

async function main() {
  const given = arg('after') ?? process.env.GITHUB_SHA
  if (!given) throw new Error('--after is required')
  const after = execFileSync('git', ['rev-parse', `${given}^{commit}`], { encoding: 'utf8' }).trim()
  const before = arg('before')
  const { commits, more, ranged } = pushCommits(before, after)
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null
  const at = arg('at') ? new Date(arg('at')) : new Date()
  const messages = buildMessages({
    commits, more, after, at, result: arg('result') ?? 'success', runUrl,
    compareUrl: ranged ? `${REPO_URL}/compare/${before}...${after}` : null,
  })
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(messages, null, 2))
    return
  }
  const hook = process.env.DISCORD_RELEASE_WEBHOOK
  if (!hook) {
    console.log('DISCORD_RELEASE_WEBHOOK is not set: no release notes posted.')
    return
  }
  for (const body of messages) {
    const res = await fetch(`${hook}?wait=true`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`Discord answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  console.log(`Posted ${messages.length} message(s) for release ${after.slice(0, 12)} (${commits.length + more} commits).`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
