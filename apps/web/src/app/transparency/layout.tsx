import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Transparency and safety',
  description: 'Check that Virvi runs the code in its public GitHub repo: the live commit, the signed build record, and how to verify it yourself or with an AI agent.',
}

export default function TransparencyLayout({ children }: { children: React.ReactNode }) {
  return children
}
