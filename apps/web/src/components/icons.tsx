// Line icons for the dashboard: 24×24 grid, 1.5 stroke, currentColor. Inline so the app needs no icon package.
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 20, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  )
}

export const HomeIcon = (p: IconProps) => <Icon {...p}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9v11h5v-6h4v6h5V9" /></Icon>
export const ScenesIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="m3 16 5-5 4 4 3-3 6 6" /><circle cx="16" cy="9" r="1.5" /></Icon>
export const UploadIcon = (p: IconProps) => <Icon {...p}><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" /><path d="M4 14v5a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-5" /></Icon>
export const CalendarIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="5" width="18" height="16" rx="1.5" /><path d="M3 10h18M8 3v4M16 3v4" /></Icon>
export const SparkleIcon = (p: IconProps) => <Icon {...p}><path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7Z" /><path d="M19 15.5c.25 1.6 1 2.35 2.5 2.5-1.5.25-2.25 1-2.5 2.5-.25-1.5-1-2.25-2.5-2.5 1.5-.15 2.25-.9 2.5-2.5Z" /></Icon>
export const PaperclipIcon = (p: IconProps) => <Icon {...p}><path d="m20.5 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" /></Icon>
export const XSmallIcon = (p: IconProps) => <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>
export const GiftIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v9h14v-9M12 8v13" /><path d="M12 8c-1.5-3-5-3.5-5-1.25S10 8 12 8Zm0 0c1.5-3 5-3.5 5-1.25S14 8 12 8Z" /></Icon>
export const MediaIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="1.5" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></Icon>
export const LayersIcon = (p: IconProps) => <Icon {...p}><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /><path d="m3 17.5 9 5 9-5" /></Icon>
export const BroadcastIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="2" /><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></Icon>
export const CubeIcon = (p: IconProps) => <Icon {...p}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></Icon>
export const ChartIcon = (p: IconProps) => <Icon {...p}><path d="M4 20V14M10 20V8M16 20v-9M22 20H2" /><path d="M16 11V4" /></Icon>
export const GearIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Icon>
export const ShieldIcon = (p: IconProps) => <Icon {...p}><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></Icon>
export const LockIcon = (p: IconProps) => <Icon {...p}><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Icon>
export const LogoutIcon = (p: IconProps) => <Icon {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5M5 12h11" /></Icon>
export const SearchIcon = (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>
export const GridIcon = (p: IconProps) => <Icon {...p}><rect x="3" y="3" width="7.5" height="7.5" rx="1" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1" /></Icon>
export const ListIcon = (p: IconProps) => <Icon {...p}><path d="M9 6h12M9 12h12M9 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth={2.5} /></Icon>
export const CopyIcon = (p: IconProps) => <Icon {...p}><rect x="8" y="8" width="13" height="13" rx="1.5" /><path d="M16 8V4.5A1.5 1.5 0 0 0 14.5 3h-10A1.5 1.5 0 0 0 3 4.5v10A1.5 1.5 0 0 0 4.5 16H8" /></Icon>
export const CheckIcon = (p: IconProps) => <Icon {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Icon>
export const PencilIcon = (p: IconProps) => <Icon {...p}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></Icon>
export const ArrowUpRightIcon = (p: IconProps) => <Icon {...p}><path d="M7 17 17 7M8 7h9v9" /></Icon>
export const PlusIcon = (p: IconProps) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>
export const ChevronDownIcon = (p: IconProps) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>
export const MoreIcon = (p: IconProps) => <Icon {...p}><path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={2.5} /></Icon>
export const BookIcon = (p: IconProps) => <Icon {...p}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /><path d="M8 7h8M8 11h6" /></Icon>
export const BugIcon = (p: IconProps) => <Icon {...p}><rect x="7" y="7" width="10" height="13" rx="5" /><path d="M9 7.5V6a3 3 0 0 1 6 0v1.5M12 11v9M7 12H3M21 12h-4M7.5 17 4 19M16.5 17l3.5 2M7.5 9 4 7M16.5 9 20 7" /></Icon>
export const TrashIcon = (p: IconProps) => <Icon {...p}><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></Icon>
export const BellIcon = (p: IconProps) => <Icon {...p}><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15Z" /><path d="M10 21h4" /></Icon>
