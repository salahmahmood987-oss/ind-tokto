import { useEffect, useMemo, useRef, useState } from 'react'
import { Geolocation } from '@capacitor/geolocation'
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { FileOpener } from '@capacitor-community/file-opener'
import { Browser } from '@capacitor/browser'
import MapView from './MapView'
import type { MapMode } from './MapView'
import { IconCheck, IconDriver, IconHistory, IconList, IconPin, IconShield, IconUser, IconWallet } from './icons'
import logoUrl from './assets/icon-1024.png'
import { APP_VERSION, VERSION_URL } from './version'
import { firebaseEnabled, loadDoc, subscribeDrivers, subscribePassengers, subscribePayments, subscribeRides, subscribeWaitlist, uploadImageAsDataUrl, saveDoc } from './firebaseDb'
import { isInServiceArea, isInServiceBBox, OUT_OF_AREA_MESSAGE, OUT_OF_AREA_TITLE } from './geo'
import { sendOtpCode, verifyOtpCode } from './otp'
import {
  clientCodeForPhone,
  commissionFor,
  defaultState,
  isDebtBlocked,
  loadState,
  saveState,
} from './store'
import type { AppState } from './store'
import {
  FARE_MAX,
  FARE_MIN,
  MAX_DEBT_EGP,
  OTP_MAX_PER_HOUR,
} from './types'
import type { LatLng, Offer, PaymentRequest, Ride, Role } from './types'

function stars(value: number, onRate?: (n: number) => void) {
  return (
    <span className="stars">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={n <= value ? 'star on' : 'star'}
          onClick={() => onRate?.(n)}
          aria-label={`تقييم ${n}`}
        >
          ★
        </button>
      ))}
    </span>
  )
}

function money(n: number) {
  return `${n} ج.م`
}

/** أسباب إلغاء السواق للرحلة — آخر اختيار "سبب آخر" بيفتح خانة كتابة. */
const CANCEL_REASONS = [
  'العميل مش بيرد على التليفون',
  'نقطة الركوب بعيدة',
  'العميل طلب الإلغاء',
  'عطل في التوكتوك',
  'سبب آخر…',
]
/** المسافة بالكيلومتر بين نقطتين (صيغة هافرساين) — رقم واحد بعد العلامة. */
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const la1 = (a.lat * Math.PI) / 180
  const la2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10
}

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
}

// صورة شخصية دائرية — لو مفيش صورة يظهر أول حرف من الاسم
function avatar(url: string | null | undefined, name: string) {
  return url ? (
    <img src={url} alt={name} className="avatar" />
  ) : (
    <span className="avatar avatar-placeholder">{name.trim().charAt(0) || '؟'}</span>
  )
}

// خط زمني للرحلة: وقت الطلب والقبول والوصول والنهاية
function rideTimes(r: Ride) {
  return (
    <div className="ride-times">
      <span>وقت الطلب: {fmtTime(r.createdAt)}</span>
      <span>وقت القبول: {fmtTime(r.acceptedAt)}</span>
      <span>وصول الكابتن: {fmtTime(r.arrivedAt)}</span>
      <span>نهاية الرحلة: {fmtTime(r.completedAt)}</span>
    </div>
  )
}

function rideStatusLabel(s: Ride['status']): string {
  return s === 'matched' ? 'في الطريق للعميل'
    : s === 'driver_arrived' ? 'وصلت للعميل'
    : s === 'on_trip' ? 'الرحلة شغالة'
    : s === 'completed' ? 'مكتملة'
    : s === 'cancelled' ? 'ملغاة'
    : 'بندور على سواقين…'
}

// تحويل اسم مكان مكتوب لإحداثيات (بحث مجاني عبر OpenStreetMap — مصر فقط)
async function geocodePlace(label: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=eg&accept-language=ar&q=${encodeURIComponent(label)}`
    const res = await fetch(url, { headers: { 'Accept-Language': 'ar' } })
    if (!res.ok) return null
    const data = await res.json()
    if (!data?.length) return null
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
  } catch {
    return null
  }
}

export interface PlaceSuggestion { label: string; lat: number; lng: number }

/** اقتراحات عناوين أثناء الكتابة — زي جوجل ماب (بحث Nominatim المجاني، من غير مفتاح) — مقتصرة على نطاق الخدمة (أسيوط/سوهاج) */
async function searchPlaces(query: string, signal: AbortSignal): Promise<PlaceSuggestion[]> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=eg&limit=5&accept-language=ar&q=${encodeURIComponent(query)}`
    const res = await fetch(url, { signal, headers: { 'Accept-Language': 'ar' } })
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data)) return []
    return data
      .map((d) => ({ label: String(d.display_name ?? ''), lat: parseFloat(d.lat), lng: parseFloat(d.lon) }))
      .filter((s) => s.label && Number.isFinite(s.lat) && Number.isFinite(s.lng) && isInServiceBBox(s.lat, s.lng))
  } catch {
    return []
  }
}

function getCurrentPositionPromise(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation?.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 })
  })
}

// يحوّل نص المكان لإحداثيات: "موقعي الحالي" من الـ GPS، وأي اسم تاني من البحث
async function resolvePlace(label: string): Promise<LatLng | null> {
  const clean = label.trim()
  if (!clean) return null
  if (/موقعي الحالي|مكاني الحالي|موقعي|مكاني/.test(clean)) {
    try {
      const pos = await getCurrentPositionPromise()
      return { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'موقعي الحالي' }
    } catch {
      return null
    }
  }
  const g = await geocodePlace(clean)
  return g ? { lat: g.lat, lng: g.lng, label: clean } : null
}

// دمج رحلات Firestore مع الرحلات المحلية: الجديدة تتضاف، والتغييرات (حالة/عروض/أوقات) تتحدث
function mergeRides(local: Ride[], remote: Ride[]): Ride[] {
  if (!remote.length) return local
  const byNo = new Map(local.map((r) => [r.orderNo, r]))
  let changed = false
  const out = [...local]
  for (const rr of remote) {
    const ex = byNo.get(rr.orderNo)
    if (!ex) {
      out.push(rr)
      changed = true
      continue
    }
    const remoteOffers = rr.offers ?? []
    const offerIds = new Set(remoteOffers.map((o) => o.id))
    const offers = [...remoteOffers, ...ex.offers.filter((o) => !offerIds.has(o.id))]
    const same =
      ex.status === rr.status &&
      ex.driverCode === rr.driverCode &&
      ex.driverName === rr.driverName &&
      ex.acceptedAt === rr.acceptedAt &&
      ex.arrivedAt === rr.arrivedAt &&
      ex.completedAt === rr.completedAt &&
      ex.passengerPhotoUrl === rr.passengerPhotoUrl &&
      ex.driverPhotoUrl === rr.driverPhotoUrl &&
      offers.length === ex.offers.length
    if (!same) {
      out[out.findIndex((x) => x.orderNo === rr.orderNo)] = { ...ex, ...rr, offers }
      changed = true
    }
  }
  return changed ? out : local
}

// دمج طلبات تحويل محلية مع نسخة السيرفر — نسخة السيرفر هي الأحدث (حالة الموافقة/الرفض)
function mergePayments(local: PaymentRequest[], remote: PaymentRequest[]): PaymentRequest[] {
  if (!remote.length) return local
  const byId = new Map(local.map((p) => [p.id, p]))
  let changed = false
  const out = [...local]
  for (const rp of remote) {
    const ex = byId.get(rp.id)
    if (!ex) {
      out.push(rp)
      changed = true
      continue
    }
    if (ex.status !== rp.status || ex.amount !== rp.amount) {
      out[out.findIndex((x) => x.id === rp.id)] = rp
      changed = true
    }
  }
  return changed ? out : local
}

/**
 * زرار اختيار صورة — بيقرأ الصورة من الكاميرا أو المعرض عن طريق
 * البلاجن الأصلي (أوثق بكتير من <input type=file> في WebView، اللي
 * بيرجع ملفات من المعرض مش بتتقرأ أحياناً). لو البلاجن فشل،
 * بيرجع لاختيار الملف العادي.
 */
