import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Virvi status',
  description: 'Whether Virvi is working right now, uptime over the last 90 days, and updates on any problem.',
}

export default function StatusLayout({ children }: { children: React.ReactNode }) {
  return children
}
