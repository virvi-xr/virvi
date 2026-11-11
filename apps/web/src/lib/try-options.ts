/** The two ways to try Virvi without an account, shown by the landing page and its "Try now" picker. */
export interface TryOption {
  key: 'studio' | 'scene'
  href: string
  title: string
  blurb: string
  cta: string
}

export const TRY_OPTIONS: readonly TryOption[] = [
  {
    key: 'studio',
    href: '/try/studio/',
    title: 'Design Studio',
    blurb: 'Describe a wearable, an emote or a building and an agent makes it for Decentraland. 3 free prompts.',
    cta: 'Try the Design Studio',
  },
  {
    key: 'scene',
    href: '/try/scene/',
    title: 'Scene builder',
    blurb: 'Pick a plot, drop in models, images, videos and sounds, and lay them out in 3D.',
    cta: 'Build a scene',
  },
]

/** The line under both options: what a guest can do, and when an account is asked for. */
export const TRY_NOTE = 'No wallet needed either. Your work is kept for 14 days; sign up when you want to keep it, deploy or finalize.'
