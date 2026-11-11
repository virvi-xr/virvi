// Icons for the scene's non-model elements on the bird's-eye heatmap (LIV-85).
const ICONS: Record<string, { glyph: string; label: string }> = {
  video: { glyph: '▶', label: 'Screen' },
  image: { glyph: '▣', label: 'Image' },
  nft: { glyph: '◆', label: 'NFT' },
  sound: { glyph: '♪', label: 'Sound' },
  widget: { glyph: '⚙', label: 'Widget' },
  custom: { glyph: '✱', label: 'Custom' },
  ad_space: { glyph: 'Ad', label: 'Ad space' },
}

export const iconFor = (type: string) => ICONS[type] ?? { glyph: '•', label: 'Element' }
