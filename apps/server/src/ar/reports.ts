import { db } from '../db/connection.js'
import { arReports } from '../db/schema.js'
import { config } from '../config.js'
import { sendEmail } from '../services/email.js'

/** What a visitor can pick in the Quest menu's "Report this space". */
export const AR_REPORT_REASONS: ReadonlySet<string> = new Set(['offensive', 'unsafe', 'spam', 'other'])

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * Store a visitor's report (no identity: just the space, reason, platform and time), then email it to support. The
 * email is best-effort and not waited for: production may have no SMTP, and the admin page is where reports are read.
 */
export async function createArReport(
  space: { id: string; sceneId: string; name: string },
  reason: string,
  platform: string,
): Promise<void> {
  const [row] = await db.insert(arReports).values({ spaceId: space.id, reason, platform }).returning({ createdAt: arReports.createdAt })
  const name = escapeHtml(space.name)
  // No address set (a self-hosted install that didn't choose one): the report is kept, and nobody is emailed
  if (!config.arReportsEmail) return
  void Promise.resolve()
    .then(() =>
      sendEmail(
        config.arReportsEmail,
        `Virvi Spaces report: ${reason} — ${space.name.replace(/[\r\n]+/g, ' ')}`,
        `
    <h2>A Virvi Spaces visitor reported a space</h2>
    <p>Space: <b>${name}</b><br>Space id: ${space.id}<br>Scene id: ${space.sceneId}<br>Reason: ${reason}<br>Platform: ${platform}<br>Time: ${row.createdAt.toISOString()}</p>
    <p><a href="${config.publicUrl}/admin">Open the admin page</a></p>
  `,
      ),
    )
    .catch((err) => console.error('[virvi-ar-reports] report email failed:', err instanceof Error ? err.message : err))
}
