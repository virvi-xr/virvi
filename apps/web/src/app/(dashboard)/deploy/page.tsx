'use client'
import { Moved } from '@/components/Moved'

/** Deploy is now Sync, at /sync. Old links (`/deploy?scene=…`) forward there. */
export default function DeployMovedPage() {
  return <Moved to="/sync" label="Sync" />
}
