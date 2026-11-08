import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import '@/styles/globals.css'
import { AuthProvider } from '@/lib/auth'
import { SignUpSheet } from '@/components/SignUpSheet'
import { BrandingHead } from '@/components/BrandingHead'
import { ErrorReporting } from '@/components/ErrorReporting'
import { ErrorPrompts } from '@/components/ErrorPrompts'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', display: 'swap' })

const description = 'Run your metaverse scenes from one dashboard, and advertise on screens and billboards in live Decentraland scenes.'

export const metadata: Metadata = {
  metadataBase: new URL('https://virvi.io'),
  title: { default: 'Virvi', template: '%s · Virvi' },
  description,
  icons: { icon: [{ url: '/favicon.ico', sizes: '32x32' }, { url: '/virvi-symbol.svg', type: 'image/svg+xml' }], apple: '/apple-touch-icon.png' },
  manifest: '/site.webmanifest',
  openGraph: { title: 'Virvi', description, siteName: 'Virvi', images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Virvi' }] },
  twitter: { card: 'summary_large_image', images: ['/og.png'] },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="bg-gray-950 font-sans text-white antialiased">
        <BrandingHead />
        <AuthProvider><ErrorReporting />{children}<SignUpSheet /><ErrorPrompts /></AuthProvider>
      </body>
    </html>
  )
}
