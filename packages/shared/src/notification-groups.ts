/**
 * The bell's notice groups a person can turn off (LIV-30). Invitations and moderation notices about your own models
 * are always shown, so they are in no group here. The server skips a muted group's notices; Settings lists these.
 */
export const NOTIFICATION_GROUPS = [
  {
    id: 'studio',
    label: 'Design Studio activity',
    description: 'Prompts and notes on designs you share, finished packages, help requests and ownership changes',
    kinds: ['studio_prompts', 'studio_package_ready', 'studio_owner', 'studio_support_note', 'studio_help'],
  },
  {
    id: 'scene_updates',
    label: 'Scene updates',
    description: 'When a new Virvi release is out for a scene you host',
    kinds: ['scene_update'],
  },
  {
    id: 'rewards',
    label: 'BEATs and giveaways',
    description: 'When a BEAT or a giveaway item reaches your wallet',
    kinds: ['beat_minted', 'giveaway_sent'],
  },
] as const

export type NotificationGroupId = (typeof NOTIFICATION_GROUPS)[number]['id']

/** The group a notice kind belongs to, or null for one that is always shown. */
export function notificationGroupOf(kind: string): NotificationGroupId | null {
  return NOTIFICATION_GROUPS.find((g) => (g.kinds as readonly string[]).includes(kind))?.id ?? null
}

export const isNotificationGroup = (v: unknown): v is NotificationGroupId => NOTIFICATION_GROUPS.some((g) => g.id === v)
