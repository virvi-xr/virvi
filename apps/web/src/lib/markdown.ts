/**
 * The small Markdown the studio's agents and the assistant write (paragraphs, headings, lists, fenced code, tables,
 * bold, italics, inline code and links), parsed into a tree the page renders as React elements. Nothing is ever turned
 * into HTML: tags in a reply stay text, and only http(s) addresses and root-relative paths become links (the renderer
 * decides which of those it makes clickable).
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'br' }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] }

export type ListItem = { inlines: Inline[]; children: Block[] }

export type Block =
  | { type: 'p'; inlines: Inline[] }
  | { type: 'h'; level: 1 | 2 | 3; inlines: Inline[] }
  | { type: 'ul'; items: ListItem[] }
  | { type: 'ol'; start: number; items: ListItem[] }
  | { type: 'code'; text: string }
  | { type: 'table'; align: Array<'left' | 'center' | 'right' | null>; head: Inline[][]; rows: Inline[][][] }

const FENCE = /^\s*```/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/

const indentOf = (line: string) => /^\s*/.exec(line)![0].replace(/\t/g, '    ').length
const listKindOf = (line: string) => (BULLET.test(line) ? 'ul' : NUMBERED.test(line) ? 'ol' : null)

/** A table row's cells: the outer pipes dropped, split on each pipe that isn't escaped (`\\|` stays a pipe). */
function cellsOf(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  const s = line.trim().replace(/^\|/, '')
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++ }
    else if (s[i] === '|') { cells.push(cur.trim()); cur = '' }
    else cur += s[i]
  }
  if (cur.trim() || !/\|\s*$/.test(line)) cells.push(cur.trim())
  return cells
}

const SEPARATOR_CELL = /^:?-+:?$/

/** The table whose header is lines[i]: it needs a separator row under it with one cell per header cell. */
function parseTable(lines: string[], i: number): [Block, number] | null {
  if (!lines[i].includes('|') || !lines[i + 1]?.includes('|')) return null
  const headCells = cellsOf(lines[i])
  const sep = cellsOf(lines[i + 1])
  if (sep.length !== headCells.length || !sep.every((c) => SEPARATOR_CELL.test(c))) return null
  const align = sep.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null))
  const rows: Inline[][][] = []
  let j = i + 2
  for (; j < lines.length && lines[j].trim() && lines[j].includes('|'); j++) {
    const cells = cellsOf(lines[j]).slice(0, headCells.length)
    while (cells.length < headCells.length) cells.push('')
    rows.push(cells.map(parseInline))
  }
  return [{ type: 'table', align, head: headCells.map(parseInline), rows }, j]
}

/**
 * A list starting at lines[i]: items at its indent, each with its wrapped lines and anything indented under it (a
 * nested list). Blank lines between items keep the list going, so a loose list keeps its numbers. Returns the block
 * and the index after it.
 */
