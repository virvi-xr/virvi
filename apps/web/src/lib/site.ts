/** Where "Advertise with Virvi" goes. Null opens the early-access form; set to '/advertise' when ad step 3 ships. */
export const ADVERTISE_PAGE: string | null = null

/** Public links on the landing page. Docs are the server's own /docs/ unless NEXT_PUBLIC_DOCS_URL points elsewhere; Discord is null (and left out) until configured; privacy is the app's own page. */
export function siteLinks(
  env: { docs?: string; discord?: string } = { docs: process.env.NEXT_PUBLIC_DOCS_URL, discord: process.env.NEXT_PUBLIC_DISCORD_URL },
): { docs: string; privacy: string; discord: string | null } {
  return {
    docs: env.docs || '/docs/',
    privacy: '/privacy/',
    discord: env.discord || null,
  }
}
