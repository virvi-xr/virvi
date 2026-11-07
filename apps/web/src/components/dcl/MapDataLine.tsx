// LIV-135: whether Decentraland built a map snapshot for the last deploy, under "Last deploy" on a destination card.
import type { DclDestination } from '@/lib/api'
import { mapView } from '@/lib/deploy'

export function MapDataLine({ destination }: { destination: DclDestination }) {
  const view = mapView(destination)
  if (!view) return null
  return (
    <div className="mt-1.5">
      <p className={view.tone === 'warning' ? 'text-yellow-200' : 'text-gray-300'}>{view.line}</p>
      <p className="mt-0.5 text-xs text-gray-500">{view.help}</p>
    </div>
  )
}
