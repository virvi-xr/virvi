/**
 * The Terms of Service version in force: the date it took effect (YYYY-MM-DD).
 *
 * Change it only when the Terms change enough that people must agree again. Every account whose last agreement is to an
 * older version is asked to agree before it can use the dashboard. Update apps/web/src/app/terms/page.tsx and
 * apps/docs/src/content/docs/terms.md in the same change (a test checks the page's date matches).
 */
export const TERMS_VERSION = '2026-11-18'

/** "18 November 2026": how a version reads on the page and in the agree prompt. */
export function termsDateLabel(version: string = TERMS_VERSION): string {
  const [y, m, d] = version.split('-').map(Number)
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${d} ${months[m - 1]} ${y}`
}
