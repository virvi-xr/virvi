// The licenses a creator can share a model under (LIV-20), with a plain summary of what each lets other people do.

export interface ShareLicense {
  id: string
  /** The license's short name, as shown on a model. */
  name: string
  /** What someone else may do with it, in one or two plain sentences. */
  summary: string
  /** Who uses it must credit the creator. */
  credit: boolean
  /** It may be used to make money: a ticketed or sponsored event, a sale, an ad. */
  commercial: boolean
  /** Changed versions may be shared. */
  changes: boolean
  /** A changed version must be shared under the same license. */
  shareAlike: boolean
  /** Where the full legal text is, for licenses that have one. */
  url: string | null
}

export const SHARE_LICENSES: readonly ShareLicense[] = [
  {
    id: 'cc0-1.0', name: 'CC0 (public domain)',
    summary: 'Anyone can use, change and sell it, for anything, without crediting you.',
    credit: false, commercial: true, changes: true, shareAlike: false, url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  },
  {
    id: 'cc-by-4.0', name: 'CC BY 4.0',
    summary: 'Anyone can use, change and sell it, as long as they credit you.',
    credit: true, commercial: true, changes: true, shareAlike: false, url: 'https://creativecommons.org/licenses/by/4.0/',
  },
  {
    id: 'cc-by-sa-4.0', name: 'CC BY-SA 4.0',
    summary: 'Anyone can use, change and sell it with credit to you. Anything they make from it must be shared under this same license.',
    credit: true, commercial: true, changes: true, shareAlike: true, url: 'https://creativecommons.org/licenses/by-sa/4.0/',
  },
  {
    id: 'cc-by-nd-4.0', name: 'CC BY-ND 4.0',
    summary: 'Anyone can use it as it is, commercially too, with credit to you. They can’t share changed versions.',
    credit: true, commercial: true, changes: false, shareAlike: false, url: 'https://creativecommons.org/licenses/by-nd/4.0/',
  },
  {
    id: 'cc-by-nc-4.0', name: 'CC BY-NC 4.0',
    summary: 'Anyone can use and change it with credit to you, but not to make money: no ticketed or sponsored events, sales or ads.',
    credit: true, commercial: false, changes: true, shareAlike: false, url: 'https://creativecommons.org/licenses/by-nc/4.0/',
  },
  {
    id: 'cc-by-nc-sa-4.0', name: 'CC BY-NC-SA 4.0',
    summary: 'Anyone can use and change it with credit to you, not to make money. Anything they make from it must be shared under this same license.',
    credit: true, commercial: false, changes: true, shareAlike: true, url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  },
  {
    id: 'cc-by-nc-nd-4.0', name: 'CC BY-NC-ND 4.0',
    summary: 'The most restrictive Creative Commons license: anyone can use it as it is, with credit to you, not to make money, and they can’t share changed versions.',
    credit: true, commercial: false, changes: false, shareAlike: false, url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
  },
  {
    id: 'virvi-only', name: 'Virvi users only',
    summary: 'Virvi users can place it in their Virvi scenes, events included, with credit to you. They can’t take it to use anywhere else or resell it.',
    credit: true, commercial: true, changes: false, shareAlike: false, url: null,
  },
]

/** Licenses older uploads were tagged with, before sharing picked from SHARE_LICENSES. */
const LEGACY: Record<string, string> = { cc0: 'cc0-1.0', 'cc-by': 'cc-by-4.0' }

/** The share license with this id (or a legacy id that means it), or null. */
export function shareLicense(id: string | null | undefined): ShareLicense | null {
  if (!id) return null
  const key = LEGACY[id] ?? id
  return SHARE_LICENSES.find((l) => l.id === key) ?? null
}

/** The most a creator's credit name can be. */
export const CREDIT_MAX = 80
