import type { NextConfig } from 'next'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The commit SHA the deploy stamped into the repo's RELEASE file (`railway up` from a checkout passes no
// RAILWAY_GIT_COMMIT_SHA); 'dev' is the committed placeholder
function stampedRelease(): string {
  try { return readFileSync(resolve(process.cwd(), '../../RELEASE'), 'utf8').split('\n')[0].trim() } catch { return '' }
}

// The release names the build, so two builds of one commit are byte-identical (LIV-165: Next's default build id is
// random, and every page carries it)
const release = (process.env.NEXT_PUBLIC_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || stampedRelease() || 'dev').slice(0, 12)

const nextConfig: NextConfig = {
  generateBuildId: async () => `virvi-${release}`,
  // Static export for production — embedded in the server container as the dashboard SPA.
  // Disabled in dev so dynamic routes work without generateStaticParams constraints.
  output: process.env.NODE_ENV === 'production' ? 'export' : undefined,
  trailingSlash: true,
  // The build's release for error reports (LIV-66): NEXT_PUBLIC_RELEASE, else the commit SHA Railway builds from, else
  // the stamped RELEASE file
  env: { NEXT_PUBLIC_RELEASE: release },
}

export default nextConfig
