// Catalog credits shown with each model and on the credits page.
import { SHARE_LICENSES } from '@virvixr/shared'

export type AssetPack = { id: string; name: string; license: string; attribution: string }

const LICENSES: Record<string, string> = {
  mit: 'MIT',
  'cc-by-nc-3.0': 'CC BY-NC 3.0',
  unstated: 'license unstated',
  cc0: 'CC0',
  'cc-by': 'CC BY',
  proprietary: 'Proprietary',
}

export function licenseLabel(license: string): string {
  return LICENSES[license] ?? SHARE_LICENSES.find((l) => l.id === license)?.name ?? license
}

/** "by <artist> · <pack> · <license>" for a catalog model; '' for a user upload (no pack). */
export function creditLine(asset: { author?: string | null; pack?: AssetPack | null }): string {
  const pack = asset.pack
  if (!pack) return ''
  return [asset.author ? `by ${asset.author}` : null, pack.name, licenseLabel(pack.license)].filter(Boolean).join(' · ')
}
