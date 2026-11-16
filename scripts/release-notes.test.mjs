// Tests for release-notes.mjs: the Discord messages a push posts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMessages, bullet, parseSubject, pushCommits, utcLine } from './release-notes.mjs'

const AT = new Date('2026-11-16T22:57:30Z')
const SHA = 'acd995c7aaaabbbbccccddddeeeeffff00001111'
const c = (subject, sha = SHA) => ({ sha, subject })

test('parses a conventional subject into kind, area and text', () => {
  assert.deepEqual(parseSubject('feat(beats): lost or stolen (LIV-11)'), { kind: 'feat', area: 'Beats', text: 'lost or stolen (LIV-11)' })
  assert.deepEqual(parseSubject('fix(design-studio,web): x'), { kind: 'fix', area: 'Design studio, Web', text: 'x' })
  assert.deepEqual(parseSubject('Merge-free plain subject'), { kind: 'other', area: null, text: 'Merge-free plain subject' })
  assert.equal(parseSubject('chore: bump').kind, 'other')
})

test('a bullet has the area in bold and links the short commit', () => {
  assert.equal(bullet(c('fix(beats): the card')), `- **Beats:** the card · [\`acd995c\`](https://github.com/virvi-xr/virvi/commit/${SHA})`)
})

test('the date line is easy to read, in UTC', () => {
  assert.equal(utcLine(AT), 'Monday, 16 November 2026 · 22:57 UTC')
})

test('a push becomes one message: date first, release named as /transparency names it, sections in order', () => {
  const [m, ...rest] = buildMessages({ commits: [c('docs: a'), c('fix(beats): b'), c('feat(studio): c')], after: SHA, at: AT, runUrl: 'https://run' })
  assert.equal(rest.length, 0)
  const [e] = m.embeds
  assert.equal(e.title, 'Virvi release acd995c7aaaa')
  assert.match(e.description, /^## 📅 Monday, 16 November 2026 · 22:57 UTC\n-# <t:1794869850:F> your time · <t:1794869850:R>/)
  assert.ok(e.description.indexOf('✨ New') < e.description.indexOf('🛠️ Fixes'))
  assert.ok(e.description.indexOf('🛠️ Fixes') < e.description.indexOf('📖 Docs'))
  assert.equal(e.timestamp, AT.toISOString())
  assert.match(e.fields[0].value, /\[Signed build\]\(https:\/\/run\)/)
  assert.match(e.fields[0].value, /virvi\.io\/transparency/)
  assert.deepEqual(m.allowed_mentions, { parse: [] })
})

test('a failed build says it in red and that it cannot be deployed', () => {
  const [m] = buildMessages({ commits: [c('fix: x')], after: SHA, at: AT, result: 'failure' })
  assert.equal(m.embeds[0].color, 0xef4444)
  assert.match(m.embeds[0].description, /didn't build \(\*\*failure\*\*\)/)
})

test('a big push is split within Discord limits and keeps every commit', () => {
  const commits = Array.from({ length: 100 }, (_, i) => c(`feat(area${i}): ${'word '.repeat(40)}${i}`))
  const messages = buildMessages({ commits, more: 12, after: SHA, at: AT, compareUrl: 'https://cmp' })
  const text = messages.flatMap((m) => m.embeds.map((e) => e.description)).join('\n')
  for (let i = 0; i < 100; i++) assert.ok(text.includes(`**Area${i}:**`), `commit ${i}`)
  assert.match(text, /and 12 more, in \[the full comparison\]\(https:\/\/cmp\)/)
  for (const m of messages) {
    assert.ok(m.embeds.length <= 10)
    assert.ok(m.embeds.reduce((n, e) => n + (e.title?.length ?? 0) + e.description.length + (e.fields?.[0].value.length ?? 0) + (e.footer?.text.length ?? 0), 0) <= 6000)
    for (const e of m.embeds) assert.ok(e.description.length <= 4096)
  }
})

test('pushCommits lists the push without merges, or the head alone when before is unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-'))
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  const commit = (msg) => { const f = msg.replace(/\W/g, '_'); writeFileSync(join(dir, f), msg); git('add', f); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD') }
  const base = commit('chore: base')
  git('checkout', '-q', '-b', 'side'); commit('feat: side')
  git('checkout', '-q', 'main'); commit('fix: main')
  git('merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side')
  const head = git('rev-parse', 'HEAD')
  const pushed = pushCommits(base, head, dir)
  assert.deepEqual(pushed.commits.map((x) => x.subject).sort(), ['feat: side', 'fix: main'])
  assert.equal(pushed.ranged, true)
  const first = pushCommits('0000000000000000000000000000000000000000', head, dir)
  assert.equal(first.commits.length, 1)
  assert.equal(first.ranged, false)
})