function parseList(lines: string[], i: number): [Block, number] {
  const kind = listKindOf(lines[i])!
  const indent = indentOf(lines[i])
  const items: ListItem[] = []
  const first = NUMBERED.exec(lines[i])
  while (i < lines.length) {
    const line = lines[i]
    if (indentOf(line) !== indent || listKindOf(line) !== kind) break
    const text = kind === 'ul' ? BULLET.exec(line)![2] : NUMBERED.exec(line)![3]
    const own: string[] = [text.trim()]
    const under: string[] = []
    i++
    for (; i < lines.length; i++) {
      const next = lines[i]
      if (!next.trim()) {
        // A blank line ends the item unless more of it, or the next item, follows
        const after = lines.slice(i + 1).find((l) => l.trim())
        if (after === undefined || indentOf(after) < indent || (indentOf(after) === indent && listKindOf(after) !== kind)) break
        if (indentOf(after) === indent) { i++; break }
        under.push('')
        continue
      }
      if (indentOf(next) <= indent) break
      if (!under.length && !listKindOf(next) && !FENCE.test(next)) own.push(next.trim()) // a wrapped line
      else under.push(next.slice(Math.min(indentOf(next), indent + 2)))
    }
    items.push({ inlines: inlinesOfLines(own), children: under.length ? parseMarkdown(under.join('\n')) : [] })
  }
  const block: Block = kind === 'ul' ? { type: 'ul', items } : { type: 'ol', start: Number(first![2]), items }
  return [block, i]
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', inlines: inlinesOfLines(para) })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i])
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      flush()
      blocks.push({ type: 'h', level: Math.min(h[1].length, 3) as 1 | 2 | 3, inlines: parseInline(h[2].trim()) })
      continue
    }
    const table = parseTable(lines, i)
    if (table) {
      flush()
      blocks.push(table[0])
      i = table[1] - 1
      continue
    }
    if (listKindOf(line)) {
      flush()
      const [list, next] = parseList(lines, i)
      blocks.push(list)
      i = next - 1
      continue
    }
    if (!line.trim()) flush()
    else para.push(line.trim())
  }
  flush()
  return blocks
}

function inlinesOfLines(lines: string[]): Inline[] {
  return lines.flatMap((l, i) => (i ? [{ type: 'br' } as Inline, ...parseInline(l)] : parseInline(l)))
}

// An http(s) address, or a path from the site's root (not `//host` or `/\\host`, which a browser reads as another site)
const SAFE_HREF = /^(https?:\/\/\S+|\/(?![/\\])[^\s\\]*)$/i

/** Inline spans. A marker only counts with a closing partner; anything unmatched stays as written. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const pushText = (t: string) => { text += t }
  const flush = () => {
    if (text) out.push({ type: 'text', text })
    text = ''
  }

  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '`') {
      const end = s.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ type: 'code', text: s.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (s.startsWith('***', i)) {
      const end = s.indexOf('***', i + 3)
      if (end > i + 3) {
        flush()
        out.push({ type: 'strong', children: [{ type: 'em', children: parseInline(s.slice(i + 3, end)) }] })
        i = end + 3
        continue
      }
    }
    if (c === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ type: 'strong', children: parseInline(s.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if ((c === '*' || c === '_') && s[i + 1] !== c && s[i + 1] !== ' ' && s[i + 1] !== undefined) {
      // `_` only opens at a word's start, so snake_case stays text
      const opensWord = c === '*' || i === 0 || /[\s(]/.test(s[i - 1])
      const end = findClose(s, c, i + 1)
      if (opensWord && end > i + 1) {
        flush()
        out.push({ type: 'em', children: parseInline(s.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    if (c === '[') {
      const link = linkAt(s, i)
      if (link && SAFE_HREF.test(link.href)) {
        flush()
        out.push({ type: 'link', href: link.href, children: parseInline(link.label) })
        i = link.end
        continue
      }
    }
    pushText(c)
    i++
  }
  flush()
  return out
}

/** `[label](href)` at i, with balanced parentheses inside the address (Wikipedia's `Foo_(bar)`). */
function linkAt(s: string, i: number): { label: string; href: string; end: number } | null {
  const m = /^\[([^\]]+)\]\(/.exec(s.slice(i))
  if (!m) return null
  let depth = 0
  for (let j = i + m[0].length; j < s.length; j++) {
    const ch = s[j]
    if (/\s/.test(ch)) return null
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) return { label: m[1], href: s.slice(i + m[0].length, j), end: j + 1 }
      depth--
    }
  }
  return null
}

/** The closing single `*` or `_`: not part of a doubled marker, not after a space, and (for `_`) at a word's end. */
function findClose(s: string, c: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] !== c || s[j - 1] === ' ' || s[j + 1] === c || s[j - 1] === c) continue
    if (c === '_' && s[j + 1] !== undefined && /\w/.test(s[j + 1])) continue
    return j
  }
  return -1
}
