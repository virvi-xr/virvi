'use client'
// The venue map (OpenStreetMap tiles through Leaflet): a draggable pin with its radius as a circle. Loaded client-only, as
// Leaflet reads `window`. A click on the map places the pin; dragging it moves it. A divIcon, as Leaflet's default marker
// image path breaks under bundlers.
import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { OSM_ATTRIBUTION, type LatLng } from '@/lib/venue-pin'

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const PIN_ICON = L.divIcon({
  className: '',
  html: '<span style="display:block;width:20px;height:20px;border-radius:50%;background:#3b82f6;border:3px solid #fff;box-shadow:0 0 0 1px #1d4ed8,0 1px 4px rgba(0,0,0,.5)"></span>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

export default function VenuePin({ pin, radiusM, onPin }: { pin: LatLng | null; radiusM: number; onPin: (p: LatLng) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const marker = useRef<L.Marker | null>(null)
  const circle = useRef<L.Circle | null>(null)
  const onPinRef = useRef(onPin)
  onPinRef.current = onPin
  // The pin this component last reported, so an echo of a drag doesn't re-centre the map under the host's cursor
  const reported = useRef<LatLng | null>(null)

  useEffect(() => {
    if (!box.current) return
    const m = L.map(box.current, { center: pin ? [pin.lat, pin.lng] : [20, 0], zoom: pin ? 16 : 2 })
    L.tileLayer(TILES, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(m)
    m.on('click', (e: L.LeafletMouseEvent) => {
      const w = e.latlng.wrap()
      const p = { lat: w.lat, lng: w.lng }
      reported.current = p
      onPinRef.current(p)
    })
    map.current = m
    return () => { m.remove(); map.current = null; marker.current = null; circle.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const m = map.current
    if (!m) return
    if (!pin) {
      marker.current?.remove(); circle.current?.remove(); marker.current = null; circle.current = null
      return
    }
    const at: L.LatLngExpression = [pin.lat, pin.lng]
    if (!marker.current) {
      marker.current = L.marker(at, { icon: PIN_ICON, draggable: true, keyboard: true, title: 'Venue pin' }).addTo(m)
      marker.current.on('dragend', () => {
        const ll = marker.current!.getLatLng().wrap()
        const p = { lat: ll.lat, lng: ll.lng }
        reported.current = p
        onPinRef.current(p)
      })
    } else marker.current.setLatLng(at)
    if (!circle.current) circle.current = L.circle(at, { radius: radiusM, color: '#3b82f6', weight: 2, fillOpacity: 0.15 }).addTo(m)
    else { circle.current.setLatLng(at); circle.current.setRadius(radiusM) }
    const echo = reported.current && reported.current.lat === pin.lat && reported.current.lng === pin.lng
    if (!echo) m.setView(at, 16)
  }, [pin, radiusM])

  return <div ref={box} role="application" aria-label="Venue map: click to place the pin, drag it to move it" className="h-64 w-full overflow-hidden rounded-md border border-gray-800" />
}
