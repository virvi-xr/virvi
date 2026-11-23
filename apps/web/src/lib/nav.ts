/** The dashboard menu's pure decisions (LIV-200): which item a page highlights. */

// Pages reached from another item, which stays highlighted while they are open: Studio (/scenes) covers its design tabs
// and the scene import
export const NAV_PARENT: Record<string, string> = { '/studio': '/scenes', '/import': '/scenes' }

/** `pathname` is `base` or a page under it (a whole path segment: /sync is not under /sy). */
const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(base.endsWith('/') ? base : `${base}/`)

/** Whether the menu item at `href` is the current page's. */
export function navActive(pathname: string, href: string): boolean {
  if (under(pathname, href)) return true
  return Object.entries(NAV_PARENT).some(([child, parent]) => parent === href && under(pathname, child))
}
