import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { LatLng } from './types'

export type MapMode = 'pickup' | 'destination' | 'view'

interface MapViewProps {
  pickup: LatLng | null
  destination: LatLng | null
  driver: LatLng | null
  /** أي نقطة يتم تحديدها بالضغط على الخريطة */
  pickMode: MapMode
  onPick: (lat: number, lng: number) => void
}

// وسط القاهرة كبداية افتراضية
const CAIRO: [number, number] = [30.0444, 31.2357]

function pinIcon(emoji: string, color: string): L.DivIcon {
  return L.divIcon({
    className: 'toktok-pin',
    html: `<div style="background:${color};border:2px solid #fff;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,.35)">${emoji}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  })
}

export default function MapView({
  pickup,
  destination,
  driver,
  pickMode,
  onPick,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<L.Marker[]>([])
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  const pickModeRef = useRef(pickMode)
  pickModeRef.current = pickMode

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current).setView(CAIRO, 14)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map)
    map.on('click', (e: L.LeafletMouseEvent) => {
      if (pickModeRef.current !== 'view') {
        onPickRef.current(e.latlng.lat, e.latlng.lng)
      }
    })
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []
    const points: L.LatLngExpression[] = []
    if (pickup) {
      markersRef.current.push(
        L.marker([pickup.lat, pickup.lng], { icon: pinIcon('🟢', '#16a34a') })
          .addTo(map)
          .bindPopup(`نقطة الركوب: ${pickup.label}`),
      )
      points.push([pickup.lat, pickup.lng])
    }
    if (destination) {
      markersRef.current.push(
        L.marker([destination.lat, destination.lng], {
          icon: pinIcon('🔴', '#dc2626'),
        })
          .addTo(map)
          .bindPopup(`الوجهة: ${destination.label}`),
      )
      points.push([destination.lat, destination.lng])
    }
    if (driver) {
      markersRef.current.push(
        L.marker([driver.lat, driver.lng], { icon: pinIcon('🛺', '#f59e0b') })
          .addTo(map)
          .bindPopup(`الكابتن: ${driver.label}`),
      )
      points.push([driver.lat, driver.lng])
    }
    if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.25))
    else if (points.length === 1) map.setView(points[0], 15)
  }, [pickup, destination, driver])

  return (
    <div
      ref={containerRef}
      className="map-box"
      style={{ height: 300, width: '100%', borderRadius: 12, zIndex: 0 }}
    />
  )
}
