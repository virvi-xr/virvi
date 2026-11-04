import type { InstanceInfo, InstanceMode } from './instance'

export const LOGO_MAX_BYTES = 512 * 1024
const LOGO_TYPES = new Set(['image/png', 'image/webp', 'image/svg+xml'])

/** A self-hosted install has its own look once it has a logo or a name. */
export function hasCustomBrand(info: Pick<InstanceInfo, 'name' | 'logoUrl'> | null | undefined): boolean {
  return !!(info && (info.logoUrl || info.name))
}

/** "Scenes · Virvi" → "Scenes · Acme Events". Titles that aren't Virvi's own pattern are left alone. */
export function brandTitle(title: string, name: string | null | undefined): string {
  if (!name) return title
  if (title === 'Virvi') return name
  return title.endsWith(' · Virvi') ? `${title.slice(0, -' · Virvi'.length)} · ${name}` : title
}

/** Quick checks before upload; the server checks the content again. null = fine. */
export function brandingFileProblem(file: { size: number; type: string }, kind: 'logo' | 'favicon'): string | null {
  if (kind === 'favicon' && file.type !== 'image/png') return 'Use a square PNG, at least 64 px.'
  if (kind === 'logo' && !LOGO_TYPES.has(file.type)) return 'Use a PNG, WebP or SVG image.'
  if (file.size > LOGO_MAX_BYTES) return 'The file is over 512 KB.'
  return null
}

/** Branding settings are for the instance admin of a self-hosted install. */
export function canManageBranding(mode: InstanceMode | null | undefined, role: string | null | undefined): boolean {
  return (mode === 'single' || mode === 'scalable') && role === 'admin'
}

/** A picked file as base64 (no data: prefix), for the JSON upload. */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