function PhotoPicker({ onPick, label }: { onPick: (file: File) => void; label: string }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  async function pick() {
    try {
      const photo = await Camera.getPhoto({
        quality: 85,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Prompt,
      })
      if (!photo.dataUrl) return
      const blob = await (await fetch(photo.dataUrl)).blob()
      const ext = photo.format === 'png' ? 'png' : photo.format === 'webp' ? 'webp' : 'jpg'
      onPick(new File([blob], `photo.${ext}`, { type: blob.type || 'image/jpeg' }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.toLowerCase().includes('cancel')) return
      // أي فشل تاني (إذن مرفوض، البلاجن مش متاح...) → اختيار ملف عادي
      inputRef.current?.click()
    }
  }
  return (
    <div>
      <button className="btn small" onClick={pick}>📷 {label}</button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState())
  const [role, setRole] = useState<Role>(() => {
    const saved = localStorage.getItem('indtoktok-app-role')
    return saved === 'driver' ? 'driver' : 'passenger'
  })
  // الدور العام للتطبيق (راكب/كابتن) — بيتحفظ على الجهاز، والعميل مبيشوفش غير شاشة الراكب
  const [appRole, setAppRole] = useState<'passenger' | 'driver' | null>(() => {
    const saved = localStorage.getItem('indtoktok-app-role')
    return saved === 'driver' || saved === 'passenger' ? saved : null
  })
  function chooseRole(r: 'passenger' | 'driver') {
    localStorage.setItem('indtoktok-app-role', r)
    setAppRole(r)
    setRole(r)
  }
  // الأرقام الموثقة بالـ OTP لكل دور — بتتحفظ على الجهاز، والدخول مش بيتم
  // غير بعد اختيار الدور ← رقم التليفون ← كود التحقق (للسواق والعميل)
  const [verifiedPhones, setVerifiedPhones] = useState<Record<string, string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('indtoktok-auth') || '{}') as Record<string, string>
      if (saved.passenger || saved.driver) return saved
      // ترحيل: رقم العميل اللي اتوثق بالـ OTP قبل كده يفضل موثق
      const migrated: Record<string, string> = {}
      if (state.passenger?.phoneVerified && state.passenger.phone) migrated.passenger = state.passenger.phone
      return migrated
    } catch {
      return {}
    }
  })
  function saveVerifiedPhones(v: Record<string, string>) {
    setVerifiedPhones(v)
    localStorage.setItem('indtoktok-auth', JSON.stringify(v))
  }
  /** يلغي توثيق رقم الكابتن — بيرجع شاشة التليفون والكود تاني. */
  function clearDriverVerification() {
    const next = { ...verifiedPhones }
    delete next.driver
    saveVerifiedPhones(next)
    setRegPhone(state.driver.phone)
    setOtpSent(false)
    setOtpInput('')
  }
  /** يلغي توثيق رقم العميل — بيرجع لشاشة التليفون والكود خطوة بخطوة. */
  function clearPassengerVerification() {
    const next = { ...verifiedPhones }
    delete next.passenger
    saveVerifiedPhones(next)
    setRegPhone(state.passenger?.phone || '')
    setOtpSent(false)
    setOtpInput('')
  }
  // نموذج بيانات الكابتن: ظاهر أول مرة لحد ما يملا بياناته ويدوس حفظ
  const [driverFormOpen, setDriverFormOpen] = useState(() => !state.driver.name.trim() || !state.driver.phone.trim())
  const [pickup, setPickup] = useState<LatLng | null>(null)
  const [destination, setDestination] = useState<LatLng | null>(null)
  const [pickupLabel, setPickupLabel] = useState('')
  const [destLabel, setDestLabel] = useState('')
  // اقتراحات العناوين أثناء الكتابة (نقطة الركوب / الوجهة)
  const [pickupSugg, setPickupSugg] = useState<PlaceSuggestion[]>([])
  const [destSugg, setDestSugg] = useState<PlaceSuggestion[]>([])
  const suggAbortRef = useRef<AbortController | null>(null)
  const [pickMode, setPickMode] = useState<MapMode>('pickup')
  const [fareText, setFareText] = useState('25')
  const [search, setSearch] = useState('')
  // قسم المستخدمين عند الأدمن: تبويب سواقين/عملاء + فلتر جدد/قدام/الكل + بحث
  const [adminUserTab, setAdminUserTab] = useState<'drivers' | 'passengers'>('drivers')
  const [adminUserFilter, setAdminUserFilter] = useState<'all' | 'new' | 'old'>('all')
  const [adminUserSearch, setAdminUserSearch] = useState('')
  const [notice, setNotice] = useState('')
  // طلب من برّه نطاق الخدمة (أسيوط/سوهاج) — المودال بتاع «لسه موصلناش هنا»
  const [outOfArea, setOutOfArea] = useState<{ pickupLabel: string; destLabel: string } | null>(null)
  // تنبيه التحديث: لو فيه إصدار أحدث على الريبو بيظهر مودال بزر تحديث
  const [availableUpdate, setAvailableUpdate] = useState<{ version: number; apkUrl: string } | null>(null)
  // تحميل التحديث جوّه التطبيق (من غير لينكات): شغال / نسبة التحميل / رسالة فشل
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateProgress, setUpdateProgress] = useState(0)
  const [updateError, setUpdateError] = useState('')
  const [requestBusy, setRequestBusy] = useState(false)
  // تسجيل العميل + OTP
  const [regPhone, setRegPhone] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [otpInput, setOtpInput] = useState('')
  const [otpBusy, setOtpBusy] = useState(false)
  // السواق
  const [payAmount, setPayAmount] = useState('')
  const [payShot, setPayShot] = useState<File | null>(null)
  const [idCardFile, setIdCardFile] = useState<File | null>(null)
  // التقييم
  const [rateDriver, setRateDriver] = useState(0)
  const [ratePassenger, setRatePassenger] = useState(0)
  // المفاوضة على السعر: سعر العرض اللي بيكتبه السواق لكل طلب (حسب رقم الطلب)
  const [offerPrices, setOfferPrices] = useState<Record<string, string>>({})
  // سعرك المقترح الجديد وأنت مستني عروض (العميل يقدر يرفعه أثناء البحث)
  const [counterFareText, setCounterFareText] = useState('')
  // إلغاء السواق: الطلب اللي بيتلغي + السبب المختار + نص "سبب آخر"
  const [cancelTarget, setCancelTarget] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelReasonOther, setCancelReasonOther] = useState('')
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => saveState(state), [state])

  const fare = Math.max(
    FARE_MIN,
    Math.min(FARE_MAX, parseInt(fareText || '0', 10) || FARE_MIN),
  )

  const activeRide = [...state.rides]
    .reverse()
    .find((r) => ['searching', 'matched', 'driver_arrived', 'on_trip'].includes(r.status))
  const lastRide = [...state.rides].reverse()[0]
  // رحلة الكابتن الحالية ورحلاته السابقة (مكتملة أو ملغاة)
  const myCurrentRide = state.rides.find((r) => r.driverCode === state.driver.code && ['matched', 'driver_arrived', 'on_trip'].includes(r.status))
  // السواق وصل للعميل؟ لوكيشن الوجهة يظهر له بس بعد الوصول (driver_arrived أو on_trip)
  const driverArrived = !!myCurrentRide && ['driver_arrived', 'on_trip'].includes(myCurrentRide.status)
  const myPastRides = state.rides
    .filter((r) => r.driverCode === state.driver.code && (r.status === 'completed' || r.status === 'cancelled'))
    .sort((a, b) => b.createdAt - a.createdAt)
  // طلبات العميل (كل حالاتها) — الأحدث أولاً
  const myPassengerRides = state.rides
    .filter((r) => state.passenger && r.passengerCode === state.passenger.code)
    .sort((a, b) => b.createdAt - a.createdAt)

  // ---- طلب إذن الموقع فور فتح التطبيق ----
  // أول ما التطبيق يفتح نطلب إذن الموقع من النظام، ولو اتوافق عليه
  // نجيب موقع المستخدم الحالي ونحطه كنقطة ركوب تلقائياً.
  // لو رفض الإذن التطبيق يكمل عادي وزرار «موقعي الحالي» يفضل موجود.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const perm = await Geolocation.requestPermissions()
        if (cancelled) return
        if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') return
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true })
        if (cancelled) return
        const ll: LatLng = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          label: 'موقعي الحالي',
        }
        setPickup(ll)
        setPickupLabel('موقعي الحالي')
      } catch {
        // تجاهل: رفض الإذن أو GPS مش متاح
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // ---- رنين التنبيه للكابتن عند وصول طلب جديد ----
  const audioCtxRef = useRef<AudioContext | null>(null)
  const seenSearchingRef = useRef<Set<string>>(new Set())
  const seenCancelledRef = useRef<Set<string>>(new Set())
  const firstCancelledRef = useRef(true)
  const firstRidesRef = useRef(true)
  function ring() {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      if (!audioCtxRef.current) audioCtxRef.current = new AC()
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') void ctx.resume()
      const now = ctx.currentTime + 0.05
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.type = 'sine'
        osc.frequency.value = 880
        const t = now + i * 0.5
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(0.3, t + 0.03)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)
        osc.start(t)
        osc.stop(t + 0.45)
      }
    } catch { /* الصوت مش متاح */ }
    try {
      if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400])
    } catch { /* ignore */ }
  }
  // مزامنة حية للرحلات من Firestore — طلبات العملاء توصل للسواق فوراً
  useEffect(() => {
    if (!firebaseEnabled) return
    return subscribeRides((remote) => {
      setState((s) => {
        const merged = mergeRides(s.rides, remote)
        return merged === s.rides ? s : { ...s, rides: merged }
      })
    })
  }, [])
  // مزامنة حية لطلبات التحويل — طلب سداد من سواق تاني يوصل للإدارة فوراً
  useEffect(() => {
    if (!firebaseEnabled) return
    return subscribePayments((remote) => {
      setState((s) => {
        const merged = mergePayments(s.payments, remote)
        return merged === s.payments ? s : { ...s, payments: merged }
      })
    })
  }, [])
  // مزامنة حية للسواقين المسجلين — للإدارة بس: السواق الجديد يظهر فوراً في قسم المستخدمين
  useEffect(() => {
    if (!firebaseEnabled) return
    return subscribeDrivers((remote) => {
      setState((s) => ({ ...s, drivers: remote }))
    })
  }, [])
  // مزامنة حية للعملاء المسجلين — للإدارة بس: العميل الجديد يظهر فوراً في قسم المستخدمين
  useEffect(() => {
    if (!firebaseEnabled) return
    return subscribePassengers((remote) => {
      setState((s) => ({ ...s, passengers: remote }))
    })
  }, [])
  // مزامنة حية لقايمة انتظار التوسع — للإدارة بس
  useEffect(() => {
    if (!firebaseEnabled) return
    return subscribeWaitlist((remote) => {
      setState((s) => ({ ...s, waitlist: remote }))
    })
  }, [])
  // فحص التحديثات عند الفتح: لو فيه إصدار أحدث على الريبو يظهر تنبيه جوّه التطبيق
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    fetch(VERSION_URL, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        clearTimeout(timer)
        if (cancelled || !data || typeof data.version !== 'number') return
        if (data.version <= APP_VERSION) return
        if (localStorage.getItem('indtoktok-update-dismissed') === String(data.version)) return
        setAvailableUpdate({ version: data.version, apkUrl: typeof data.apkUrl === 'string' ? data.apkUrl : '' })
      })
      .catch(() => {
        // مفيش نت أو الملف مش موجود — نتجاهل بصمت
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [])
  // رنين عند طلب جديد والكابتن فاتح التطبيق
  useEffect(() => {
    const searching = state.rides.filter((r) => r.status === 'searching')
    const prev = seenSearchingRef.current
    const fresh = searching.filter((r) => !prev.has(r.orderNo))
    seenSearchingRef.current = new Set(searching.map((r) => r.orderNo))
    if (firstRidesRef.current) {
      firstRidesRef.current = false
      return
    }
    if (fresh.length > 0 && appRole === 'driver') ring()
  }, [state.rides, appRole])
  // تنبيه لما الطرف التاني يلغي رحلة — العميل يعرف إن الكابتن لغى (والعكس) مع السبب
  useEffect(() => {
    const cancelled = state.rides.filter((r) => r.status === 'cancelled')
    const fresh = cancelled.filter((r) => !seenCancelledRef.current.has(r.orderNo))
    seenCancelledRef.current = new Set(cancelled.map((r) => r.orderNo))
    if (firstCancelledRef.current) {
      firstCancelledRef.current = false
      return
    }
    for (const r of fresh) {
      const mineAsPassenger = state.passenger?.phone === r.passengerPhone
      const mineAsDriver = state.driver.code === r.driverCode
      if (r.cancelledBy === 'driver' && mineAsPassenger) {
        showNotice(`الكابتن لغى الرحلة ${r.orderNo}${r.cancelReason ? `: ${r.cancelReason}` : '.'}`)
      } else if (r.cancelledBy === 'passenger' && mineAsDriver) {
        showNotice(`العميل لغى الرحلة ${r.orderNo}.`)
      }
    }
  }, [state.rides, appRole])

  // استرجاع بيانات العميل لو اتمسحت من الموبايل (إعادة تثبيت):
  // الرقم الموثق موجود أصلاً — فالملف بيتعمل فوراً من الرقم نفسه،
  // والاسم والصورة والتقييم بييجوا من نسخة السيرفر لو موجودة.
  // كده نموذج التسجيل ميرجعش يظهر تاني لرقم متوثق.
  useEffect(() => {
    const phone = verifiedPhones.passenger || state.passenger?.phone
    if (!phone) return
    const p = state.passenger
    // مفيش ملف محلي أصلاً والرقم موثق: أنشئ الملف فوراً من الرقم
    if (!p) {
      const profile = {
        name: 'عميل',
        phone,
        code: clientCodeForPhone(phone),
        phoneVerified: true,
        photoUrl: null as string | null,
        ratingAvg: 0,
        ratingCount: 0,
        createdAt: Date.now(),
      }
      update({ passenger: profile })
      if (firebaseEnabled) {
        void loadDoc('passengers', phone).then((doc) => {
          if (!doc) {
            void saveDoc('passengers', phone, profile)
            return
          }
          update({
            passenger: {
              ...profile,
              name: (doc.name as string) || 'عميل',
              photoUrl: (doc.photoUrl as string | null) ?? null,
              ratingAvg: (doc.ratingAvg as number) ?? 0,
              ratingCount: (doc.ratingCount as number) ?? 0,
              createdAt: (doc.createdAt as number) ?? 0,
            },
          })
        })
      }
      return
    }
    if (!firebaseEnabled) return
    if (p.name !== 'عميل' && p.photoUrl && p.ratingCount > 0) return
    let cancelled = false
    void loadDoc('passengers', phone).then((doc) => {
      if (cancelled || !doc) return
      const cur = state.passenger
      const merged = {
        name: cur && cur.name !== 'عميل' ? cur.name : (doc.name as string) || cur?.name || 'عميل',
        phone,
        code: clientCodeForPhone(phone),
        phoneVerified: true,
        photoUrl: cur?.photoUrl ?? (doc.photoUrl as string | null) ?? null,
        ratingAvg: cur && cur.ratingCount > 0 ? cur.ratingAvg : (doc.ratingAvg as number) ?? 0,
        ratingCount: cur && cur.ratingCount > 0 ? cur.ratingCount : (doc.ratingCount as number) ?? 0,
        createdAt: cur?.createdAt ?? (doc.createdAt as number) ?? 0,
      }
      update({ passenger: merged })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifiedPhones.passenger, state.passenger?.phone])

  // استرجاع بيانات الكابتن من السيرفر (التقييم والمديونية بيتحدثوا من الطرف التاني):
  // التقييم اللي يديه العميل والخصم اللي يعمله الأدمن يوصلوا لملف السواق على جهازه
  useEffect(() => {
    const code = state.driver.code
    if (!code || !firebaseEnabled) return
    let cancelled = false
    void loadDoc('drivers', code).then((doc) => {
      if (cancelled || !doc) return
      const cur = stateRef.current.driver
      update({
        driver: {
          ...cur,
          ratingAvg: (doc.ratingAvg as number) ?? cur.ratingAvg,
          ratingCount: (doc.ratingCount as number) ?? cur.ratingCount,
          debt: (doc.debt as number) ?? cur.debt,
          totalPaid: (doc.totalPaid as number) ?? cur.totalPaid,
          balance: (doc.balance as number) ?? cur.balance ?? 0,
          name: cur.name || (doc.name as string) || cur.name,
          photoUrl: cur.photoUrl ?? (doc.photoUrl as string | null) ?? null,
        },
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.driver.code])

  // مشاركة موقع السواق إجبارية وهو متاح — من غير موقع حقيقي مفيش طلبات ولا مسافات
  useEffect(() => {
    if (!state.driver.online) return
    const tick = () => {
      navigator.geolocation?.getCurrentPosition(
        (pos) => {
          setState((s) => ({
            ...s,
            driver: {
              ...s.driver,
              currentLat: pos.coords.latitude,
              currentLng: pos.coords.longitude,
            },
            rides: s.rides.map((r) =>
              r.status === 'matched' || r.status === 'driver_arrived'
                ? {
                    ...r,
                    driverLat: pos.coords.latitude,
                    driverLng: pos.coords.longitude,
                    driverLocAt: Date.now(),
                  }
                : r,
            ),
          }))
        },
        () => {
          // الموقع مقفول أو مفيش GPS: بنسيب آخر موقع معروف زي ما هو — مفيش حركة وهمية
        },
        { enableHighAccuracy: true },
      )
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [state.driver.online])

  function update(patch: Partial<AppState>) {
    setState((s) => ({ ...s, ...patch }))
  }

  function showNotice(msg: string) {
    setNotice(msg)
    setTimeout(() => setNotice(''), 5000)
  }

  // ---- GPS: موقعي الحالي ----
  function useMyLocation(target: 'pickup' | 'destination') {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const ll: LatLng = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          label: 'موقعي الحالي',
        }
        if (target === 'pickup') {
          setPickup(ll)
          setPickupLabel('موقعي الحالي')
        } else {
          setDestination(ll)
          setDestLabel('موقعي الحالي')
        }
      },
      () => showNotice('مش قادر أوصل للـ GPS — حدد النقطة على الخريطة.'),
      { enableHighAccuracy: true },
    )
  }

  function onMapPick(lat: number, lng: number) {
    const ll: LatLng = { lat, lng, label: `${lat.toFixed(4)}, ${lng.toFixed(4)}` }
    if (pickMode === 'pickup') {
      setPickup(ll)
      setPickupLabel(ll.label)
    } else if (pickMode === 'destination') {
      setDestination(ll)
      setDestLabel(ll.label)
    }
  }

  /** عميل من برّه النطاق داس «بلّغني» — نسجل رقمه ومنطقته في قايمة الانتظار عند الأدمن */
  function notifyMe() {
    if (!state.passenger || !outOfArea) return
    const entry = {
      phone: state.passenger.phone,
      name: state.passenger.name,
      code: state.passenger.code,
      pickupLabel: outOfArea.pickupLabel,
      destLabel: outOfArea.destLabel,
      createdAt: Date.now(),
    }
    void saveDoc('waitlist', `${state.passenger.phone}-${Date.now()}`, entry)
    setOutOfArea(null)
    showNotice('تمام! سجلنا رقمك وهنبلغك أول ما نفتح في منطقتك 👍')
  }

  // ---- طلب رحلة ----
  async function requestRide() {
    if (!state.passenger) {
      showNotice('سجل برقم تليفونك الأول.')
      return
    }
    setRequestBusy(true)
    try {
      // لو العميل كتب اسم المكان بس من غير ما يحدده على الخريطة، نجيب إحداثياته بالبحث
      let from = pickup
      let to = destination
      if (!from && pickupLabel.trim()) {
        from = await resolvePlace(pickupLabel.trim())
        if (from) setPickup(from)
      }
      if (!to && destLabel.trim()) {
        to = await resolvePlace(destLabel.trim())
        if (to) setDestination(to)
      }
      if (!from || !to) {
        showNotice('حدد نقطة الركوب والوجهة الأول — اكتب اسم المكان أو حدّده على الخريطة.')
        return
      }
      // النطاق: أسيوط وسوهاج بس — نقطة الركوب والوجهة لازم الاتنين جوّه النطاق
      const [fromOk, toOk] = await Promise.all([isInServiceArea(from.lat, from.lng), isInServiceArea(to.lat, to.lng)])
      if (!fromOk || !toOk) {
        setOutOfArea({ pickupLabel: from.label, destLabel: to.label })
        return
      }
      const orderNum = state.lastOrderNum + 1
      const ride: Ride = {
        orderNo: `#${orderNum}`,
        passengerCode: state.passenger.code,
        passengerName: state.passenger.name,
        passengerPhone: state.passenger.phone,
        passengerRating: state.passenger.ratingAvg,
        pickup: from,
        destination: to,
      fare,
      status: 'searching',
      driverCode: null,
      driverName: null,
      driverPhone: null,
      driverLat: null,
      driverLng: null,
      driverLocAt: null,
      offers: [],
      createdAt: Date.now(),
      acceptedAt: null,
      arrivedAt: null,
      completedAt: null,
      cancelReason: null,
      cancelledBy: null,
      passengerPhotoUrl: state.passenger?.photoUrl ?? null,
      driverPhotoUrl: null,
      passengerRatingForDriver: null,
      driverRatingForPassenger: null,
    }
    update({ rides: [...state.rides, ride], lastOrderNum: orderNum })
    void saveDoc('rides', ride.orderNo, ride as unknown as Record<string, unknown>)
    showNotice(`طلبك ${ride.orderNo} اتبعت للسواقين القريبين.`)
    } finally {
      setRequestBusy(false)
    }
  }

  function acceptOffer(ride: Ride, offer: Offer) {
    const updated: Ride = {
      ...ride,
      status: 'matched',
      // السعر المتفق عليه هو سعر العرض اللي اختاره العميل (مش سعره الأصلي)
      fare: offer.price,
      driverCode: offer.driverCode,
      driverName: offer.driverName,
      driverPhone: offer.driverPhone,
      driverLat: ride.pickup.lat + 0.012,
      driverLng: ride.pickup.lng + 0.012,
      driverLocAt: Date.now(),
      acceptedAt: Date.now(),
      driverPhotoUrl: offer.driverPhotoUrl ?? null,
    }
    update({ rides: state.rides.map((r) => (r.orderNo === ride.orderNo ? updated : r)) })
    void saveDoc('rides', ride.orderNo, updated as unknown as Record<string, unknown>)
    showNotice(`الكابتن ${offer.driverName} في الطريق إليك.`)
  }

  /** السواق يبعت عرض بسعره (مفاوضة) — السعر اللي يكتبه هو عرضه للعميل. */
  function sendDriverOffer(ride: Ride, price: number) {
    const offer: Offer = {
      id: `${ride.orderNo}-${state.driver.code}`,
      rideId: ride.orderNo,
      driverCode: state.driver.code,
      driverName: state.driver.name || 'الكابتن',
      driverPhone: state.driver.phone,
      driverRating: state.driver.ratingAvg,
      driverPhotoUrl: state.driver.photoUrl ?? null,
      driverLat: state.driver.currentLat ?? null,
      driverLng: state.driver.currentLng ?? null,
      price,
      etaMinutes: 5,
      plate: state.driver.plate,
      color: state.driver.color,
      model: state.driver.model,
    }
    const updatedRide: Ride = { ...ride, offers: [...ride.offers.filter((o) => o.driverCode !== state.driver.code), offer] }
    update({ rides: state.rides.map((x) => x.orderNo === ride.orderNo ? updatedRide : x) })
    void saveDoc('rides', ride.orderNo, updatedRide as unknown as Record<string, unknown>)
    showNotice(price === ride.fare ? 'قبلت بالسعر — عرضك اتبعت للعميل.' : `عرضك (${money(price)}) اتبعت للعميل.`)
  }

  /** العميل يحدّث سعره المقترح وهو مستني عروض (يرفعه عشان يجذب سواقين). */
  function updatePassengerFare(ride: Ride, newFare: number) {
    if (ride.status !== 'searching') return
    const updated: Ride = { ...ride, fare: newFare }
    update({ rides: state.rides.map((r) => (r.orderNo === ride.orderNo ? updated : r)) })
    void saveDoc('rides', ride.orderNo, updated as unknown as Record<string, unknown>)
    showNotice(`سعرك المقترح بقى ${money(newFare)} — السواقين هيشوفوه.`)
  }

  /** إلغاء رحلة مع سبب — السبب بيظهر للطرف التاني وفي السجل. */
  function cancelRide(orderNo: string, reason: string, by: 'driver' | 'passenger') {
    const ride = state.rides.find((r) => r.orderNo === orderNo)
    if (!ride) return
    const next: Ride = { ...ride, status: 'cancelled', cancelReason: reason, cancelledBy: by }
    update({ rides: state.rides.map((r) => (r.orderNo === orderNo ? next : r)) })
    void saveDoc('rides', orderNo, next as unknown as Record<string, unknown>)
    setCancelTarget(null)
    setCancelReason('')
    setCancelReasonOther('')
    showNotice('الرحلة اتلغت.')
  }

  function setRideStatus(orderNo: string, status: Ride['status']) {
    const ride = state.rides.find((r) => r.orderNo === orderNo)
    if (!ride) return
    const next: Ride = { ...ride, status }
    if (status === 'driver_arrived' && !next.arrivedAt) next.arrivedAt = Date.now()
    if (status === 'completed' && !next.completedAt) next.completedAt = Date.now()
    const rides = state.rides.map((r) => (r.orderNo === orderNo ? next : r))
    // عمولة 5% من الرحلة المكتملة بتتسجل مديونية على ملف السواق نفسه
    // وبتتحفظ في مستنده على السيرفر — عشان تظهر على أي جهاز
    let driver = state.driver
    if (status === 'completed') {
      // عمولة 5% — بتتخصم من رصيد المحفظة الأول، والباقي بس بيتسجل مديونية
      const commission = commissionFor(ride.fare)
      const fromBalance = Math.min(driver.balance ?? 0, commission)
      driver = {
        ...driver,
        balance: Math.round(((driver.balance ?? 0) - fromBalance) * 100) / 100,
        debt: Math.round((driver.debt + commission - fromBalance) * 100) / 100,
      }
      void saveDoc('drivers', driver.code, driver as unknown as Record<string, unknown>)
    }
    update({ rides, driver })
    void saveDoc('rides', orderNo, next as unknown as Record<string, unknown>)
  }

  function submitRating(orderNo: string, by: 'passenger' | 'driver', value: number) {
    const ride = state.rides.find((r) => r.orderNo === orderNo)
    if (!ride) return
    // منع التقييم مرتين لنفس الرحلة — كل ضغطة كانت بتزود العداد وتخرب المتوسط
    if (by === 'passenger' && ride.passengerRatingForDriver != null) {
      showNotice('تقييمك للكابتن اتسجل قبل كده.')
      return
    }
    if (by === 'driver' && ride.driverRatingForPassenger != null) {
      showNotice('تقييمك للعميل اتسجل قبل كده.')
      return
    }
    const updated: Ride = by === 'passenger'
      ? { ...ride, passengerRatingForDriver: value }
      : { ...ride, driverRatingForPassenger: value }
    update({ rides: state.rides.map((r) => (r.orderNo === orderNo ? updated : r)) })
    void saveDoc('rides', orderNo, updated as unknown as Record<string, unknown>)
    // متوسط المقصود بالتقييم بيتحدث في مستنده على السيرفر (مش في ملف جهازك)
    if (by === 'passenger' && ride.driverCode) {
      void loadDoc('drivers', ride.driverCode).then((doc) => {
        const avg = (doc?.ratingAvg as number) ?? state.driver.ratingAvg ?? 0
        const count = (doc?.ratingCount as number) ?? state.driver.ratingCount ?? 0
        const n = count + 1
        const next = {
          ...((doc ?? {}) as Record<string, unknown>),
          ratingAvg: Math.round(((avg * count + value) / n) * 10) / 10,
          ratingCount: n,
        }
        void saveDoc('drivers', ride.driverCode!, next)
        if (state.driver.code === ride.driverCode) {
          update({ driver: { ...state.driver, ratingAvg: next.ratingAvg as number, ratingCount: n } })
        }
      })
    }
    if (by === 'driver' && ride.passengerPhone) {
      void loadDoc('passengers', ride.passengerPhone).then((doc) => {
        const avg = (doc?.ratingAvg as number) ?? state.passenger?.ratingAvg ?? 0
        const count = (doc?.ratingCount as number) ?? state.passenger?.ratingCount ?? 0
        const n = count + 1
        const next = {
          ...((doc ?? {}) as Record<string, unknown>),
          ratingAvg: Math.round(((avg * count + value) / n) * 10) / 10,
          ratingCount: n,
        }
        void saveDoc('passengers', ride.passengerPhone!, next)
        if (state.passenger?.phone === ride.passengerPhone) {
          update({ passenger: { ...state.passenger, ratingAvg: next.ratingAvg as number, ratingCount: n } })
        }
      })
    }
    showNotice('شكراً! تقييمك اتسجل.')
  }

  // ---- OTP حقيقي — Firebase Phone Auth (الكود يوصل SMS، مش بيظهر هنا) ----
  async function requestOtp() {
    const phone = regPhone.trim()
    if (phone.length < 10) {
      showNotice('اكتب رقم تليفون صحيح (11 رقم).')
      return
    }
    setOtpBusy(true)
    // رد فوري للمستخدم عشان يعرف إن الضغطة اتسجلت
    showNotice('جارٍ إرسال الكود…')
    try {
      const res = await sendOtpCode(phone)
      if (!res.ok) {
        showNotice(res.message)
        return
      }
      // تحقق فوري (أندرويد): الرقم اتأكد من غير SMS — كمّل التسجيل على طول
      if (res.autoVerified) {
        void finishAuth()
        showNotice(res.message)
        return
      }
      setOtpSent(true)
      showNotice(res.message)
    } catch (e) {
      // أي خطأ غير متوقع لازم يظهر للمستخدم بدل ما الزرار يسكت خالص
      console.warn('requestOtp failed:', e)
      const code =
        typeof e === 'object' && e !== null && 'code' in e
          ? String((e as { code: unknown }).code)
          : ''
      const msg =
        typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : ''
      // بنعرض نص الخطأ نفسه عشان نعرف السبب الحقيقي من لقطة الشاشة
      showNotice(
        msg
          ? `مشكلة أثناء إرسال الكود: ${msg.slice(0, 220)}`
          : code
            ? `حصلت مشكلة غير متوقعة أثناء إرسال الكود — حاول تاني. (كود الخطأ: ${code})`
            : 'حصلت مشكلة غير متوقعة أثناء إرسال الكود — حاول تاني.',
      )
    } finally {
      setOtpBusy(false)
    }
  }

  /** يكمل الدخول بعد تأكيد الرقم — للسواق والعميل (يستخدمه تأكيد الكود والتحقق الفوري). */
  async function finishAuth() {
    const phone = regPhone.trim()
    const authRole: 'passenger' | 'driver' = appRole ?? 'passenger'
    saveVerifiedPhones({ ...verifiedPhones, [authRole]: phone })
    if (authRole === 'passenger') {
      const prev = state.passenger
      const samePhone = prev?.phone === phone
      // لو مفيش بيانات محلية (إعادة تثبيت)، اقرأ نسخة السيرفر الأول
      // قبل ما تكتب فوقها — عشان الاسم والصورة والتقييم ميرجعوش صفر
      const server = !prev ? await loadDoc('passengers', phone) : null
      const profile = {
        name: prev?.name || (server?.name as string) || 'عميل',
        phone,
        code: clientCodeForPhone(phone),
        phoneVerified: true,
        photoUrl: prev?.photoUrl ?? (server?.photoUrl as string | null) ?? null,
        ratingAvg: samePhone ? (prev?.ratingAvg ?? 0) : (server?.ratingAvg as number) ?? 0,
        ratingCount: samePhone ? (prev?.ratingCount ?? 0) : (server?.ratingCount as number) ?? 0,
        // تاريخ التسجيل: لو راجع (سيرفر موجود) من غير تاريخ يفضل 0 (قديم)؛ لو أول مرة يتحط دلوقتي
        createdAt: prev?.createdAt ?? (server ? ((server.createdAt as number) ?? 0) : Date.now()),
      }
      update({ passenger: profile })
      void saveDoc('passengers', phone, profile)
      showNotice(`أهلاً ${profile.name}! رقمك اتأكد وكودك ${profile.code}.`)
    } else {
      const driver = { ...state.driver, phone, createdAt: state.driver.createdAt || Date.now() }
      update({ driver })
      void saveDoc('drivers', driver.code, driver as unknown as Record<string, unknown>)
      showNotice('رقمك اتأكد — أهلاً بيك يا كابتن!')
    }
    setOtpSent(false)
    setOtpInput('')
  }

  async function verifyOtp() {
    setOtpBusy(true)
    try {
      // مسار الـ Worker (textbee) يحتاج الرقم؛ مسار Firebase يتجاهله
      const res = await verifyOtpCode(otpInput, regPhone.trim())
      if (!res.ok) {
        showNotice(res.message)
        return
      }
      void finishAuth()
    } finally {
      setOtpBusy(false)
    }
  }

  // ---- المحفظة ----
  async function submitPayment() {
    const amount = parseFloat(payAmount)
    if (!amount || amount <= 0) {
      showNotice('اكتب مبلغ التحويل.')
      return
    }
    if (!payShot) {
      showNotice('ارفع صورة التحويل — إلزامية.')
      return
    }
    // الصورة بتتضغط محلياً وتتخزن Base64 داخل مستند Firestore — بدون Storage.
    let url: string
    try {
      url = await uploadImageAsDataUrl(payShot)
    } catch (e) {
      showNotice(e instanceof Error ? e.message : 'مقدرناش نجهّز صورة التحويل.')
      return
    }
    const payment = {
      id: `PAY-${Date.now()}`,
      driverCode: state.driver.code,
      driverName: state.driver.name || 'الكابتن',
      amount,
      screenshotUrl: url,
      status: 'pending' as const,
      createdAt: Date.now(),
    }
    update({ payments: [...state.payments, payment] })
    void saveDoc('payments', payment.id, payment as unknown as Record<string, unknown>)
    setPayAmount('')
    setPayShot(null)
    showNotice('طلبك اتبعت للإدارة للمراجعة.')
  }

  function reviewPayment(id: string, approve: boolean) {
    const payment = state.payments.find((p) => p.id === id)
    if (!payment) return
    // الطلب اللي اتراجع قبل كده مينفعش يتراجع تاني — الموافقة مرتين كانت بتخصم مرتين
    if (payment.status !== 'pending') {
      showNotice('الطلب ده اتراجع قبل كده.')
      return
    }
    const updatedPayment = { ...payment, status: (approve ? 'approved' : 'rejected') as 'approved' | 'rejected' }
    update({ payments: state.payments.map((p) => (p.id === id ? updatedPayment : p)) })
    void saveDoc('payments', id, updatedPayment as unknown as Record<string, unknown>)
    if (!approve) {
      showNotice('تم رفض الطلب.')
      return
    }
    // خصم المديونية من مستند السواق نفسه على السيرفر — مش من مديونية جهاز الأدمن
    // المبلغ بيسدد المديونية الأول، وأي زيادة عنها بتتحفظ رصيد في محفظة السواق
    void loadDoc('drivers', payment.driverCode).then((doc) => {
      const curDebt = (doc?.debt as number) ?? 0
      const curPaid = (doc?.totalPaid as number) ?? 0
      const curBalance = (doc?.balance as number) ?? 0
      const toDebt = Math.min(payment.amount, curDebt)
      const remainder = Math.round((payment.amount - toDebt) * 100) / 100
      const next = {
        ...((doc ?? {}) as Record<string, unknown>),
        debt: Math.round((curDebt - toDebt) * 100) / 100,
        balance: Math.round((curBalance + remainder) * 100) / 100,
        totalPaid: Math.round((curPaid + payment.amount) * 100) / 100,
      }
      void saveDoc('drivers', payment.driverCode, next)
      if (state.driver.code === payment.driverCode) {
        update({ driver: { ...state.driver, debt: next.debt as number, balance: next.balance as number, totalPaid: next.totalPaid as number } })
      }
      showNotice(remainder > 0
        ? `تمت الموافقة — المديونية اتخصمت، والزيادة ${money(remainder)} بقت رصيد في محفظة السواق.`
        : 'تمت الموافقة — المديونية اتخصمت فوراً.')
    })
  }

  async function uploadIdCard() {
    if (!idCardFile) return
    // الصورة بتتضغط محلياً وتتخزن Base64 داخل مستند السواق في Firestore — بدون Storage.
    let url: string
    try {
      url = await uploadImageAsDataUrl(idCardFile)
    } catch (e) {
      showNotice(e instanceof Error ? e.message : 'مقدرناش نجهّز صورة البطاقة.')
      return
    }
    const driver = { ...state.driver, idCardUrl: url, idCardStatus: 'pending' as const }
    update({ driver })
    void saveDoc('drivers', driver.code, driver as unknown as Record<string, unknown>)
    showNotice('صورة البطاقة اترفعت وبانتظار مراجعة الإدارة.')
  }

  // رفع الصورة الشخصية (للعميل أو الكابتن) — بتظهر للطرف التاني
  const [profilePhotoFile, setProfilePhotoFile] = useState<File | null>(null)
  async function uploadProfilePhoto(who: 'passenger' | 'driver') {
    if (!profilePhotoFile) return
    let url: string
    try {
      url = await uploadImageAsDataUrl(profilePhotoFile)
    } catch (e) {
      showNotice(e instanceof Error ? e.message : 'مقدرناش نجهّز الصورة.')
      return
    }
    if (who === 'passenger' && state.passenger) {
      const passenger = { ...state.passenger, photoUrl: url }
      update({ passenger })
      void saveDoc('passengers', passenger.phone, passenger)
      showNotice('صورتك اتحفظت وهتظهر للكابتن.')
    } else {
      const driver = { ...state.driver, photoUrl: url }
      update({ driver })
      void saveDoc('drivers', driver.code, driver as unknown as Record<string, unknown>)
      showNotice('صورتك اتحفظت وهتظهر للعميل.')
    }
    setProfilePhotoFile(null)
  }

  const filteredRides = state.rides.filter((r) => {
    const q = search.trim()
    if (!q) return true
    return [r.orderNo, r.passengerCode, r.driverCode || '', r.passengerName, r.passengerPhone]
      .join(' ')
      .includes(q)
  })

  // الطلبات المتاحة مرتبة بالأقرب للسواق أولاً (اللي من غير موقع يفضل بترتيبه)
  const driverPos = state.driver.currentLat != null && state.driver.currentLng != null
    ? { lat: state.driver.currentLat, lng: state.driver.currentLng }
    : null
  const availableRides = state.rides
    .filter((r) => r.status === 'searching')
    .sort((a, b) => {
      if (!driverPos) return 0
      return distanceKm(driverPos, a.pickup) - distanceKm(driverPos, b.pickup)
    })

  // الكابتن مينفعش يبقى متاح من غير موقع حقيقي — لازم GPS شغال وإذن الموقع متوافق عليه
  async function goOnlineToggle() {
    if (state.driver.online) {
      update({ driver: { ...state.driver, online: false } })
      return
    }
    try {
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 })
      update({
        driver: {
          ...state.driver,
          online: true,
          sharingLocation: true,
          currentLat: pos.coords.latitude,
          currentLng: pos.coords.longitude,
        },
      })
    } catch {
      showNotice('لازم تشغّل الموقع (GPS) وتدّي التطبيق إذن الموقع — من غيره مش هتقدر تبقى متاح وتستقبل طلبات.')
    }
  }

  // الصفحة الرئيسية للكابتن: الطلبات المتاحة للقبول فقط
  const driverView = (
    <div className="card">
      <h2><span className="icon-chip"><IconList /></span>الطلبات المتاحة</h2>
      <button
        className={`online-toggle ${state.driver.online ? 'on' : 'off'}`}
        onClick={() => void goOnlineToggle()}
      >
        <span className="switch"><span className="knob" /></span>
        <span className="online-label">
          {state.driver.online ? '🟢 متاح لقبول الطلبات' : '⚪ مش متاح للعمل — دوس عشان تستقبل طلبات'}
        </span>
      </button>
      <button className="link-btn" onClick={ring}>جرّب صوت التنبيه</button>
      {state.driver.online && (state.driver.currentLat == null || state.driver.currentLng == null) && (
        <p className="warn">⚠️ موقعك مش واصل — شغّل الـ GPS عشان المسافات والطلبات تظهر صح.</p>
      )}
      {isDebtBlocked(state.driver.debt) && (
        <p className="warn">⛔ وصلت لحد المديونية ({money(MAX_DEBT_EGP)}) — مش هتستقبل رحلات جديدة لحد ما تسدد.</p>
      )}
      {availableRides.length === 0 && <p>مفيش طلبات دلوقتي.</p>}
      {availableRides.map((r) => (
        <div key={r.orderNo} className="request-card">
          <div className="request-head">
            {avatar(r.passengerPhotoUrl, r.passengerName)}
            <div className="who">
              <b>{r.passengerName}</b> <span className="code">({r.passengerCode})</span>
              <div className="stars-line">★ {r.passengerRating}</div>
            </div>
            <span className="order-badge">{r.orderNo}</span>
          </div>
          <div className="map-hero-card">
            <MapView
              height={180}
              pickup={r.pickup}
              destination={r.destination}
              driver={state.driver.currentLat && state.driver.currentLng ? { lat: state.driver.currentLat, lng: state.driver.currentLng, label: 'أنت' } : null}
              pickMode="view"
              onPick={() => {}}
            />
          </div>
          <div className="request-route">
            <div className="route-row">
              <span className="route-ic gray"><IconPin /></span>
              <div>
                <div className="route-label">نقطة الركوب</div>
                <div className="route-value">{r.pickup.label}</div>
                {state.driver.currentLat && state.driver.currentLng && (
                  <div className="muted">على بعد {distanceKm({ lat: state.driver.currentLat, lng: state.driver.currentLng }, r.pickup)} كم منك</div>
                )}
              </div>
            </div>
            <div className="route-row">
              <span className="route-ic orange"><IconPin /></span>
              <div>
                <div className="route-label">الوجهة</div>
                <div className="route-value">{r.destination.label}</div>
                <div className="muted">المسافة من العميل للوجهة: {distanceKm(r.pickup, r.destination)} كم</div>
              </div>
            </div>
          </div>
          <div className="request-fare">
            <span className="fare-label">السعر المقترح</span>
            <span className="fare-value">{money(r.fare)}</span>
          </div>
          <div className="request-actions">
            {r.offers.filter((o) => o.driverCode === state.driver.code).map((o) => (
              <p key={o.id} className="muted">عرضك: <b>{money(o.price)}</b> — مستني العميل يختار.</p>
            ))}
            <div className="row">
              <input
                className="fare-number"
                inputMode="numeric"
                style={{ width: 90 }}
                value={offerPrices[r.orderNo] ?? String(r.fare)}
                onChange={(e) => setOfferPrices({ ...offerPrices, [r.orderNo]: e.target.value.replace(/[^0-9]/g, '') })}
                aria-label="سعرك"
              />
              <span>جنيه</span>
              <button className="btn" disabled={isDebtBlocked(state.driver.debt) || !state.driver.online} onClick={() => sendDriverOffer(r, Math.min(FARE_MAX, Math.max(FARE_MIN, parseInt(offerPrices[r.orderNo] || String(r.fare), 10) || r.fare)))}>ابعت عرضي</button>
            </div>
            <button className="btn" disabled={isDebtBlocked(state.driver.debt) || !state.driver.online} onClick={() => sendDriverOffer(r, r.fare)}>اقبل بالسعر ({money(r.fare)})</button>
          </div>
          <p className="muted request-time">وقت الطلب: {fmtTime(r.createdAt)}</p>
        </div>
      ))}
    </div>
  )

  // رحلات الكابتن: الحالية + السابقة (مكتملة أو ملغاة)
  const driverTripsView = (
    <div className="card">
      <h2><span className="icon-chip"><IconHistory /></span>رحلاتي</h2>
      <h3>رحلتي الحالية</h3>
      {myCurrentRide ? (
        <div className="request-card">
          <div className="map-hero-card">
            <MapView
              height={340}
              pickup={myCurrentRide.pickup}
              destination={driverArrived ? myCurrentRide.destination : null}
              driver={state.driver.currentLat && state.driver.currentLng ? { lat: state.driver.currentLat, lng: state.driver.currentLng, label: 'أنت' } : null}
              pickMode="view"
              onPick={() => {}}
            />
          </div>
          <div className="request-sheet">
            <div className="request-head">
              {avatar(myCurrentRide.passengerPhotoUrl, myCurrentRide.passengerName)}
              <div className="who">
                <b>{myCurrentRide.passengerName}</b>
                <div className="stars-line">{rideStatusLabel(myCurrentRide.status)}</div>
              </div>
              <span className="order-badge">{myCurrentRide.orderNo}</span>
            </div>
            <div className="request-route">
              <div className="route-row">
                <span className="route-ic green"><IconPin /></span>
                <div>
                  <div className="route-label">نقطة الركوب</div>
                  <div className="route-value">{myCurrentRide.pickup.label}</div>
                </div>
              </div>
              <div className="route-row">
                <span className="route-ic orange"><IconPin /></span>
                <div>
                  <div className="route-label">الوجهة</div>
                  <div className="route-value">{myCurrentRide.destination.label}</div>
                </div>
              </div>
            </div>
          <div className="request-actions">
            <a className="link" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${myCurrentRide.pickup.lat},${myCurrentRide.pickup.lng}`}>الاتجاهات لنقطة الركوب ↗</a>
            {driverArrived && (
              <>
                <br />
                <a className="link" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${myCurrentRide.destination.lat},${myCurrentRide.destination.lng}`}>📍 الاتجاهات للوجهة ↗</a>
                <p className="notice">وصلت للعميل — لوكيشن الوجهة ظهر دلوقتي على الخريطة.</p>
              </>
            )}
            {myCurrentRide.driverLat && myCurrentRide.driverLng && (
              <p className="muted">العميل على بعد {distanceKm({ lat: myCurrentRide.driverLat, lng: myCurrentRide.driverLng }, myCurrentRide.pickup)} كم منك</p>
            )}
            <a className="btn" href={`tel:${myCurrentRide.passengerPhone}`}>📞 اتصل بالعميل — {myCurrentRide.passengerPhone}</a>
            {rideTimes(myCurrentRide)}
          </div>
          <div className="row">
            {myCurrentRide.status === 'matched' && <button className="btn" onClick={() => setRideStatus(myCurrentRide.orderNo, 'driver_arrived')}>وصلت للعميل</button>}
            {myCurrentRide.status === 'driver_arrived' && <button className="btn" onClick={() => setRideStatus(myCurrentRide.orderNo, 'on_trip')}>ابدأ الرحلة</button>}
            {myCurrentRide.status === 'on_trip' && <button className="btn" onClick={() => setRideStatus(myCurrentRide.orderNo, 'completed')}>وصلنا — إنهاء الرحلة</button>}
            <button className="btn danger" onClick={() => setCancelTarget(myCurrentRide.orderNo)}>إلغاء الرحلة</button>
          </div>
          {cancelTarget === myCurrentRide.orderNo && (
            <div className="box">
              <h3>سبب الإلغاء</h3>
              {CANCEL_REASONS.map((reason) => (
                <label key={reason} className="row">
                  <input type="radio" name="cancel-reason" checked={cancelReason === reason} onChange={() => setCancelReason(reason)} /> {reason}
                </label>
              ))}
              {cancelReason === 'سبب آخر…' && (
                <input placeholder="اكتب السبب" value={cancelReasonOther} onChange={(e) => setCancelReasonOther(e.target.value)} />
              )}
              <div className="row">
                <button className="btn danger" disabled={!cancelReason || (cancelReason === 'سبب آخر…' && !cancelReasonOther.trim())} onClick={() => cancelRide(myCurrentRide.orderNo, cancelReason === 'سبب آخر…' ? cancelReasonOther.trim() : cancelReason, 'driver')}>تأكيد الإلغاء</button>
                <button className="link-btn" onClick={() => { setCancelTarget(null); setCancelReason(''); setCancelReasonOther('') }}>رجوع</button>
              </div>
            </div>
          )}
          </div>
        </div>
      ) : (
        <p>مفيش رحلة شغالة دلوقتي.</p>
      )}
      <h3>رحلات سابقة</h3>
      {myPastRides.length === 0 && <p>لسه مفيش رحلات مكتملة أو ملغاة.</p>}
      {myPastRides.map((r) => (
        <div key={r.orderNo} className="ride">
          {avatar(r.passengerPhotoUrl, r.passengerName)} <b>{r.orderNo}</b> — {r.passengerName} — {rideStatusLabel(r.status)} — <b>{money(r.fare)}</b>
          {rideTimes(r)}
          {r.status === 'cancelled' && r.cancelReason && <p className="muted">سبب الإلغاء: {r.cancelReason}</p>}
          {r.status === 'completed' && r.driverRatingForPassenger === null && (
            <div>
              <p>قيّم العميل بعد الرحلة:</p>
              {stars(ratePassenger, (n) => { setRatePassenger(n); submitRating(r.orderNo, 'driver', n) })}
            </div>
          )}
        </div>
      ))}
    </div>
  )

  // الملف الشخصي للكابتن: بياناته وبطاقته وصورته
  const driverProfileView = (
    <div className="card">
      <h2><span className="icon-chip"><IconUser /></span>الملف الشخصي</h2>
      {driverFormOpen ? (
        <>
          <div className="grid">
            <input placeholder="الاسم" value={state.driver.name} onChange={(e) => update({ driver: { ...state.driver, name: e.target.value } })} />
            <input placeholder="رقم التليفون" value={state.driver.phone} readOnly={!!verifiedPhones.driver} onChange={(e) => update({ driver: { ...state.driver, phone: e.target.value } })} />
            {verifiedPhones.driver && (
              <p className="muted">رقمك موثق ✓ — <button className="link-btn" onClick={clearDriverVerification}>تغيير الرقم</button></p>
            )}
            <input placeholder="رقم اللوحة" value={state.driver.plate} onChange={(e) => update({ driver: { ...state.driver, plate: e.target.value } })} />
            <input placeholder="اللون" value={state.driver.color} onChange={(e) => update({ driver: { ...state.driver, color: e.target.value } })} />
            <input placeholder="الموديل" value={state.driver.model} onChange={(e) => update({ driver: { ...state.driver, model: e.target.value } })} />
          </div>
          <p>كود السواق: <b>{state.driver.code}</b> — التقييم: {state.driver.ratingAvg} ★ ({state.driver.ratingCount})</p>
          <h3>صورة البطاقة الشخصية</h3>
          <p>الصورة بتتضغط تلقائياً قبل الرفع (الحد حوالي 250 كيلوبايت) وتتحفظ في حسابك.</p>
          <PhotoPicker onPick={setIdCardFile} label="اختار صورة البطاقة" />
          <button className="btn" onClick={uploadIdCard} disabled={!idCardFile}>رفع صورة البطاقة</button>
          {state.driver.idCardUrl && (
            <div>
              <img src={state.driver.idCardUrl} alt="صورة البطاقة" className="shot" />
              <p>حالة البطاقة: {state.driver.idCardStatus === 'pending' ? 'بانتظار المراجعة' : state.driver.idCardStatus}</p>
            </div>
          )}
          <h3>صورتي الشخصية (بتظهر للعميل)</h3>
          {state.driver.photoUrl && <img src={state.driver.photoUrl} alt="صورتي الشخصية" className="avatar avatar-lg" />}
          <PhotoPicker onPick={setProfilePhotoFile} label="اختار صورتي" />
          <button className="btn" onClick={() => uploadProfilePhoto('driver')} disabled={!profilePhotoFile}>حفظ صورتي</button>
          <button className="btn" onClick={() => setDriverFormOpen(false)} disabled={!state.driver.name.trim() || !state.driver.phone.trim()}>حفظ بياناتي</button>
        </>
      ) : (
        <div className="saved-bar">
          {avatar(state.driver.photoUrl, state.driver.name)} {state.driver.name} — {state.driver.phone} — كودك: <b>{state.driver.code}</b>
          {state.driver.idCardUrl && <span> — البطاقة: {state.driver.idCardStatus === 'pending' ? 'بانتظار المراجعة' : state.driver.idCardStatus}</span>}
          <button className="link-btn" onClick={() => setDriverFormOpen(true)}>تعديل بياناتي</button>
        </div>
      )}
      <p className="muted">📍 موقعك بيشارك تلقائياً وانت متاح لقبول الطلبات — لازم عشان تشوف المسافة للعميل والعملاء يشوفوك على الخريطة، ومش هتقدر تبقى متاح والموقع مقفول.</p>
      <button className="btn danger" onClick={clearDriverVerification}>تسجيل خروج</button>
    </div>
  )

  // اقتراحات العناوين أثناء الكتابة — بعد 500ms من آخر حرف (من غير ما نضرب السيرفر مع كل حرف)
  useEffect(() => {
    const q = pickupLabel.trim()
    if (q.length < 3 || (pickup && pickup.label === q)) { setPickupSugg([]); return }
    const t = setTimeout(() => {
      suggAbortRef.current?.abort()
      const ctrl = new AbortController()
      suggAbortRef.current = ctrl
      void searchPlaces(q, ctrl.signal).then((res) => setPickupSugg(res))
    }, 500)
    return () => clearTimeout(t)
  }, [pickupLabel])
  useEffect(() => {
    const q = destLabel.trim()
    if (q.length < 3 || (destination && destination.label === q)) { setDestSugg([]); return }
    const t = setTimeout(() => {
      suggAbortRef.current?.abort()
      const ctrl = new AbortController()
      suggAbortRef.current = ctrl
      void searchPlaces(q, ctrl.signal).then((res) => setDestSugg(res))
    }, 500)
    return () => clearTimeout(t)
  }, [destLabel])
  /** العميل اختار اقتراح من القايمة — يتعبّى العنوان والإحداثيات على طول */
  function pickSuggestion(which: 'pickup' | 'destination', s: PlaceSuggestion) {
    const ll: LatLng = { lat: s.lat, lng: s.lng, label: s.label }
    if (which === 'pickup') {
      setPickup(ll)
      setPickupLabel(s.label)
      setPickupSugg([])
    } else {
      setDestination(ll)
      setDestLabel(s.label)
      setDestSugg([])
    }
  }

  // الكباتن المتاحين على خريطة العميل — أونلاين ومشاركين موقعهم
  const onlineDrivers = useMemo(
    () =>
      state.drivers
        .filter((d) => d.online && d.currentLat != null && d.currentLng != null)
        .map((d) => ({ lat: d.currentLat as number, lng: d.currentLng as number, label: d.name })),
    [state.drivers],
  )
  // عروض السواقين مرتبة بالأقرب للعميل أولاً (اللي من غير موقع في الآخر)
  const offersByDistance = (ride: Ride) =>
    [...ride.offers].sort((a, b) => {
      const da = a.driverLat != null && a.driverLng != null ? distanceKm(ride.pickup, { lat: a.driverLat, lng: a.driverLng }) : Infinity
      const db = b.driverLat != null && b.driverLng != null ? distanceKm(ride.pickup, { lat: b.driverLat, lng: b.driverLng }) : Infinity
      return da - db
    })

  // نموذج التسجيل برقم التليفون — مشترك بين الرئيسية والملف الشخصي
  // الصفحة الرئيسية للعميل: إنشاء طلب فقط
  const passengerView = (
    <>
      {activeRide ? (
        <>
          <div className="map-hero-full">
            <MapView
              height="46vh"
              pickup={activeRide.pickup}
              destination={activeRide.destination}
              driver={activeRide.driverLat && activeRide.driverLng ? { lat: activeRide.driverLat, lng: activeRide.driverLng, label: activeRide.driverName || 'الكابتن' } : null}
              drivers={onlineDrivers}
              pickMode="view"
              onPick={() => {}}
            />
          </div>
          <div className="card bottom-sheet">
            <div className="sheet-handle" />
            <h2><span className="icon-chip"><IconUser /></span>رحلتك — {activeRide.orderNo}</h2>
            <p><b>{rideStatusLabel(activeRide.status)}</b></p>
            {rideTimes(activeRide)}
            {activeRide.status === 'searching' && (
              <>
                <p>بندور على سواقين… سعرك المقترح: <b>{money(activeRide.fare)}</b></p>
                <div className="row">
                  <input className="fare-number" inputMode="numeric" style={{ width: 90 }} value={counterFareText} placeholder={String(activeRide.fare)} onChange={(e) => setCounterFareText(e.target.value.replace(/[^0-9]/g, ''))} aria-label="سعرك المقترح الجديد" />
                  <span>جنيه</span>
                  <button className="btn" onClick={() => { const v = parseInt(counterFareText, 10); if (v >= FARE_MIN && v <= FARE_MAX) { updatePassengerFare(activeRide, v); setCounterFareText('') } else showNotice(`السعر من ${FARE_MIN} لـ ${FARE_MAX} جنيه.`) }}>حدّث سعري</button>
                </div>
                {activeRide.offers.length === 0 && <p className="muted">لسه مفيش عروض — السواقين هيبعتوا أسعارهم هنا.</p>}
                {offersByDistance(activeRide).map((o) => (
                  <div key={o.id} className="offer">
                    {avatar(o.driverPhotoUrl, o.driverName)} <b>{o.driverName}</b> — {o.driverRating} ★ — {o.model} {o.color} ({o.plate}) — يوصل في {o.etaMinutes} دقيقة
                    {o.driverLat != null && o.driverLng != null && (
                      <> — على بعد {distanceKm(activeRide.pickup, { lat: o.driverLat, lng: o.driverLng })} كم منك</>
                    )}
                    <br />السعر: <b>{money(o.price)}</b>
                    <button className="btn" onClick={() => acceptOffer(activeRide, o)}>اختار الكابتن ده</button>
                  </div>
                ))}
                <button className="btn danger" onClick={() => cancelRide(activeRide.orderNo, 'العميل ألغى الطلب', 'passenger')}>إلغاء الطلب</button>
              </>
            )}
            {(activeRide.status === 'matched' || activeRide.status === 'driver_arrived' || activeRide.status === 'on_trip') && (
              <>
                <div className="profile-box">
                  {avatar(activeRide.driverPhotoUrl, activeRide.driverName || 'الكابتن')}
                  <div>
                    <b>الكابتن {activeRide.driverName}</b> في الطريق إليك
                    {activeRide.driverLat && activeRide.driverLng && (
                      <p className="muted">على بعد {distanceKm({ lat: activeRide.driverLat, lng: activeRide.driverLng }, activeRide.pickup)} كم منك — موقعه مباشر على الخريطة 🛺</p>
                    )}
                    {activeRide.driverLocAt && <p className="muted">موقع السواق اتحدّث {new Date(activeRide.driverLocAt).toLocaleTimeString('ar-EG')}</p>}
                  </div>
                </div>
                {activeRide.driverPhone && (
                  <a className="btn" href={`tel:${activeRide.driverPhone}`}>📞 اتصل بالكابتن — {activeRide.driverPhone}</a>
                )}
              </>
            )}
            {activeRide.status === 'completed' && (
              <div>
                <p>قيّم الكابتن بعد الرحلة (تقييمك يظهر للعميل اللي بعده):</p>
                {stars(rateDriver, (n) => { setRateDriver(n); submitRating(activeRide.orderNo, 'passenger', n) })}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="map-hero-full">
            <MapView
              height="54vh"
              pickup={pickup}
              destination={destination}
              driver={null}
              drivers={onlineDrivers}
              pickMode={pickMode}
              onPick={onMapPick}
            />
          </div>
          <div className="card bottom-sheet">
            <div className="sheet-handle" />
            <h2><span className="icon-chip"><IconUser /></span>اطلب توكتوك</h2>
            <div className="grid">
            <div>
              <label>نقطة الركوب</label>
              <div className="suggest-wrap">
                <input placeholder="منين؟" value={pickupLabel} onChange={(e) => setPickupLabel(e.target.value)} onBlur={() => setPickupSugg([])} />
                {pickupSugg.length > 0 && (
                  <div className="suggest-list">
                    {pickupSugg.map((s) => (
                      <button key={`${s.lat},${s.lng}`} type="button" className="suggest-item" onMouseDown={(e) => { e.preventDefault(); pickSuggestion('pickup', s) }}>
                        <IconPin /> {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="row">
                <button className="btn small" onClick={() => useMyLocation('pickup')}><IconPin /> موقعي الحالي</button>
                <button className={pickMode === 'pickup' ? 'btn small active' : 'btn small'} onClick={() => setPickMode('pickup')}>حدّد على الخريطة</button>
              </div>
            </div>
            <div>
              <label>الوجهة</label>
              <div className="suggest-wrap">
                <input placeholder="رايح فين؟" value={destLabel} onChange={(e) => setDestLabel(e.target.value)} onBlur={() => setDestSugg([])} />
                {destSugg.length > 0 && (
                  <div className="suggest-list">
                    {destSugg.map((s) => (
                      <button key={`${s.lat},${s.lng}`} type="button" className="suggest-item" onMouseDown={(e) => { e.preventDefault(); pickSuggestion('destination', s) }}>
                        <IconPin /> {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="row">
                <button className="btn small" onClick={() => useMyLocation('destination')}><IconPin /> موقعي الحالي</button>
                <button className={pickMode === 'destination' ? 'btn small active' : 'btn small'} onClick={() => setPickMode('destination')}>حدّد على الخريطة</button>
              </div>
            </div>
          </div>

          <p className="muted">دوس على الخريطة لتحديد {pickMode === 'pickup' ? 'نقطة الركوب' : pickMode === 'destination' ? 'الوجهة' : '—'} — أو استخدم زرار «موقعي الحالي».</p>

          <h3>سعر المشوار</h3>
          <div className="fare-stepper">
            <button className="stepper-btn" onClick={() => setFareText(String(Math.max(FARE_MIN, fare - 5)))}>−</button>
            <input
              className="fare-number"
              inputMode="numeric"
              value={fareText}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9]/g, '')
                setFareText(v)
              }}
              onBlur={() => setFareText(String(fare))}
              aria-label="سعر المشوار"
            />
            <span className="fare-unit">جنيه</span>
            <button className="stepper-btn" onClick={() => setFareText(String(Math.min(FARE_MAX, fare + 5)))}>+</button>
          </div>
          <p className="muted">من {FARE_MIN} لـ {FARE_MAX} جنيه — دوس على الرقم نفسه وعدّله.</p>
          <button className="btn big" onClick={requestRide} disabled={requestBusy}>{requestBusy ? 'بيحدد الأماكن…' : `اطلب توكتوك — ${money(fare)}`}</button>
          </div>
        </>
      )}
    </>
  )

  // الملف الشخصي للعميل: بياناته وصورته وكوده وتقييمه
  const passengerProfileView = (
    <div className="card">
      <h2><span className="icon-chip"><IconUser /></span>الملف الشخصي</h2>
      {!state.passenger ? (
        <p className="muted">جارٍ تجهيز ملفك…</p>
      ) : (
        <>
          <div className="saved-bar">
            <IconUser /> {state.passenger.name} — {state.passenger.phone} — كودك: <b>{state.passenger.code}</b> <IconCheck /> موثق
            <button className="link-btn" onClick={clearPassengerVerification}>تعديل الرقم</button>
          </div>
          <div className="profile-box">
            {avatar(state.passenger.photoUrl, state.passenger.name)}
            <div>
              <b>ملفي الشخصي — {state.passenger.name}</b>
              <p className="muted">صورتك بتظهر للكابتن لما تطلب رحلة</p>
              <input placeholder="الاسم" value={state.passenger.name} onChange={(e) => { if (state.passenger) update({ passenger: { ...state.passenger, name: e.target.value } }) }} />
              <PhotoPicker onPick={setProfilePhotoFile} label="اختار صورتي" />
              <button className="btn small" onClick={() => uploadProfilePhoto('passenger')} disabled={!profilePhotoFile}>حفظ صورتي</button>
            </div>
          </div>
          <p>تقييمك: {state.passenger.ratingAvg} ★ ({state.passenger.ratingCount})</p>
          <button className="btn danger" onClick={clearPassengerVerification}>تسجيل خروج</button>
        </>
      )}
    </div>
  )

  // طلبات العميل: كل طلباته بحالتها وأوقاتها
  const passengerTripsView = (
    <div className="card">
      <h2><span className="icon-chip"><IconList /></span>طلباتي</h2>
      {myPassengerRides.length === 0 && <p>لسه معملتش أي طلبات.</p>}
      {myPassengerRides.map((r) => (
        <div key={r.orderNo} className="ride">
          <b>{r.orderNo}</b> — {r.status === 'matched' || r.status === 'driver_arrived' || r.status === 'on_trip' ? (<>{avatar(r.driverPhotoUrl, r.driverName || 'الكابتن')} الكابتن {r.driverName}</>) : rideStatusLabel(r.status)} — <b>{money(r.fare)}</b>
          <br />من: {r.pickup.label} — إلى: {r.destination.label}
          {rideTimes(r)}
          {r.status === 'cancelled' && r.cancelReason && <p className="muted">سبب الإلغاء: {r.cancelReason}</p>}
          {r.status === 'completed' && r.passengerRatingForDriver === null && (
            <div>
              <p>قيّم الكابتن بعد الرحلة (تقييمك يظهر للعميل اللي بعده):</p>
              {stars(rateDriver, (n) => { setRateDriver(n); submitRating(r.orderNo, 'passenger', n) })}
            </div>
          )}
        </div>
      ))}
    </div>
  )

  const walletView = (
    <div className="card">
      <h2><span className="icon-chip green"><IconWallet /></span>محفظة الكابتن</h2>
      <p>المديونية الحالية: <b>{money(state.driver.debt)}</b> من حد أقصى {money(MAX_DEBT_EGP)}</p>
      <div className="progress"><div className="progress-fill" style={{ width: `${Math.min(100, (state.driver.debt / MAX_DEBT_EGP) * 100)}%` }} /></div>
      <p>رصيدك في المحفظة: <b style={{ color: 'var(--green)' }}>{money(state.driver.balance ?? 0)}</b> — لو حوّلت أكتر من مديونيتك الزيادة بتتحفظ هنا، وعمولات الرحلات الجاية (5%) بتتخصم من الرصيد ده الأول قبل ما تتسجل مديونية.</p>
      <p>إجمالي ما سددته: {money(state.driver.totalPaid)} — العمولة 5% من كل رحلة مكتملة تتسجل مديونية تلقائياً.</p>
      {isDebtBlocked(state.driver.debt) && <p className="warn">⛔ وصلت للحد الأقصى — مش هتستقبل رحلات جديدة لحد ما تسدد.</p>}
      <h3>حوّل للإدارة</h3>
      <p>محفظة الإدارة: <b>{state.admin.walletNumber || '— لم يحددها الأدمن بعد —'}</b> ({state.admin.walletName || ''})</p>
      <input placeholder="المبلغ المحوّل (جنيه)" inputMode="numeric" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
      <PhotoPicker onPick={setPayShot} label="اختار صورة التحويل" />
      <p>صورة التحويل بتتضغط تلقائياً قبل الإرسال (الحد حوالي 250 كيلوبايت).</p>
      <button className="btn" onClick={submitPayment}>ابعت طلب التحويل + صورة التحويل</button>
      <h3>طلباتي</h3>
      {state.payments.filter((p) => p.driverCode === state.driver.code).map((p) => (
        <div key={p.id} className="ride">{p.id} — {money(p.amount)} — {p.status === 'pending' ? 'بانتظار الإدارة' : p.status === 'approved' ? '✅ اتوافق عليه' : '❌ اترفض'}
          {p.screenshotUrl && <img src={p.screenshotUrl} alt="صورة التحويل" className="shot" />}
        </div>
      ))}
    </div>
  )

  // ---- قسم المستخدمين عند الأدمن ----
  const NEW_USER_DAYS = 7
  const isNewUser = (createdAt: number) => createdAt > 0 && Date.now() - createdAt < NEW_USER_DAYS * 24 * 3600 * 1000
  const newDriversCount = state.drivers.filter((d) => isNewUser(d.createdAt)).length
  const newPassengersCount = state.passengers.filter((p) => isNewUser(p.createdAt)).length
  const filterAdminUsers = <T,>(list: T[]) => {
    const typed = list as unknown as { name: string; code: string; phone: string; createdAt: number }[]
    return typed
      .filter((u) => (adminUserFilter === 'new' ? isNewUser(u.createdAt) : adminUserFilter === 'old' ? !isNewUser(u.createdAt) : true))
      .filter((u) => {
        const q = adminUserSearch.trim()
        if (!q) return true
        return [u.name, u.code, u.phone].join(' ').includes(q)
      })
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) as unknown as T[]
  }
  const adminDriverUsers = filterAdminUsers(state.drivers)
  const adminPassengerUsers = filterAdminUsers(state.passengers)
  // بطاقات السواقين المستنية المراجعة — كل السواقين مش سواق الجهاز بس
  const pendingIdCards = [
    ...state.drivers.filter((d) => d.idCardUrl && d.idCardStatus === 'pending'),
    ...(state.driver.idCardUrl && state.driver.idCardStatus === 'pending' && !state.drivers.some((d) => d.code === state.driver.code) ? [state.driver] : []),
  ]
  async function reviewDriverIdCard(code: string, status: 'approved' | 'rejected') {
    void saveDoc('drivers', code, { idCardStatus: status })
    setState((s) => ({
      ...s,
      drivers: s.drivers.map((d) => (d.code === code ? { ...d, idCardStatus: status } : d)),
      driver: s.driver.code === code ? { ...s.driver, idCardStatus: status } : s.driver,
    }))
  }
  const idCardStatusLabel = (s: string) => (s === 'approved' ? 'معتمدة ✅' : s === 'rejected' ? 'مرفوضة ❌' : s === 'pending' ? 'مستنية المراجعة ⏳' : 'مفيش بطاقة')

  const adminView = (
    <div className="card">
      <h2><span className="icon-chip"><IconShield /></span>الإدارة — صلاح</h2>
      <h3>رقم محفظتي</h3>
      <div className="grid">
        <input placeholder="رقم المحفظة" value={state.admin.walletNumber} onChange={(e) => update({ admin: { ...state.admin, walletNumber: e.target.value } })} />
        <input placeholder="الاسم على المحفظة" value={state.admin.walletName} onChange={(e) => update({ admin: { ...state.admin, walletName: e.target.value } })} />
      </div>
      <h3>طلبات التحويل الواردة</h3>
      {state.payments.length === 0 && <p>مفيش طلبات تحويل دلوقتي.</p>}
      {state.payments.map((p) => (
        <div key={p.id} className="ride">
          {p.driverName} ({p.driverCode}) — {money(p.amount)} — {p.status}
          {p.screenshotUrl && <img src={p.screenshotUrl} alt="صورة التحويل" className="shot" />}
          {p.status === 'pending' && (
            <div className="row">
              <button className="btn" onClick={() => reviewPayment(p.id, true)}>الفلوس وصلت — موافق ✅</button>
              <button className="btn danger" onClick={() => reviewPayment(p.id, false)}>الفلوس موصلتش — رفض ❌</button>
            </div>
          )}
        </div>
      ))}
      <h3>صور بطاقات السواقين للمراجعة</h3>
      {pendingIdCards.length === 0 && <p>مفيش بطاقات مستنية المراجعة.</p>}
      {pendingIdCards.map((d) => (
        <div key={d.code} className="ride">
          {d.name} ({d.code}) — <a className="link" href={`tel:${d.phone}`}>📞 {d.phone}</a>
          {d.idCardUrl && <img src={d.idCardUrl} alt="بطاقة السواق" className="shot" />}
          <div className="row">
            <button className="btn" onClick={() => reviewDriverIdCard(d.code, 'approved')}>اعتماد البطاقة</button>
            <button className="btn danger" onClick={() => reviewDriverIdCard(d.code, 'rejected')}>رفض البطاقة</button>
          </div>
        </div>
      ))}
      <h3>المستخدمون</h3>
      <p className="muted">🛺 السواقين: {state.drivers.length} • 👤 العملاء: {state.passengers.length} • 🆕 جدد آخر 7 أيام: {newDriversCount + newPassengersCount}</p>
      <div className="row">
        <button className={adminUserTab === 'drivers' ? 'btn' : 'btn small'} onClick={() => setAdminUserTab('drivers')}>🛺 السواقين ({state.drivers.length})</button>
        <button className={adminUserTab === 'passengers' ? 'btn' : 'btn small'} onClick={() => setAdminUserTab('passengers')}>👤 العملاء ({state.passengers.length})</button>
      </div>
      <div className="row">
        <button className={adminUserFilter === 'all' ? 'btn' : 'btn small'} onClick={() => setAdminUserFilter('all')}>الكل</button>
        <button className={adminUserFilter === 'new' ? 'btn' : 'btn small'} onClick={() => setAdminUserFilter('new')}>🆕 الجدد</button>
        <button className={adminUserFilter === 'old' ? 'btn' : 'btn small'} onClick={() => setAdminUserFilter('old')}>القدام</button>
      </div>
      <input placeholder="🔍 ابحث بالاسم أو الكود أو الرقم…" value={adminUserSearch} onChange={(e) => setAdminUserSearch(e.target.value)} />
      {adminUserTab === 'drivers' && adminDriverUsers.length === 0 && <p>مفيش سواقين هنا.</p>}
      {adminUserTab === 'passengers' && adminPassengerUsers.length === 0 && <p>مفيش عملاء هنا.</p>}
      {adminUserTab === 'drivers' && adminDriverUsers.map((d) => (
        <div key={d.code} className="ride">
          {avatar(d.photoUrl, d.name)} <b>{d.name}</b> ({d.code}) — <a className="link" href={`tel:${d.phone}`}>📞 {d.phone}</a>
          <br />★ {d.ratingAvg} ({d.ratingCount} تقييم) — {d.plate} {d.model} {d.color}
          <br />مديونية: {money(d.debt)} — رصيد: {money(d.balance)} — إجمالي المسدد: {money(d.totalPaid)}
          <br />البطاقة: {idCardStatusLabel(d.idCardStatus)} — سجّل: {d.createdAt ? fmtTime(d.createdAt) : 'قبل v30 — التاريخ مش معروف'}
          {d.idCardUrl && <img src={d.idCardUrl} alt="بطاقة السواق" className="shot" />}
        </div>
      ))}
      {adminUserTab === 'passengers' && adminPassengerUsers.map((p) => (
        <div key={p.code} className="ride">
          {avatar(p.photoUrl, p.name)} <b>{p.name}</b> ({p.code}) — <a className="link" href={`tel:${p.phone}`}>📞 {p.phone}</a>
          <br />★ {p.ratingAvg} ({p.ratingCount} تقييم) — سجّل: {p.createdAt ? fmtTime(p.createdAt) : 'قبل v30 — التاريخ مش معروف'}
        </div>
      ))}
      <h3>قايمة انتظار التوسع 🔔</h3>
      <p className="muted">عملاء من برّه أسيوط وسوهاج سابوا أرقامهم عشان نبلغهم لما نفتح عندهم: {state.waitlist.length}</p>
      {state.waitlist.length === 0 && <p>مفيش حد مستني التوسع لسه.</p>}
      {[...state.waitlist].sort((a, b) => b.createdAt - a.createdAt).map((w) => (
        <div key={w.id} className="ride">
          {w.name} ({w.code}) — <a className="link" href={`tel:${w.phone}`}>📞 {w.phone}</a>
          <br />من: {w.pickupLabel} → إلى: {w.destLabel}
          <br />سجّل: {w.createdAt ? fmtTime(w.createdAt) : '—'}
        </div>
      ))}
      <h3>كل الرحلات</h3>
      <input placeholder="🔍 ابحث برقم الطلب أو الكود أو الاسم أو الرقم…" value={search} onChange={(e) => setSearch(e.target.value)} />
      {filteredRides.map((r) => (
        <div key={r.orderNo} className="ride">
          <b>{r.orderNo}</b> — {r.passengerName} ({r.passengerCode}) — {r.passengerPhone} — السواق: {r.driverName || '—'} ({r.driverCode || '—'}) — {money(r.fare)} — {r.status}
          <br />من: {r.pickup.label} → إلى: {r.destination.label}
          <br />تقييم الراكب للكابتن: {r.passengerRatingForDriver ?? '—'} — تقييم الكابتن للراكب: {r.driverRatingForPassenger ?? '—'}
        </div>
      ))}
      <button className="link-btn" onClick={() => { if (confirm('متأكد؟ هيمسح كل البيانات المحلية التجريبية.')) update(defaultState()) }}>مسح البيانات التجريبية</button>
    </div>
  )

  // شاشة الدخول بالتليفون والكود — رقم التليفون أول حاجة بعد اختيار الدور
  // بوابة الدخول خطوة بخطوة، كل خطوة في صفحة لوحدها:
  // الخطوة 1: رقم التليفون — الخطوة 2: كود التحقق (للسواق والعميل)
  const phoneAuthForm = !otpSent ? (
    <div className="box">
      <h3>{appRole === 'driver' ? 'تسجيل الكابتن' : 'تسجيل العميل'} — الخطوة 1 من 2: رقم التليفون</h3>
      <p className="muted">هنبعتلك كود تحقق على رقمك — اكتبه صح عشان تدخل.</p>
      <input placeholder="رقم التليفون (11 رقم)" inputMode="tel" value={regPhone} onChange={(e) => setRegPhone(e.target.value)} />
      {/* reCAPTCHA مخفي — Firebase Phone Auth بيحتاجه على الويب */}
      <div id="recaptcha-container" />
      <button className="btn" onClick={requestOtp} disabled={otpBusy}>{otpBusy ? 'بيبعت الكود…' : 'ابعت كود التحقق'}</button>
    </div>
  ) : (
    <div className="box">
      <h3>الخطوة 2 من 2: كود التحقق</h3>
      <p className="muted">📩 الكود اتبعت في رسالة SMS على رقم {regPhone} — اكتب الكود اللي وصلك، ومش بيظهر جوه التطبيق.</p>
      <input placeholder="الكود (6 أرقام)" inputMode="numeric" maxLength={6} value={otpInput} onChange={(e) => setOtpInput(e.target.value.replace(/[^0-9]/g, ''))} />
      <button className="btn" onClick={verifyOtp} disabled={otpBusy}>{otpBusy ? 'بيتأكد…' : 'تأكيد الكود'}</button>
      <p className="muted">حد إرسال الكود: {OTP_MAX_PER_HOUR} أكواد في الساعة لكل رقم.</p>
      <button className="link-btn" onClick={() => { setOtpSent(false); setOtpInput('') }}>← تغيير الرقم</button>
    </div>
  )

  // بوابة الدخول: اختيار الدور ← رقم التليفون ← كود التحقق (للسواق والعميل)
  const isVerified = appRole !== null && !!verifiedPhones[appRole]
  // الإشعارات (أخطاء ورسايل) بتظهر مودال في نص الشاشة — مش شريط فوق
  const noticeModal = notice ? (
    <div className="notice-overlay" onClick={() => setNotice('')}>
      <div className="notice-modal" onClick={(e) => e.stopPropagation()}>
        <div className="notice-icon">!</div>
        <p>{notice}</p>
        <button className="btn" onClick={() => setNotice('')}>تمام</button>
      </div>
    </div>
  ) : null
  /** تحديث جوّه التطبيق من غير لينكات: يحمّل الـ APK ويفتح مثبّت أندرويد */
  async function installUpdate(apkUrl: string) {
    if (updateBusy) return
    setUpdateBusy(true)
    setUpdateProgress(0)
    setUpdateError('')
    try {
      // امسح أي نسخة قديمة متعلّقة قبل التحميل
      try { await Filesystem.deleteFile({ path: 'ind-toktok-update.apk', directory: Directory.Cache }) } catch { /* مفيش ملف قديم */ }
      const listener = await Filesystem.addListener('progress', (p) => {
        if (p.contentLength > 0) setUpdateProgress(Math.round((p.bytes / p.contentLength) * 100))
      })
      try {
        const result = await Filesystem.downloadFile({
          url: apkUrl,
          path: 'ind-toktok-update.apk',
          directory: Directory.Cache,
          progress: true,
        })
        let filePath = result.path ?? ''
        if (!filePath.startsWith('/')) {
          const { uri } = await Filesystem.getUri({ path: 'ind-toktok-update.apk', directory: Directory.Cache })
          filePath = uri.replace(/^file:\/\//, '')
        }
        await FileOpener.open({ filePath, contentType: 'application/vnd.android.package-archive' })
        // مثبّت أندرويد اتفتح — التطبيق هيروح خلفية لحد ما التثبيت يخلص
        setAvailableUpdate(null)
      } finally {
        await listener.remove()
      }
    } catch {
      setUpdateError('تعذر تحميل التحديث — تأكد من النت وجرب «حدّث دلوقتي» تاني.')
    } finally {
      setUpdateBusy(false)
      setUpdateProgress(0)
    }
  }
  // مودال التحديث — بيظهر لما يكون فيه إصدار أحدث (قابل للتجاهل، مش إجباري)
  const dismissUpdate = () => {
    if (availableUpdate) localStorage.setItem('indtoktok-update-dismissed', String(availableUpdate.version))
    setAvailableUpdate(null)
  }
  const updateModal = availableUpdate ? (
    <div className="notice-overlay" onClick={dismissUpdate}>
      <div className="notice-modal" onClick={(e) => e.stopPropagation()}>
        <div className="notice-icon">⬆</div>
        <p>في إصدار جديد من ind toktok (v{availableUpdate.version}) — حدّث التطبيق عشان تشوف آخر المميزات والتحسينات.</p>
        {updateError && <p className="muted">{updateError}</p>}
        <div className="row">
          <button className="btn" disabled={updateBusy} onClick={() => installUpdate(availableUpdate.apkUrl)}>{updateBusy ? (updateProgress > 0 ? `بيحمّل التحديث… ${updateProgress}%` : 'بيحمّل التحديث…') : 'حدّث دلوقتي ⬇'}</button>
          <button className="btn small" onClick={dismissUpdate}>بعدين</button>
        </div>
        <button className="btn small" disabled={updateBusy} onClick={() => void Browser.open({ url: availableUpdate.apkUrl })}>التثبيت بيعلّق؟ حمّل من المتصفح</button>
      </div>
    </div>
  ) : null
  // مودال برّه النطاق — رسالة أحسن من الرفض العادي: توضيح النطاق + زر «بلّغني»
  const outOfAreaModal = outOfArea ? (
    <div className="notice-overlay" onClick={() => setOutOfArea(null)}>
      <div className="notice-modal" onClick={(e) => e.stopPropagation()}>
        <div className="notice-icon">!</div>
        <p><b>{OUT_OF_AREA_TITLE}</b></p>
        <p>{OUT_OF_AREA_MESSAGE}</p>
        <p className="muted">من: {outOfArea.pickupLabel} — إلى: {outOfArea.destLabel}</p>
        <div className="row">
          <button className="btn" onClick={notifyMe}>🔔 بلّغني لما توصلوا</button>
          <button className="btn small" onClick={() => setOutOfArea(null)}>تمام</button>
        </div>
      </div>
    </div>
  ) : null
  if (!isVerified) {
    return (
      <div className="app" dir="rtl">
        <header className="header">
          <img src={logoUrl} alt="ind toktok" className="logo" />
          <h1><span className="brand">ind toktok</span></h1>
        </header>
        {noticeModal}
        {updateModal}
        {appRole === null ? (
          <div className="card role-picker">
            <h2>أهلاً بيك في ind toktok</h2>
            <p className="muted">اختار هتستخدم التطبيق إزاي</p>
            <button className="btn role-btn" onClick={() => chooseRole('passenger')}><IconUser /> أنا راكب — عايز توكتوك</button>
            <button className="btn role-btn" onClick={() => chooseRole('driver')}><IconDriver /> أنا كابتن — عايز أشتغل</button>
          </div>
        ) : (
          <div className="card">
            {phoneAuthForm}
            <button className="link-btn" onClick={() => { setAppRole(null); localStorage.removeItem('indtoktok-app-role'); setRole('passenger') }}>← تغيير الدور</button>
          </div>
        )}
        <footer className="footer">
          <p className="muted">ind toktok — الإصدار {APP_VERSION}</p>
        </footer>
      </div>
    )
  }

  return (
    <div className="app" dir="rtl">
      <header className="header">
        <img src={logoUrl} alt="ind toktok" className="logo" />
        <h1><span className="brand">ind toktok</span></h1>
      </header>
      {appRole === 'passenger' && (
        <nav className="tabs">
          <button className={role === 'passenger' ? 'tab active' : 'tab'} onClick={() => setRole('passenger')}><IconPin />اطلب توكتوك</button>
          <button className={role === 'myRequests' ? 'tab active' : 'tab'} onClick={() => setRole('myRequests')}><IconList />طلباتي</button>
          <button className={role === 'profile' ? 'tab active' : 'tab'} onClick={() => setRole('profile')}><IconUser />الملف الشخصي</button>
        </nav>
      )}
      {appRole === 'driver' && (
        <nav className="tabs">
          <button className={role === 'driver' ? 'tab active' : 'tab'} onClick={() => setRole('driver')}><IconList />الطلبات</button>
          <button className={role === 'trips' ? 'tab active' : 'tab'} onClick={() => setRole('trips')}><IconHistory />رحلاتي</button>
          <button className={role === 'wallet' ? 'tab active' : 'tab'} onClick={() => setRole('wallet')}><IconWallet />المحفظة</button>
          <button className={role === 'profile' ? 'tab active' : 'tab'} onClick={() => setRole('profile')}><IconUser />الملف الشخصي</button>
        </nav>
      )}
      {noticeModal}
      {updateModal}
      {outOfAreaModal}
      {role === 'passenger' && passengerView}
      {role === 'myRequests' && passengerTripsView}
      {role === 'driver' && driverView}
      {role === 'trips' && driverTripsView}
      {role === 'wallet' && walletView}
      {role === 'profile' && (appRole === 'driver' ? driverProfileView : passengerProfileView)}
      {role === 'admin' && (<><button className="btn small" onClick={() => setRole('driver')}>← رجوع للسواق</button>{adminView}</>)}
      <footer className="footer">
        <p>آخر رحلة: {lastRide ? `${lastRide.orderNo} — ${lastRide.status}` : 'لسه مفيش رحلات'}</p>
        {appRole === 'passenger' && <button className="link-btn" onClick={() => chooseRole('driver')}>أنا كابتن — دخول السواقين</button>}
        {appRole === 'driver' && (
          <div className="footer-links">
            <button className="link-btn" onClick={() => setRole('admin')}>الإدارة</button>
            <button className="link-btn" onClick={() => chooseRole('passenger')}>تبديل — أنا راكب</button>
          </div>
        )}
        <p className="muted">ind toktok — com.indtoktok.app — نسخة مستقلة (Capacitor + Firebase) — الإصدار {APP_VERSION}</p>
      </footer>
    </div>
  )
}
