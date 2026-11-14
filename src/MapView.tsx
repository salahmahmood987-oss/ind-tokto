import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { LatLng } from './types'

export type MapMode = 'pickup' | 'destination' | 'view'

interface MapViewProps {
  pickup: LatLng | null
  destination: LatLng | null
  driver: LatLng | null
  /** كباتن تانيين على الخريطة (العميل يشوف الكباتن المتاحين حواليه) */
  drivers?: LatLng[]
  /** أي نقطة يتم تحديدها بالضغط على الخريطة */
  pickMode: MapMode
  onPick: (lat: number, lng: number) => void
  /** ارتفاع الخريطة (بكسل أو vh) — الخرائط الرئيسية (hero) بتكون أطول */
  height?: number | string
}

// وسط القاهرة كبداية افتراضية
const CAIRO: [number, number] = [30.0444, 31.2357]

// دبوس خريطة عصري على شكل قطرة — بدون إيموجي
function pinIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: 'toktok-pin',
    html: `<svg width="36" height="48" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="12" r="5" fill="#fff"/></svg>`,
    iconSize: [36, 48],
    iconAnchor: [18, 46],
  })
}

// علامة الكابتن على الخريطة: اللوجو الجديد — توكتوك جانبي حقيقي (نفس شعار التطبيق)
function toktokIcon(): L.Icon {
  return L.icon({
    iconUrl: '/tuktuk-marker.png',
    iconSize: [56, 56],
    iconAnchor: [28, 28],
  })
}

export default function MapView({
  pickup,
  destination,
  driver,
  drivers = [],
  pickMode,
  onPick,
  height = 300,
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
        L.marker([pickup.lat, pickup.lng], { icon: pinIcon('#16a34a') })
          .addTo(map)
          .bindPopup(`نقطة الركوب: ${pickup.label}`),
      )
      points.push([pickup.lat, pickup.lng])
    }
    if (destination) {
      markersRef.current.push(
        L.marker([destination.lat, destination.lng], {
          icon: pinIcon('#dc2626'),
        })
          .addTo(map)
          .bindPopup(`الوجهة: ${destination.label}`),
      )
      points.push([destination.lat, destination.lng])
    }
    if (driver) {
      markersRef.current.push(
        L.marker([driver.lat, driver.lng], { icon: toktokIcon() })
          .addTo(map)
          .bindPopup(`الكابتن: ${driver.label}`),
      )
      points.push([driver.lat, driver.lng])
    }
    drivers.forEach((d) => {
      markersRef.current.push(
        L.marker([d.lat, d.lng], { icon: toktokIcon() })
          .addTo(map)
          .bindPopup(`الكابتن: ${d.label}`),
      )
      points.push([d.lat, d.lng])
    })
    if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.25))
    else if (points.length === 1) map.setView(points[0], 15)
  }, [pickup, destination, driver, drivers])

  return (
    <div
      ref={containerRef}
      className="map-box"
      style={{ height, width: '100%', borderRadius: 12, zIndex: 0 }}
    />
  )
}
