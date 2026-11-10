import { categoryLabel } from './studio'

/**
 * An agent's reply as the customer reads it: the workspace's file names, folders, paths and tools put in the
 * customer's terms ("I wrote a proposal to `out/proposal.json` instead" → "I wrote a proposal instead"). The worker
 * already asks the agent not to name them (instructions.py); this catches what slips through. It is conservative: only
 * tokens that are clearly the workspace's change, and every other code span and word is left as it was. Admin pages
 * and Virvi support read the raw text.
 */

/** The server's wearable categories (apps/server/src/studio/designs.ts WEARABLE_CATEGORIES). */
export const WEARABLE_CATEGORIES = [
  'eyebrows', 'eyes', 'facial_hair', 'hair', 'mouth', 'upper_body', 'lower_body', 'feet', 'earring', 'eyewear', 'hat',
  'helmet', 'mask', 'tiara', 'top_head', 'hands_wear', 'skin',
] as const

// Read as "the upper body piece", not "the upper body"
const PIECE_SUFFIX = new Set(['upper_body', 'lower_body', 'feet', 'top_head', 'hands_wear'])

/** A piece's folder name for people: `hat` → the hat, `upper_body` → the upper body piece; null for a folder that isn't one. */
export function pieceName(folder: string): string | null {
  if ((WEARABLE_CATEGORIES as readonly string[]).includes(folder)) {
    return `the ${categoryLabel(folder)}${PIECE_SUFFIX.has(folder) ? ' piece' : ''}`
  }
  if (folder === 'emote') return 'the emote'
  if (folder === 'building') return 'the building'
  const furniture = /^furniture_([a-z0-9_]+)$/.exec(folder)
  return furniture ? `the ${categoryLabel(furniture[1])} piece` : null
}

const FILE_EXT = /\.(?:py|json|blend|glb|png|fbx)$/i
const ROOTS = /^(?:\.\/|~\/|\/)?(?:out|uploads|work|workspace|opt|tmp|assets|skills)\//
const CHECKER = /^check_[a-z0-9_]+\.py$/
// Characters the reply's Markdown would read as formatting (`_` only opens at a word's start, so snake_case is
// fine): a name holding one stays in a code span
const MARKDOWN_SPECIAL = /[*~[\]<>\\]|(?:^|\W)_/

/**
 * What a workspace token reads as, or null to leave it alone. `the`: the words carry their own article ("the hat"),
 * so an article before the token and a "folder" after it go. A file name with characters Markdown would read as
 * formatting stays in a code span.
 */
