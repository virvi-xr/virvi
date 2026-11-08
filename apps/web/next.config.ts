import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Static export for production — embedded in the server container as the dashboard SPA.
  // Disabled in dev so dynamic routes work without generateStaticParams constraints.
  output: process.env.NODE_ENV === 'production' ? 'export' : undefined,
  trailingSlash: true,
  // The build's release for error reports (LIV-66): NEXT_PUBLIC_RELEASE, else the commit SHA Railway builds from
  env: { NEXT_PUBLIC_RELEASE: (process.env.NEXT_PUBLIC_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || 'dev').slice(0, 12) },
}

export default nextConfig
