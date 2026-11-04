'use client'
import Link from 'next/link'
import { InstanceBadge } from '@/components/InstanceBadge'
import { useInstance } from '@/lib/instance'

/**
 * The app's name in the sidebar and on the sign-in page: Virvi, or a self-hosted install's own logo or name, with the
 * install label (and "Powered by Virvi" under a custom brand) beside or below it. Only the name links to `href`, so
 * tapping the label opens its details instead of navigating.
 */
export function BrandMark({ href, textClass = 'text-xl font-bold tracking-tight text-white' }: { href?: string; textClass?: string }) {
  const info = useInstance()
  const logo = info?.logoUrl
  const name = info?.name
  const custom = !!(logo || name)
  /* eslint-disable-next-line @next/next/no-img-element */
  const mark = logo ? <img src={logo} alt={name || 'Logo'} className="h-auto max-h-10 w-auto max-w-[160px] object-contain" />
    : <span className={textClass}>{custom ? name : 'Virvi'}</span>
  return (
    <span className={custom ? 'flex flex-col items-start gap-1' : 'flex items-center gap-2'}>
      {href ? <Link href={href} className="inline-flex">{mark}</Link> : mark}
      <InstanceBadge />
    </span>
  )
}