function tokenWords(token: string, backticked: boolean): { words: string; the: boolean } | null {
  const t = token.trim()
  if (/^studio-preview(?:\s|$)/.test(t)) return { words: 'the preview', the: true }
  if (/^(?:python3?\s+)?\S*check_[a-z0-9_]+\.py(?:\s|$)/.test(t)) return { words: 'the checks', the: true }
  if (/\s/.test(t) && !/^uploads\//.test(t)) return null // a command or a sentence in a code span: not ours to rewrite
  // Only out/ with its slash: a bare "out" is a word
  const out = /^(?:\.\/)?out\/(.*)$/.exec(t)
  if (out) {
    const rest = out[1]
    if (!rest.replace(/\/+$/, '')) return backticked ? { words: 'the pieces', the: true } : null
    const name = pieceName(rest.split('/')[0])
    if (name) return { words: name, the: true }
  }
  const upload = /^(?:\.\/)?uploads\/(.+)$/.exec(t)
  const base = upload ? upload[1].split('/').pop()!
    : ((t.includes('/') && ROOTS.test(t)) || FILE_EXT.test(t)) && !/[\s*?<>|"]/.test(t) ? t.replace(/\/+$/, '').split('/').pop()! : ''
  if (!base) return null
  if (MARKDOWN_SPECIAL.test(base)) return base.includes('`') ? null : { words: `\`${base}\``, the: false }
  return { words: base, the: false }
}

const PIECE_FOLDERS = `(?:${[...WEARABLE_CATEGORIES, 'emote', 'building'].join('|')}|furniture_[a-z0-9_]+)`
const FLAGS = String.raw`(?:\s+--?[\w-]+(?:=\S+)?)*`
// A bare workspace token in the prose, only where it is clearly a path: a piece's folder with a file in it, or right
// after in/into/to/at/from; one of the agent's notes; an upload; the preview or a checker run (with its arguments)
const BARE = String.raw`(?<![\w/.\-])(?:(?:\.\/)?out\/(?:proposal\.json|declined\.json|${PIECE_FOLDERS}\/[\w.\-]+(?:\/[\w.\-]+)*)|(?<=\b(?:in|into|to|at|from)\s)(?:\.\/)?out\/${PIECE_FOLDERS}\/?(?![\w/])|(?:\.\/)?uploads\/[^\s\`'"(),;]+|studio-preview(?:\s+(?:\.\/)?out\/[\w.\-/]*)*${FLAGS}|check_[a-z0-9_]+\.py${FLAGS})`
const SPAN = String.raw`(?:\`[^\`\n]+\`|${BARE})`
const DETERMINER = String.raw`\b(?:[Tt]he|[Yy]our|[Mm]y|[Oo]ur|[Tt]his|[Tt]hat|[Aa]n?)\s+`
const TOKEN = new RegExp(String.raw`(${DETERMINER})?(${SPAN})(\s+(?:folder|directory)\b)?`, 'g')

/** Trailing sentence punctuation a bare token picked up: it belongs to the sentence. */
function splitTrailing(token: string): [string, string] {
  const m = /[.,;:!?]+$/.exec(token)
  return m ? [token.slice(0, m.index), m[0]] : [token, '']
}
/** A token as matched: its text, whether it was a code span, and the sentence punctuation a bare one picked up. */
function unwrap(raw: string): [string, boolean, string] {
  if (raw.startsWith('`')) return [raw.slice(1, -1), true, '']
  const [token, trailing] = splitTrailing(raw)
  return [token, false, trailing]
}

/** Whether a replacement starting here begins a sentence (or a list item), so its "the" is capitalised. */
function sentenceStart(before: string): boolean {
  if (/\b(?:e\.g|i\.e|etc|vs|cf)\.\s+$/i.test(before)) return false
  return before === '' || /(?:[.!?]\s+|\n\s*(?:[-*+]\s+|\d+\.\s+)?|^\s*(?:[-*+]\s+|\d+\.\s+)?)$/.test(before)
}
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function rewriteProse(text: string): string {
  // "… to `out/proposal.json` instead": the agent's note is not a place the user can go
  let s = text.replace(new RegExp(String.raw`\s+(?:to|in|into|at)\s+(\`(?:\.\/)?out\/(?:proposal|declined)\.json\`|(?<![\w/.\-])(?:\.\/)?out\/(?:proposal|declined)\.json(?![\w/]))`, 'g'), '')
  // "(`check_wearable.py`)", "the hat (`out/hat/`)": a parenthesis holding only the workspace's name says nothing more;
  // and "the checks in `check_wearable.py --strict`" already says it
  const said = (re: string) => new RegExp(re, 'g')
  s = s.replace(said(String.raw`\s*\(\s*(${SPAN})\s*\)`), (whole, token: string) => {
    const [t, backticked] = unwrap(token)
    return tokenWords(t, backticked)?.the ? '' : whole
  })
  s = s.replace(said(String.raw`\b(checks?|checker|preview)(\s+(?:in|with|from|using|via|by|of))?\s+(${SPAN})`), (whole, noun: string, _prep, token: string) => {
    const [t, backticked] = unwrap(token)
    const words = tokenWords(t, backticked)?.words
    return words && words === (noun === 'preview' ? 'the preview' : 'the checks') ? noun : whole
  })
  s = s.replace(TOKEN, (whole, det: string | undefined, raw: string, folder: string | undefined, offset: number, all: string) => {
    const [token, backticked, trailing] = unwrap(raw)
    const found = tokenWords(token, backticked)
    if (!found) return whole
    if (!found.the) return `${det ?? ''}${found.words}${trailing}${folder ?? ''}`
    // "your `out/hat/` folder" → your hat; "a `out/feet` folder", "the `out/hat/` folder" → the feet piece, the hat
    const own = det && /^(?:your|my|our|this|that)\s/i.test(det)
    const words = own ? `${det}${found.words.replace(/^the /, '')}` : found.words
    const capital = det ? /^[A-Z]/.test(det) : sentenceStart(all.slice(0, offset))
    return `${capital ? capitalise(words) : words}${trailing}`
  })
  return s
}

// A link's target that is a workspace path goes nowhere for the customer: just its words. A web link stays.
const LINK = /\[([^\]\n]*)\]\(([^)\s]*)\)/g
function rewriteLinks(text: string): string {
  return text.replace(LINK, (whole, words: string, href: string, offset: number) => {
    if (/^https?:\/\//i.test(href)) return whole
    const out = rewriteProse(words.includes('/') || FILE_EXT.test(words) ? `\`${words}\`` : words)
    // Rewritten on its own, the words read as a sentence's start: they keep the case of where the link stood
    return sentenceStart(text.slice(0, offset)) || /^[A-Z]/.test(words) ? out : out.charAt(0).toLowerCase() + out.slice(1)
  })
}

/** The reply's text for the customer; code blocks (``` fences) and web links are left as they are. */
export function customerReply(text: string): string {
  if (!text) return text
  return text.split(/(```[\s\S]*?(?:```|$))/).map((part, i) => {
    if (i % 2) return part
    // Web links are kept whole while the prose around them is rewritten
    const pieces = rewriteLinks(part).split(/(\[[^\]\n]*\]\(https?:\/\/[^)\s]*\))/i)
    return pieces.map((p, j) => j % 2 ? p : rewriteProse(p)).join('')
  }).join('')
}
