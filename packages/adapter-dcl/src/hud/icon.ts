/**
 * The HUD launcher's Virvi symbol: a white V image plus a live status dot.
 *
 * The image ships inside each scene (no CDN): `virvi-dcl sync` / `virvi-dcl install` copy it from the
 * virvi-dcl package (assets/hud-v.png, made by assets/make-hud-v.py) to this scene-relative path, and the
 * generic World runtime deploys it with its bundle. Keep the path in step with packages/dcl/bin/sync.mjs.
 */
export const HUD_ICON_SRC = 'images/virvi/hud-v.png'

/** The symbol's frame (viewBox 0 0 1254 1254); the PNG is the whole frame, so the dot overlays at frame-relative coordinates. */
const FRAME = 1254
const DOT = { cx: 627, cy: 373, r: 132 }

/** Where the status dot sits inside an icon of `size` design pixels. */
export function hudIconDot(size: number): { left: number; top: number; diameter: number } {
  const k = size / FRAME
  return { left: (DOT.cx - DOT.r) * k, top: (DOT.cy - DOT.r) * k, diameter: DOT.r * 2 * k }
}

/** Logged when a scene was deployed without the icon, so the launcher shows a text V instead of a white square. */
export const HUD_ICON_MISSING_HINT =
  `[Virvi] ${HUD_ICON_SRC} is not in this scene, so the HUD launcher shows a plain V. Run \`npx @virvixr/dcl install\` in the scene folder and deploy again.`

/**
 * Whether the scene's deployed files (getSceneInformation().content) include the icon: true or false, or null when
 * the list is unknown. Without the file the explorer fills the icon's box with its white tint (LIV-64).
 */
export function hudIconInScene(content: Array<{ file?: string }> | undefined | null): boolean | null {
  if (!content?.length) return null
  const want = HUD_ICON_SRC.toLowerCase()
  return content.some((e) => e?.file?.toLowerCase() === want)
}
