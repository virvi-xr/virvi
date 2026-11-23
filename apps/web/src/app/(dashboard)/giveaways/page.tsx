'use client'
import { Moved } from '@/components/Moved'

/** Giveaways are now Drops, at /drops. Old links (`/giveaways?id=…`) forward there. */
export default function GiveawaysMovedPage() {
  return <Moved to="/drops" label="Drops" />
}
