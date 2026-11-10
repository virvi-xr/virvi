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

/**
 * What a workspace token reads as, or null to leave it alone. `the`: the words already carry their own article (so a
 * "the" before the token and a "folder" after it go).
 */
function tokenWords(token: string, backticked: boolean): { words: string; the: boolean } | null {
  const t = token.trim()
  if (/^studio-preview(?:\s|$)/.test(t)) return { words: 'the preview', the: true }
  if (CHECKER.test(t) || (backticked && /^(?:python3?\s+)?\S*check_[a-z0-9_]+\.py(?:\s|$)/.test(t))) return { words: 'the checks', the: true }
  if (/\s/.test(t) && !/^uploads\//.test(t)) return null // a command or a sentence in a code span: not ours to rewrite
  const out = /^(?:\.\/)?out(?:\/(.*))?$/.exec(t)
  if (out) {
    const rest = out[1] ?? ''
    if (!rest.replace(/\/+$/, '')) return backticked || out[1] !== undefined ? { words: 'the pieces', the: true } : null
    const folder = rest.split('/')[0]
    const name = pieceName(folder)
    if (name) return { words: name, the: true }
  }
  const upload = /^(?:\.\/)?uploads\/(.+)$/.exec(t)
  if (upload) return { words: upload[1].split('/').pop()!, the: false }
  // Only a token the prose pattern found, or a code span that is clearly a workspace path
  if (((t.includes('/') && ROOTS.test(t)) || FILE_EXT.test(t)) && !/[\s*?<>|"]/.test(t)) {
    const base = t.replace(/\/+$/, '').split('/').pop()!
    return base ? { words: base, the: false } : null
  }
  return null
}

// Inline code, or a bare workspace token in the prose: an out/ path into a piece's folder or a note, an upload, the
// preview command (with what it was run on) or a checker script
const BARE = String.raw`(?<![\w/.\-])(?:(?:\.\/)?out\/(?:proposal\.json|declined\.json|(?:${[...WEARABLE_CATEGORIES, 'emote', 'building'].join('|')}|furniture_[a-z0-9_]+)(?![\w])(?:\/[\w.\-/]*)?)|(?:\.\/)?uploads\/[^\s\`'"(),;]+|studio-preview(?:\s+(?:\.\/)?out\/[\w.\-/]*)*(?:\s+--[\w-]+)*|check_[a-z0-9_]+\.py)`
const TOKEN = new RegExp(String.raw`(\b[Tt]he\s+)?(\`[^\`\n]+\`|${BARE})(\s+(?:folder|directory)\b)?`, 'g')

/** Trailing sentence punctuation a bare token picked up: it belongs to the sentence. */
function splitTrailing(token: string): [string, string] {
  const m = /[.,;:!?]+$/.exec(token)
  return m ? [token.slice(0, m.index), m[0]] : [token, '']
}

/** Whether a replacement starting here begins a sentence (or a list item), so its "the" is capitalised. */
const sentenceStart = (before: string) => before === '' || /(?:[.!?]\s+|\n\s*(?:[-*+]\s+|\d+\.\s+)?|^\s*(?:[-*+]\s+|\d+\.\s+)?)$/.test(before)

function rewriteProse(text: string): string {
  // "… to `out/proposal.json` instead": the agent's note is not a place the user can go
  let s = text.replace(new RegExp(String.raw`\s+(?:to|in|into|at)\s+(\`(?:\.\/)?out\/(?:proposal|declined)\.json\`|(?<![\w/.\-])(?:\.\/)?out\/(?:proposal|declined)\.json(?![\w/]))`, 'g'), '')
  // "(`check_wearable.py`)", "the hat (`out/hat/`)": a parenthesis holding only the workspace's name says nothing more
  s = s.replace(new RegExp(String.raw`\s*\(\s*(\`[^\`\n]+\`|${BARE})\s*\)`, 'g'), (whole, token: string) => {
    const backticked = token.startsWith('`')
    const words = tokenWords(backticked ? token.slice(1, -1) : splitTrailing(token)[0], backticked)
    return words?.the ? '' : whole
  })
  s = s.replace(TOKEN, (whole, the: string | undefined, raw: string, folder: string | undefined, offset: number, all: string) => {
    const backticked = raw.startsWith('`')
    const [token, trailing] = backticked ? [raw.slice(1, -1), ''] : splitTrailing(raw)
    const found = tokenWords(token, backticked)
    if (!found) return whole
    if (!found.the) return `${the ?? ''}${found.words}${trailing}${folder ?? ''}`
    const capital = the ? /^T/.test(the) : sentenceStart(all.slice(0, offset))
    const words = capital ? found.words.charAt(0).toUpperCase() + found.words.slice(1) : found.words
    return `${words}${trailing}`
  })
  return s
}

/** The reply's text for the customer; code blocks (``` fences) are left as they are. */
export function customerReply(text: string): string {
  if (!text) return text
  return text.split(/(```[\s\S]*?(?:```|$))/).map((part, i) => i % 2 ? part : rewriteProse(part)).join('')
}
