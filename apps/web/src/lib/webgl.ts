let known: boolean | null = null

/**
 * Whether this browser can start WebGL (false during SSR). Asked once per page load: each check opens a context, and
 * browsers drop the oldest when too many are open (it could be a visible 3D view), so the probe's is released.
 */
export function hasWebGL(): boolean {
  if (typeof document === 'undefined') return false
  if (known !== null) return known
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    known = !!gl
  } catch {
    known = false
  }
  return known
}
