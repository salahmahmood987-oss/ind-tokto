import { useEffect, useMemo, useRef, useState } from 'react'
import { Geolocation } from '@capacitor/geolocation'
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { FileOpener } from '@capacitor-community/file-opener'
import MapView from './MapView'
import type { MapMode } from './MapView'
import { IconBack, IconBell, IconCheck, IconDriver, IconEdit, IconHistory, IconList, IconNav, IconPhone, IconPin, IconSettings, IconShield, IconSwap, IconTrash, IconUser, IconWallet } from './icons'
import logoUrl from './assets/icon-1024.png'
import { APP_VERSION, VERSION_URL } from './version'
import { approvePaymentTx, applyCommissionTx, applyRatingTx, deleteDocById, firebaseEnabled, loadAdminSettings, loadDoc, loadLaunch, nextOrderNumber, saveAdminSettings, subscribeDrivers, subscribeLaunchWaitlist, subscribePassengers, subscribePayments, subscribeRides, subscribeWaitlist, uploadImageAsDataUrl, saveDoc } from './firebaseDb'
import { getFirebaseAuth } from './firebaseApp'
import { where } from 'firebase/firestore'
import { isInServiceArea, isInServiceBBox, OUT_OF_AREA_MESSAGE, OUT_OF_AREA_TITLE } from './geo'
import { sendOtpCode, toE164Phone, verifyOtpCode } from './otp'
import {
  ADMIN_PHONES,
  clientCodeForPhone,
  commissionFor,
  defaultDriver,
  defaultState,
  driverCodeForPhone,
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
import type { DriverProfile, LatLng, LaunchSettings, Offer, PaymentRequest, Ride, Role } from './types'

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
/** أسباب إلغاء العميل للرحلة — نفس نمط السواق (v45): اختيار + خانة "سبب آخر". */
const PASSENGER_CANCEL_REASONS = [
  'غيّرت رأيي',
  'لقيت توكتوك تاني',
  'الكابتن اتأخر عليّا',
  'السعر مش مناسب',
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

/** تاريخ مختصر (يوم + شهر) — للرحلات في المحفظة */
function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })
}

/**
 * بداية فترة المحفظة (v49) — بتوقيت الجهاز المحلي (مصر):
 * اليوم = 00:00 النهارده، الأسبوع = آخر 7 أيام (من 6 أيام فاتت 00:00)،
 * الشهر = أول الشهر 00:00. new Date(y, m, d-6) بيلف الشهور تلقائياً.
 */
function periodStartMs(period: 'day' | 'week' | 'month'): number {
  const now = new Date()
  if (period === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (period === 'week') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime()
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

/** وصف الفترة المعروضة (عشان السواق يعرف بالظبط الأرقام دي بتغطي إيه) */
function periodLabel(period: 'day' | 'week' | 'month'): string {
  if (period === 'day') return `النهارده — ${fmtDate(Date.now())}`
  if (period === 'week') return `من ${fmtDate(periodStartMs('week'))} لحد النهارده`
  return `من ${fmtDate(periodStartMs('month'))} لحد النهارده`
}

/** وقت الرحلة اللي بتتحدد بيه فترتها في المحفظة: المكتملة بوقت
 *  إنهائها، والملغاة بوقت إلغائها، والقديمة (قبل v49) بوقت الطلب. */
function walletRideTime(r: Ride): number {
  if (r.status === 'completed') return r.completedAt ?? r.createdAt
  if (r.status === 'cancelled') return r.cancelledAt ?? r.createdAt
  return r.createdAt
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
    <>
      <div className="ride-times-head"><span className="icon-chip sm"><IconHistory /></span>أوقات الرحلة</div>
      <div className="ride-times">
        <span>وقت الطلب: {fmtTime(r.createdAt)}</span>
        <span>وقت القبول: {fmtTime(r.acceptedAt)}</span>
        <span>وصول الكابتن: {fmtTime(r.arrivedAt)}</span>
        <span>نهاية الرحلة: {fmtTime(r.completedAt)}</span>
      </div>
    </>
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

// إزالة تكرار نفس الرحلة (نفس رقم الطلب) من أي قايمة — بيحصل لو نسخة
// محلية اتخزنت مرتين على الجهاز (الرحلة #1009 ظهرت مرتين في "رحلات
// سابقة" مع إن السيرفر فيه مستند واحد بس). من غير مسح أي بيانات.
function dedupeRides(list: Ride[]): Ride[] {
  const seen = new Set<string>()
  const out: Ride[] = []
  for (const r of list) {
    if (seen.has(r.orderNo)) continue
    seen.add(r.orderNo)
    out.push(r)
  }
  return out
}

// دمج رحلات Firestore مع الرحلات المحلية: الجديدة تتضاف، والتغييرات (حالة/عروض/أوقات) تتحدث
function mergeRides(local: Ride[], remote: Ride[]): Ride[] {
  // أي تكرار محلي قديم بيتشال هنا برضه — عشان ميفضلش ظاهر في القوايم
  const deduped = dedupeRides(local)
  if (!remote.length) return deduped.length === local.length ? local : deduped
  const byNo = new Map(deduped.map((r) => [r.orderNo, r]))
  let changed = deduped.length !== local.length
  const out = [...deduped]
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
  // (v48) بوابة الإدارة: رقم الأدمن بس هو اللي يفتح لوحة الإدارة — قبل كده
  // زرار «الإدارة» كان ظاهر لأي سواق وبيفتح كل حاجة من غير أي فحص.
  // الرقم بيتطبَّع E.164 الأول عشان 0155 و+20155 يبقوا نفس الرقم.
  const isAdmin =
    appRole === 'driver' &&
    ADMIN_PHONES.includes(toE164Phone(verifiedPhones.driver ?? '') ?? '')
  // هوية المستخدم الحالية — بتحدد نطاق المزامنة (مين يشوف إيه من السيرفر)
  const passengerPhone = state.passenger?.phone ?? null
  const driverCode = state.driver.code
  // (v48) حارس الكتابة على مستند السواق: لو الكود المحلي مش هو الكود
  // المشتق من رقم الهاتف (كود قديم D-1001 أو هاش v47)، متكتبش على السيرفر
  // — الترحيل عند الفتح بيصلّح الكود الأول، والكتابة تستنى لحد ما يتصلح.
  function driverCodeIsCurrent(d: DriverProfile): boolean {
    if (!d.phone) return true
    const e164 = toE164Phone(d.phone) ?? d.phone
    return d.code === driverCodeForPhone(e164)
  }
  // (v48) ربط خفيف بجلسة Firebase Auth (مسار الـ Worker بس): الـ UID بتاعه
  // هو أرقام التليفون نفسه — لو الجلسة بتقول رقم مختلف عن المحفوظ محلياً،
  // الجلسة هي الصح (بتمنع تزوير localStorage). مسار Firebase الأصلي الـ UID
  // بتاعه مش رقم تليفون، فبيتجاهل — والحماية الكاملة الحقيقية قواعد Firestore.
  useEffect(() => {
    void (async () => {
      try {
        const auth = getFirebaseAuth()
        const uid = auth?.currentUser?.uid
        if (!uid || !/^\d{12,13}$/.test(uid)) return
        const e164 = `+${uid}`
        const role = appRole
        if (role && verifiedPhones[role] && verifiedPhones[role] !== e164) {
          saveVerifiedPhones({ ...verifiedPhones, [role]: e164 })
        }
      } catch {
        /* تجاهل — الجلسة مش متاحة */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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
  // بوابة الإطلاق (v44): الخدمة لسه ما اشتغلتش — بنجمع 100 كابتن الأول
  const [launch, setLaunch] = useState<LaunchSettings>({ launched: false, driversTarget: 100 })
  const [launchGate, setLaunchGate] = useState(false)
  const [launchBusy, setLaunchBusy] = useState(false)
  // تنبيه التحديث: لو فيه إصدار أحدث على الريبو بيظهر مودال بزر تحديث
  const [availableUpdate, setAvailableUpdate] = useState<{ version: number; apkUrl: string; sha256?: string } | null>(null)
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
  const [payBusy, setPayBusy] = useState(false)
  // المحفظة (v49): فترة العرض + فلتر حالة الرحلات
  const [walletPeriod, setWalletPeriod] = useState<'day' | 'week' | 'month'>('day')
  const [walletFilter, setWalletFilter] = useState<'all' | 'completed' | 'cancelled'>('all')
  // تكبير الصور (بطاقة/تحويل) بملء الشاشة (v49): الأدمن مكنش يقدر يفتح
  // صورة البطاقة أصلاً — كانت صورة مصغّرة من غير أي إجراء عند الضغط عليها
  const [lightbox, setLightbox] = useState<string | null>(null)
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

  // (v48) الرحلة النشطة بتاعة العميل ده بس — قبل كده أي راكب كان بيشوف
  // رحلة أي راكب تاني ويقدر يلغيها ويغيّر سعرها، ومكانش يعرف يطلب أصلاً.
  const activeRide = [...state.rides]
    .reverse()
    .find((r) => passengerPhone !== null && r.passengerPhone === passengerPhone && ['searching', 'matched', 'driver_arrived', 'on_trip'].includes(r.status))
  // رحلة الكابتن الحالية ورحلاته السابقة (مكتملة أو ملغاة)
  const myCurrentRide = state.rides.find((r) => r.driverCode === state.driver.code && ['matched', 'driver_arrived', 'on_trip'].includes(r.status))
  // السواق وصل للعميل؟ لوكيشن الوجهة يظهر له بس بعد الوصول (driver_arrived أو on_trip)
  const driverArrived = !!myCurrentRide && ['driver_arrived', 'on_trip'].includes(myCurrentRide.status)
  const myPastRides = dedupeRides(state.rides
    .filter((r) => r.driverCode === state.driver.code && (r.status === 'completed' || r.status === 'cancelled')))
    .sort((a, b) => b.createdAt - a.createdAt)
  // طلبات العميل (كل حالاتها) — الأحدث أولاً
  const myPassengerRides = dedupeRides(state.rides
    .filter((r) => state.passenger && r.passengerCode === state.passenger.code))
    .sort((a, b) => b.createdAt - a.createdAt)
  // (v48) آخر رحلة بتاعتي أنا بس (كعميل أو كسواق) — قبل كده التذييل كان
  // بيعرض رقم وآخر حالة لرحلة شخص تاني.
  const lastRide = myPassengerRides[0] ?? myPastRides[0] ?? undefined

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
        // الخانة نفسها تفضل فاضية — «موقعي الحالي» تظهر كـ placeholder بس،
        // مش قيمة جوّه الحقل، عشان العميل يقدر يكتب على طول من غير ما يمسحها
        setPickupLabel('')
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
  // (v48) مزامنة حية للرحلات — حسب الدور: الأدمن يشوف الكل، السواق يشوف
  // الطلبات المتاحة + رحلاته، والعميل يشوف رحلاته بس. قبل كده كل جهاز
  // كان بينزّل كل الرحلات والسواقين والعملاء والتحويلات (بطايق وأرقام).
  useEffect(() => {
    if (!firebaseEnabled) return
    if (isAdmin) {
      return subscribeRides((remote) => {
        setState((s) => {
          const merged = mergeRides(s.rides, remote)
          return merged === s.rides ? s : { ...s, rides: merged }
        })
      })
    }
    if (appRole === 'driver') {
      const unsubs: Array<() => void> = []
      // الطلبات المتاحة (searching) — مع تنضيف اللي اتاخدت من سواق تاني
      // (الطلب اللي يختفي من الاستعلام ده وهو لسه searching محلياً معناه
      // إنه اتقبل أو اتلغى — ولو فضل ظاهر السواق هيبعت عرض على رحلة مش بتاعته)
      unsubs.push(subscribeRides((remote) => {
        const remoteIds = new Set(remote.map((r) => r.orderNo))
        setState((s) => {
          const merged = mergeRides(s.rides, remote)
          const pruned = merged.filter((r) => {
            if (r.status !== 'searching') return true
            if (remoteIds.has(r.orderNo)) return true
            if (s.passenger?.phone && r.passengerPhone === s.passenger.phone) return true
            if (Date.now() - r.createdAt < 120000) return true
            return false
          })
          return pruned.length === s.rides.length && merged === s.rides ? s : { ...s, rides: pruned }
        })
      }, [where('status', '==', 'searching')]))
      // رحلاتي أنا كسواق (أي حالة) — بس لو كودي الحالي مشتق من رقمي،
      // عشان كود قديم (D-1001) ميسحبش رحلات سواق تاني
      const me = stateRef.current.driver
      if (me.phone && driverCodeIsCurrent(me)) {
        unsubs.push(subscribeRides((remote) => {
          setState((s) => {
            const merged = mergeRides(s.rides, remote)
            return merged === s.rides ? s : { ...s, rides: merged }
          })
        }, [where('driverCode', '==', me.code)]))
      }
      return () => unsubs.forEach((u) => u())
    }
    if (appRole === 'passenger' && passengerPhone) {
      return subscribeRides((remote) => {
        setState((s) => {
          const merged = mergeRides(s.rides, remote)
          return merged === s.rides ? s : { ...s, rides: merged }
        })
      }, [where('passengerPhone', '==', passengerPhone)])
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebaseEnabled, isAdmin, appRole, passengerPhone, driverCode, state.driver.phone])
  // مزامنة حية لطلبات التحويل — الأدمن يشوف الكل، السواق يشوف طلباته بس
  useEffect(() => {
    if (!firebaseEnabled) return
    if (isAdmin) {
      return subscribePayments((remote) => {
        setState((s) => {
          const merged = mergePayments(s.payments, remote)
          return merged === s.payments ? s : { ...s, payments: merged }
        })
      })
    }
    const me = stateRef.current.driver
    if (appRole === 'driver' && me.phone && driverCodeIsCurrent(me)) {
      return subscribePayments((remote) => {
        setState((s) => {
          const merged = mergePayments(s.payments, remote)
          return merged === s.payments ? s : { ...s, payments: merged }
        })
      }, [where('driverCode', '==', me.code)])
    }
    setState((s) => (s.payments.length ? { ...s, payments: [] } : s))
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebaseEnabled, isAdmin, appRole, driverCode, state.driver.phone])
  // مزامنة حية للسواقين — الأدمن يشوف الكل؛ غيره يشوف المتاحين بس
  // (من غير صورة البطاقة — صور البطايق متتسحبش على موبايل حد غير الأدمن)
  useEffect(() => {
    if (!firebaseEnabled) return
    if (isAdmin) {
      return subscribeDrivers((remote) => {
        setState((s) => ({ ...s, drivers: remote }))
      })
    }
    return subscribeDrivers((remote) => {
      const stripped = remote.map((d) => ({ ...d, idCardUrl: null }))
      setState((s) => ({ ...s, drivers: stripped }))
    }, [where('online', '==', true)])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebaseEnabled, isAdmin])
  // مزامنة حية للعملاء المسجلين — للإدارة بس
  useEffect(() => {
    if (!firebaseEnabled) return
    if (!isAdmin) {
      setState((s) => (s.passengers.length ? { ...s, passengers: [] } : s))
      return undefined
    }
    return subscribePassengers((remote) => {
      setState((s) => ({ ...s, passengers: remote }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebaseEnabled, isAdmin])
  // مزامنة حية لقايمة انتظار التوسع — للإدارة بس
  useEffect(() => {
    if (!firebaseEnabled) return
    if (!isAdmin) {
      setState((s) => (s.waitlist.length ? { ...s, waitlist: [] } : s))
      return undefined
    }
    return subscribeWaitlist((remote) => {
      setState((s) => ({ ...s, waitlist: remote }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebaseEnabled, isAdmin])
  // قراءة إعدادات الإطلاق + رقم محفظة الأدمن عند الفتح + مزامنة حية لقايمة انتظار الإطلاق (للإدارة)
  useEffect(() => {
    if (!firebaseEnabled) return
    void loadLaunch().then(setLaunch)
    // (v48) رقم محفظة الأدمن من السيرفر — قبل كده كان محلي بس على جهاز صلاح،
    // فالسواقين على موبايلاتهم كانوا بيشوفوا «لم يحددها الأدمن بعد».
    void loadAdminSettings().then((s) => {
      if (s && (s.walletNumber || s.walletName)) update({ admin: s })
    })
    if (!isAdmin) {
      setState((s) => (s.launchWaitlist.length ? { ...s, launchWaitlist: [] } : s))
      return undefined
    }
    return subscribeLaunchWaitlist((remote) => {
      setState((s) => ({ ...s, launchWaitlist: remote }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebaseEnabled, isAdmin])
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
        setAvailableUpdate({ version: data.version, apkUrl: typeof data.apkUrl === 'string' ? data.apkUrl : '', sha256: typeof data.sha256 === 'string' ? data.sha256 : undefined })
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
    // (v48) ترحيل لمرة واحدة من كود قديم (D-1001 أو هاش v47) للكود الجديد
    // المشتق من رقم الهاتف. بينقل المستند القديم للكود الجديد ويمسح القديم —
    // بس لو المستند القديم بتاع رقمي أنا (لو بتاع سواق تاني ميتلمسش خالص).
    // بعد الترحيل الكود المحلي بيتغير والإفكت ده بيرجع يشتغل على الكود الجديد.
    const curPhone = stateRef.current.driver.phone
    if (curPhone) {
      const e164 = toE164Phone(curPhone) ?? curPhone
      const want = driverCodeForPhone(e164)
      if (code !== want) {
        void (async () => {
          const newDoc = await loadDoc('drivers', want)
          if (!newDoc) {
            const oldDoc = await loadDoc('drivers', code)
            if (oldDoc && (oldDoc.phone as string) === e164) {
              await saveDoc('drivers', want, { ...(oldDoc as Record<string, unknown>), code: want, phone: e164 })
              await deleteDocById('drivers', code)
            }
          }
          if (!cancelled) update({ driver: { ...stateRef.current.driver, code: want, phone: e164 } })
        })()
        return () => {
          cancelled = true
        }
      }
    }
    void loadDoc('drivers', code).then((doc) => {
      if (cancelled || !doc) return
      const cur = stateRef.current.driver
      // v47: المستند ده لو بتاع رقم تاني (سواق تاني)، متسحبش منه حاجة —
      // ولو جهازي شايل بياناته من قبل كده، صفّرها محلياً بس (من غير ما أمسح السيرفر).
      const docPhone = doc.phone as string | undefined
      if (docPhone && cur.phone && docPhone !== cur.phone) {
        update({ driver: { ...cur, ratingAvg: 0, ratingCount: 0, debt: 0, balance: 0, totalPaid: 0, photoUrl: null } })
        return
      }
      // لسه مسجلتش برقم — متسحبش بيانات أي ملف قبل ما الرقم يتأكد
      if (!cur.phone) return
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
  // (v48) الموقع بيوصل للسيرفر فعلاً: كل 10 ثواني لمستند الرحلة الحالية
  // (عشان العميل يشوف الكابتن لايف) وكل 30 ثانية لمستند السواق (عشان خريطة
  // العملاء). قبل كده التِك كان محلي بس — والعميل كان بيشوف نقطة ثابتة.
  const lastRideLocSaveRef = useRef(0)
  const lastDriverLocSaveRef = useRef(0)
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
              r.status === 'matched' || r.status === 'driver_arrived' || r.status === 'on_trip'
                ? {
                    ...r,
                    driverLat: pos.coords.latitude,
                    driverLng: pos.coords.longitude,
                    driverLocAt: Date.now(),
                  }
                : r,
            ),
          }))
          // حفظ على السيرفر (مقيّد بالوقت) — بس لو كودي الحالي مشتق من رقمي
          const now = Date.now()
          const me = stateRef.current.driver
          if (!driverCodeIsCurrent(me)) return
          const active = stateRef.current.rides.find(
            (r) => r.driverCode === me.code && ['matched', 'driver_arrived', 'on_trip'].includes(r.status),
          )
          if (active && now - lastRideLocSaveRef.current > 10000) {
            lastRideLocSaveRef.current = now
            void saveDoc('rides', active.orderNo, {
              driverLat: pos.coords.latitude,
              driverLng: pos.coords.longitude,
              driverLocAt: now,
            })
          }
          if (now - lastDriverLocSaveRef.current > 30000) {
            lastDriverLocSaveRef.current = now
            void saveDoc('drivers', me.code, {
              online: true,
              currentLat: pos.coords.latitude,
              currentLng: pos.coords.longitude,
            })
          }
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
          // «موقعي الحالي» placeholder بس — الخانة تفضل فاضية والعميل يكتب على طول
          setPickupLabel('')
        } else {
          setDestination(ll)
          setDestLabel('')
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
    // (v48) المعرّف هو رقم التليفون نفسه — قبل كده نفس الرقم كان بيتسجل
    // مرات عديدة في القايمة (phone-Date.now).
    void saveDoc('waitlist', state.passenger.phone, entry)
    setOutOfArea(null)
    showNotice('تمام! سجلنا رقمك وهنبلغك أول ما نفتح في منطقتك 👍')
  }

  /** عميل داس «بلّغني لما نبدأ» في مودال الإطلاق — نسجل رقمه في قايمة انتظار الإطلاق */
  function notifyLaunch() {
    if (!state.passenger) return
    // (v48) المعرّف هو رقم التليفون نفسه — قبل كده نفس الرقم كان بيتسجل مرات عديدة.
    void saveDoc('launchWaitlist', state.passenger.phone, {
      phone: state.passenger.phone,
      name: state.passenger.name,
      createdAt: Date.now(),
    })
    setLaunchGate(false)
    showNotice('تمام، هنبعتلك أول ما نبدأ ✅')
  }

  // ---- طلب رحلة ----
  async function requestRide() {
    if (!state.passenger) {
      showNotice('سجل برقم تليفونك الأول.')
      return
    }
    // بوابة الإطلاق (v44): الخدمة لسه ما اشتغلتش — بنجمع سواقين الأول.
    // بنقرا العلم من السيرفر في كل مرة قبل إنشاء الطلب، فلو الأدمن شغّل
    // الخدمة الطلب يمشي فوراً من غير تحديث للتطبيق.
    const freshLaunch = await loadLaunch()
    setLaunch(freshLaunch)
    if (!freshLaunch.launched) {
      setLaunchGate(true)
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
      // (v48) رقم الطلب من عدّاد السيرفر — قبل كده كان عدّاد محلي يبدأ من 1000
      // على كل جهاز، فأول رحلة لكل راكب كانت #1001 وبتتكتب فوق رحلة راكب تاني.
      const orderNum = await nextOrderNumber()
      const ride: Ride = {
        orderNo: orderNum,
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
      cancelledAt: null,
      cancelReason: null,
      cancelledBy: null,
      passengerPhotoUrl: state.passenger?.photoUrl ?? null,
      driverPhotoUrl: null,
      passengerRatingForDriver: null,
      driverRatingForPassenger: null,
    }
    update({ rides: [...state.rides, ride] })
    void saveDoc('rides', ride.orderNo, ride as unknown as Record<string, unknown>)
    showNotice(`طلبك ${ride.orderNo} اتبعت للسواقين القريبين.`)
    } finally {
      setRequestBusy(false)
    }
  }

  function acceptOffer(ride: Ride, offer: Offer) {
    // (v48) تحقق ملكية وحالة: الرحلة دي بتاعتي أنا، ولسه مستنية عروض،
    // والعرض ده مبعوت على نفس الرحلة — قبل كده أي حد كان يقدر يقبل عرض على رحلة غيره.
    if (ride.passengerPhone !== state.passenger?.phone) return
    if (ride.status !== 'searching') return
    if (offer.rideId !== ride.orderNo) return
    const updated: Ride = {
      ...ride,
      status: 'matched',
      // السعر المتفق عليه هو سعر العرض اللي اختاره العميل (مش سعره الأصلي)
      fare: offer.price,
      driverCode: offer.driverCode,
      driverName: offer.driverName,
      driverPhone: offer.driverPhone,
      // (v48) موقع الكابتن الحقيقي من العرض نفسه — قبل كده كان موقع مزيف
      // ثابت (+0.012 شمال نقطة الركوب) ومبيتحركش أبداً.
      driverLat: offer.driverLat ?? ride.pickup.lat,
      driverLng: offer.driverLng ?? ride.pickup.lng,
      driverLocAt: Date.now(),
      acceptedAt: Date.now(),
      driverPhotoUrl: offer.driverPhotoUrl ?? null,
    }
    update({ rides: state.rides.map((r) => (r.orderNo === ride.orderNo ? updated : r)) })
    void saveDoc('rides', ride.orderNo, updated as unknown as Record<string, unknown>)
    showNotice(`الكابتن ${offer.driverName} في الطريق إليك.`)
  }

  /** السواق يبعت عرض بسعره (مفاوضة) — السعر اللي يكتبه هو عرضه للعميل. */
  async function sendDriverOffer(ride: Ride, price: number) {
    // (v48) العرض بيتأكد من السيرفر طازج قبل الإرسال: الرحلة لسه مستنية
    // عروض ولسه مفيهاش كابتن — القايمة المحلية ممكن تكون قديمة (رحلة اتاخدت
    // من سواق تاني)، والعرض على رحلة متاخدة كان بيرجّع حالتها searching تاني.
    // ولو السواق وصل حد المديونية أو مش متاح، مفيش عروض أصلاً.
    if (isDebtBlocked(state.driver.debt)) {
      showNotice('وصلت لحد المديونية — سدّد الأول عشان تبعت عروض.')
      return
    }
    if (!state.driver.online) {
      showNotice('لازم تبقى متاح (الزرار الأخضر) عشان تبعت عروض.')
      return
    }
    if (ride.status !== 'searching') return
    const fresh = await loadDoc('rides', ride.orderNo)
    if (fresh && (fresh.status !== 'searching' || (fresh.driverCode as string | null))) {
      showNotice('الرحلة دي اتاخدت خلاص — شوف الطلبات المتاحة.')
      return
    }
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
    // (v48) السعر بيتغير لرحلتي أنا بس وهي لسه مستنية عروض.
    if (ride.passengerPhone !== state.passenger?.phone) return
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
    // (v48) الإلغاء لطرف في الرحلة بس، ورحلة لسه شغالة — رحلة مكتملة أو
    // ملغاة مينفعش تتلغي تاني (والعمولة بتاعتها مبتتعكسش لو اتلغت بعد الإنهاء).
    if (by === 'passenger' && ride.passengerPhone !== state.passenger?.phone) return
    if (by === 'driver' && ride.driverCode !== state.driver.code) return
    if (!['searching', 'matched', 'driver_arrived'].includes(ride.status)) return
    // (v49) وقت الإلغاء — عشان الملغاة تظهر في فترة الإلغاء في المحفظة
    const next: Ride = { ...ride, status: 'cancelled', cancelReason: reason, cancelledBy: by, cancelledAt: Date.now() }
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
    // (v48) تغيير الحالة للكابتن بتاع الرحلة بس، وبالترتيب الصحيح بس —
    // قبل كده أي إنهاء مكرر كان بيخصم العمولة 5% تاني، وإنهاء رحلة
    // لسه ما بدأتش كان بيخصم عمولة على رحلة لم تتم.
    if (ride.driverCode !== state.driver.code) return
    if (ride.status === 'completed' || ride.status === 'cancelled') return
    const allowed: Record<string, string[]> = {
      driver_arrived: ['matched'],
      on_trip: ['driver_arrived'],
      completed: ['on_trip'],
    }
    if (!allowed[status]?.includes(ride.status)) return
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
      // (v48) الخصم النهائي في معاملة ذرّية من أحدث قراءة على السيرفر —
      // إنهاء مكرر من جهازين مبيخصمش مرتين. النتيجة بتصحح المحلي بعد ما توصل.
      void applyCommissionTx(driver.code, commission).then((res) => {
        if (res.ok && res.debt !== undefined && res.balance !== undefined) {
          update({ driver: { ...stateRef.current.driver, debt: res.debt, balance: res.balance } })
        } else if (driverCodeIsCurrent(driver)) {
          // مفيش نت — الحساب المحلي يتحفظ كأفضل جهد (نفس سلوك قبل كده)
          void saveDoc('drivers', driver.code, { debt: driver.debt, balance: driver.balance })
        }
      })
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
    // (v48) التقييم في معاملة ذرّية على السيرفر: التقييم لنفس الرحلة مرة
    // واحدة بس (الحارس جوّه المعاملة)، والمتوسط والعداد من أحدث قراءة —
    // تقييمان متزامنان لنفس السواق مبيضيّعوش بعض.
    void applyRatingTx(orderNo, by, value).then((res) => {
      if (res.ok) {
        if (by === 'passenger' && stateRef.current.driver.code === ride.driverCode && res.ratingAvg !== undefined && res.ratingCount !== undefined) {
          update({ driver: { ...stateRef.current.driver, ratingAvg: res.ratingAvg, ratingCount: res.ratingCount } })
        }
        if (by === 'driver' && stateRef.current.passenger?.phone === ride.passengerPhone && res.ratingAvg !== undefined && res.ratingCount !== undefined) {
          update({ passenger: { ...stateRef.current.passenger, ratingAvg: res.ratingAvg, ratingCount: res.ratingCount } })
        }
        showNotice('شكراً! تقييمك اتسجل.')
        return
      }
      // فشل (اتقيّم قبل كده من جهاز تاني، أو مفيش نت) — نرجّع التقييم المحلي
      // زي ما كان، والسيرفر هو الصح.
      update({ rides: stateRef.current.rides.map((r) => (r.orderNo === orderNo ? ride : r)) })
      showNotice(res.reason === 'already-rated' ? 'التقييم ده اتسجل قبل كده.' : 'مقدرناش نسجّل التقييم — تأكد من النت وحاول تاني.')
    })
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
    // (v48) الرقم بيتطبَّع E.164 الأول (+20155...) — قبل كده نفس الرقم بصيغ
    // مختلفة (0155/+20155) كان بياخد كود سواق مختلف وملف جديد فارغ،
    // ومحفظته وتقييماته بتتهجر في الملف القديم.
    const rawPhone = regPhone.trim()
    const phone = toE164Phone(rawPhone) ?? rawPhone
    const authRole: 'passenger' | 'driver' = appRole ?? 'passenger'
    saveVerifiedPhones({ ...verifiedPhones, [authRole]: phone })
    if (authRole === 'passenger') {
      const prev = state.passenger
      const samePhone = prev?.phone === phone
      // لو مفيش بيانات محلية (إعادة تثبيت)، اقرأ نسخة السيرفر الأول
      // قبل ما تكتب فوقها — عشان الاسم والصورة والتقييم ميرجعوش صفر.
      // (v48) بنجرّب المفتاح المطبَّع الأول، ولو مش موجود بنجرّب المفتاح
      // الخام القديم وبنرحّل المستند للمفتاح المطبَّع.
      let server = !prev ? await loadDoc('passengers', phone) : null
      let migratedFromRaw = false
      if (!prev && !server && rawPhone !== phone) {
        server = await loadDoc('passengers', rawPhone)
        migratedFromRaw = !!server
      }
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
      if (migratedFromRaw) void deleteDocById('passengers', rawPhone)
      showNotice(`أهلاً ${profile.name}! رقمك اتأكد وكودك ${profile.code}.`)
    } else {
      // v48: الكود من رقم الهاتف نفسه (D- + الأرقام) — مستحيل يتصادم.
      // (v47 كان هاش من 10,000 قيمة بس — مع 100 سواق احتمال التصادم ~39%
      // ويرجع نفس خلل D-1001 بالظبط)
      const code = driverCodeForPhone(phone)
      // لو السواق ده مسجل قبل كده بنفس الرقم (إعادة تثبيت)، رجّع ملفه هو بس
      const server = await loadDoc('drivers', code)
      const ownDoc = server && (server.phone as string) === phone ? server : null
      // ترحيل من كود قديم (D-1001 أو هاش v47): لو المستند القديم بتاع رقمي،
      // انقل بياناته للكود الجديد وامسح القديم.
      let migrated: Record<string, unknown> | null = null
      if (!ownDoc) {
        const oldCode = state.driver.code
        if (oldCode && oldCode !== code) {
          const oldDoc = await loadDoc('drivers', oldCode)
          if (oldDoc && (oldDoc.phone as string) === phone) {
            migrated = oldDoc
            void deleteDocById('drivers', oldCode)
          }
        }
      }
      const src = ownDoc ?? migrated
      const base = state.driver
      const driver: DriverProfile = {
        ...defaultDriver(),
        ...(src
          ? {
              ratingAvg: (src.ratingAvg as number) ?? 0,
              ratingCount: (src.ratingCount as number) ?? 0,
              debt: (src.debt as number) ?? 0,
              balance: (src.balance as number) ?? 0,
              totalPaid: (src.totalPaid as number) ?? 0,
              photoUrl: (src.photoUrl as string | null) ?? null,
              createdAt: (src.createdAt as number) ?? Date.now(),
            }
          : { createdAt: Date.now() }),
        name: base.name || (src?.name as string) || '',
        phone,
        code,
        plate: base.plate || (src?.plate as string) || '',
        color: base.color || (src?.color as string) || '',
        model: base.model || (src?.model as string) || '',
        idCardUrl: base.idCardUrl ?? (src?.idCardUrl as string | null) ?? null,
        idCardStatus:
          base.idCardStatus !== 'none'
            ? base.idCardStatus
            : ((src?.idCardStatus as DriverProfile['idCardStatus']) ?? 'none'),
      }
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
    // (v48) زرار التحويل بيتقفل أثناء الرفع — ضغطة مزدوجة كانت بتعمل
    // طلبين بنفس المبلغ والصورة، ولو الأدمن وافق على الاتنين المبلغ
    // بيتضاف مرتين لمحفظة السواق.
    if (payBusy) return
    const amount = parseFloat(payAmount)
    if (!amount || amount <= 0) {
      showNotice('اكتب مبلغ التحويل.')
      return
    }
    if (!payShot) {
      showNotice('ارفع صورة التحويل — إلزامية.')
      return
    }
    setPayBusy(true)
    try {
      // الصورة بتتضغط محلياً وتتخزن Base64 داخل مستند Firestore — بدون Storage.
      let url: string
      try {
        url = await uploadImageAsDataUrl(payShot)
      } catch (e) {
        showNotice(e instanceof Error ? e.message : 'مقدرناش نجهّز صورة التحويل.')
        return
      }
      // (v48) معرّف فريد فعلاً — PAY-Date.now() بس كان ممكن يتكرر
      // لو ضغطتين وقعوا في نفس الملي ثانية فيضيع طلب.
      const payment = {
        id: `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
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
    } finally {
      setPayBusy(false)
    }
  }

  async function reviewPayment(id: string, approve: boolean) {
    const payment = state.payments.find((p) => p.id === id)
    if (!payment) return
    // الطلب اللي اتراجع قبل كده مينفعش يتراجع تاني — الموافقة مرتين كانت بتخصم مرتين
    if (payment.status !== 'pending') {
      showNotice('الطلب ده اتراجع قبل كده.')
      return
    }
    if (!approve) {
      // الرفض: بنتأكد من السيرفر طازج إن الطلب لسه pending قبل ما نرفضه
      const fresh = await loadDoc('payments', id)
      if (fresh && fresh.status !== 'pending') {
        showNotice('الطلب ده اتراجع قبل كده.')
        return
      }
      const updatedPayment = { ...payment, status: 'rejected' as const }
      update({ payments: state.payments.map((p) => (p.id === id ? updatedPayment : p)) })
      void saveDoc('payments', id, updatedPayment as unknown as Record<string, unknown>)
      showNotice('تم رفض الطلب.')
      return
    }
    // (v48) الموافقة في معاملة ذرّية: الطلب لازم يكون لسه pending جوّه
    // المعاملة نفسها — فاعتماد مرتين (جهازين أو ضغطتين) مستحيل، وخصم
    // المديونية بيتحسب من أحدث قراءة على السيرفر.
    const res = await approvePaymentTx(id)
    if (!res.ok) {
      showNotice(res.alreadyReviewed ? 'الطلب ده اتراجع قبل كده.' : 'مقدرناش نعتمد الطلب — تأكد من النت وحاول تاني.')
      return
    }
    const updatedPayment = { ...payment, status: 'approved' as const }
    update({ payments: state.payments.map((p) => (p.id === id ? updatedPayment : p)) })
    if (state.driver.code === payment.driverCode && res.debt !== undefined && res.balance !== undefined && res.totalPaid !== undefined) {
      update({ driver: { ...state.driver, debt: res.debt, balance: res.balance, totalPaid: res.totalPaid } })
    }
    // خصم المديونية من مستند السواق نفسه على السيرفر — مش من مديونية جهاز الأدمن
    // المبلغ بيسدد المديونية الأول، وأي زيادة عنها بتتحفظ رصيد في محفظة السواق
    showNotice(
      res.remainder !== undefined && res.remainder > 0
        ? `تمت الموافقة — المديونية اتخصمت، والزيادة ${money(res.remainder)} بقت رصيد في محفظة السواق.`
        : 'تمت الموافقة — المديونية اتخصمت فوراً.',
    )
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
    // (v48) حفظ الحقلين بس — قبل كده كان بيكتب كائن السواق كامل من حالة
    // محلية قديمة، فيمسح تقييم/محفظة أحدث على السيرفر. ولو الكود المحلي
    // مشتق من رقم تاني، متكتبش على السيرفر خالص.
    if (driverCodeIsCurrent(driver)) {
      void saveDoc('drivers', driver.code, { idCardUrl: url, idCardStatus: 'pending' })
    }
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
      void saveDoc('passengers', passenger.phone, { photoUrl: url })
      showNotice('صورتك اتحفظت وهتظهر للكابتن.')
    } else {
      const driver = { ...state.driver, photoUrl: url }
      update({ driver })
      // (v48) حفظ الصورة بس + حارس الكود (نفس سبب رفع البطاقة).
      if (driverCodeIsCurrent(driver)) {
        void saveDoc('drivers', driver.code, { photoUrl: url })
      }
      showNotice('صورتك اتحفظت وهتظهر للعميل.')
    }
    setProfilePhotoFile(null)
  }

  const filteredRides = dedupeRides(state.rides).filter((r) => {
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
      // (v48) حالة «متاح» بتتحفظ على السيرفر — قبل كده كانت محلية بس،
      // فخريطة العملاء مكانش بيظهر عليها كباتن متاحين أبداً.
      if (driverCodeIsCurrent(state.driver)) {
        void saveDoc('drivers', state.driver.code, { online: false })
      }
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
      if (driverCodeIsCurrent(state.driver)) {
        void saveDoc('drivers', state.driver.code, {
          online: true,
          currentLat: pos.coords.latitude,
          currentLng: pos.coords.longitude,
        })
      }
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
      <button className="btn small" onClick={ring}><IconBell /> جرّب صوت التنبيه</button>
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
      <h3><span className="icon-chip sm"><IconPin /></span>رحلتي الحالية</h3>
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
            <a className="btn small" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${myCurrentRide.pickup.lat},${myCurrentRide.pickup.lng}`}><IconNav /> الاتجاهات لنقطة الركوب ↗</a>
            {driverArrived && (
              <>
                <br />
                <a className="btn small" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${myCurrentRide.destination.lat},${myCurrentRide.destination.lng}`}><IconNav /> الاتجاهات للوجهة ↗</a>
                <p className="notice">وصلت للعميل — لوكيشن الوجهة ظهر دلوقتي على الخريطة.</p>
              </>
            )}
            {myCurrentRide.driverLat && myCurrentRide.driverLng && (
              <p className="muted">العميل على بعد {distanceKm({ lat: myCurrentRide.driverLat, lng: myCurrentRide.driverLng }, myCurrentRide.pickup)} كم منك</p>
            )}
            <a className="btn" href={`tel:${myCurrentRide.passengerPhone}`}><IconPhone /> اتصل بالعميل — {myCurrentRide.passengerPhone}</a>
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
                <button className="btn small soft" onClick={() => { setCancelTarget(null); setCancelReason(''); setCancelReasonOther('') }}><IconBack /> رجوع</button>
              </div>
            </div>
          )}
          </div>
        </div>
      ) : (
        <p>مفيش رحلة شغالة دلوقتي.</p>
      )}
      <h3><span className="icon-chip sm"><IconHistory /></span>رحلات سابقة</h3>
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
              <p className="muted">رقمك موثق ✓ — <button className="btn small soft" onClick={clearDriverVerification}><IconEdit /> تغيير الرقم</button></p>
            )}
            <input placeholder="رقم اللوحة" value={state.driver.plate} onChange={(e) => update({ driver: { ...state.driver, plate: e.target.value } })} />
            <input placeholder="اللون" value={state.driver.color} onChange={(e) => update({ driver: { ...state.driver, color: e.target.value } })} />
            <input placeholder="الموديل" value={state.driver.model} onChange={(e) => update({ driver: { ...state.driver, model: e.target.value } })} />
          </div>
          <p>كود السواق: <b>{state.driver.code}</b> — التقييم: {state.driver.ratingAvg} ★ ({state.driver.ratingCount})</p>
          <h3><span className="icon-chip sm"><IconShield /></span>صورة البطاقة الشخصية</h3>
          <p>الصورة بتتضغط تلقائياً قبل الرفع (الحد حوالي 250 كيلوبايت) وتتحفظ في حسابك.</p>
          <PhotoPicker onPick={setIdCardFile} label="اختار صورة البطاقة" />
          <button className="btn" onClick={uploadIdCard} disabled={!idCardFile}>رفع صورة البطاقة</button>
          {state.driver.idCardUrl && (
            <div>
              <img src={state.driver.idCardUrl} alt="صورة البطاقة — اضغط للتكبير" className="shot" onClick={() => setLightbox(state.driver.idCardUrl)} />
              <p>حالة البطاقة: {state.driver.idCardStatus === 'pending' ? 'بانتظار المراجعة' : state.driver.idCardStatus}</p>
            </div>
          )}
          <h3><span className="icon-chip sm"><IconUser /></span>صورتي الشخصية (بتظهر للعميل)</h3>
          {state.driver.photoUrl && <img src={state.driver.photoUrl} alt="صورتي الشخصية" className="avatar avatar-lg" />}
          <PhotoPicker onPick={setProfilePhotoFile} label="اختار صورتي" />
          <button className="btn" onClick={() => uploadProfilePhoto('driver')} disabled={!profilePhotoFile}>حفظ صورتي</button>
          <button className="btn" onClick={() => setDriverFormOpen(false)} disabled={!state.driver.name.trim() || !state.driver.phone.trim()}>حفظ بياناتي</button>
        </>
      ) : (
        <div className="saved-bar">
          {avatar(state.driver.photoUrl, state.driver.name)} {state.driver.name} — {state.driver.phone} — كودك: <b>{state.driver.code}</b>
          {state.driver.idCardUrl && <span> — البطاقة: {state.driver.idCardStatus === 'pending' ? 'بانتظار المراجعة' : state.driver.idCardStatus}</span>}
          <button className="btn small" onClick={() => setDriverFormOpen(true)}><IconEdit /> تعديل بياناتي</button>
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
                <button className="btn danger" onClick={() => setCancelTarget(activeRide.orderNo)}>إلغاء الرحلة</button>
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
                  <a className="btn" href={`tel:${activeRide.driverPhone}`}><IconPhone /> اتصل بالكابتن — {activeRide.driverPhone}</a>
                )}
                {(activeRide.status === 'matched' || activeRide.status === 'driver_arrived') && (
                  <button className="btn danger" onClick={() => setCancelTarget(activeRide.orderNo)}>إلغاء الرحلة</button>
                )}
              </>
            )}
            {cancelTarget === activeRide.orderNo && ['searching', 'matched', 'driver_arrived'].includes(activeRide.status) && (
              <div className="box">
                <h3>سبب الإلغاء</h3>
                {PASSENGER_CANCEL_REASONS.map((reason) => (
                  <label key={reason} className="row">
                    <input type="radio" name="cancel-reason-passenger" checked={cancelReason === reason} onChange={() => setCancelReason(reason)} /> {reason}
                  </label>
                ))}
                {cancelReason === 'سبب آخر…' && (
                  <input placeholder="اكتب السبب" value={cancelReasonOther} onChange={(e) => setCancelReasonOther(e.target.value)} />
                )}
                <div className="row">
                  <button className="btn danger" disabled={!cancelReason || (cancelReason === 'سبب آخر…' && !cancelReasonOther.trim())} onClick={() => cancelRide(activeRide.orderNo, cancelReason === 'سبب آخر…' ? cancelReasonOther.trim() : cancelReason, 'passenger')}>تأكيد الإلغاء</button>
                  <button className="btn small soft" onClick={() => { setCancelTarget(null); setCancelReason(''); setCancelReasonOther('') }}><IconBack /> رجوع</button>
                </div>
              </div>
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
                <input className="field-input" placeholder={pickup && pickup.label === 'موقعي الحالي' ? 'موقعي الحالي' : 'منين؟'} value={pickupLabel} onChange={(e) => { setPickupLabel(e.target.value); if (pickup && pickup.label === 'موقعي الحالي') setPickup(null) }} onBlur={() => setPickupSugg([])} />
                {pickupLabel !== '' && (
                  <button type="button" className="field-clear" aria-label="مسح" onMouseDown={(e) => e.preventDefault()} onClick={() => { setPickupLabel(''); setPickupSugg([]) }}>×</button>
                )}
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
                <input className="field-input" placeholder={destination && destination.label === 'موقعي الحالي' ? 'موقعي الحالي' : 'رايح فين؟'} value={destLabel} onChange={(e) => { setDestLabel(e.target.value); if (destination && destination.label === 'موقعي الحالي') setDestination(null) }} onBlur={() => setDestSugg([])} />
                {destLabel !== '' && (
                  <button type="button" className="field-clear" aria-label="مسح" onMouseDown={(e) => e.preventDefault()} onClick={() => { setDestLabel(''); setDestSugg([]) }}>×</button>
                )}
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

          <h3><span className="icon-chip sm"><IconWallet /></span>سعر المشوار</h3>
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
          <button className="btn big" onClick={requestRide} disabled={requestBusy}>{requestBusy ? 'بيحدد الأماكن…' : <><IconPin /> اطلب توكتوك — {money(fare)}</>}</button>
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
            <button className="btn small soft" onClick={clearPassengerVerification}><IconEdit /> تعديل الرقم</button>
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

  // ---- المحفظة (v49): مكسب اليوم/الأسبوع/الشهر + كل الرحلات (منها الملغاة) ----
  // الحسابات من رحلات السواق نفسه بس (driverCode === كوده) — رحلات البحث
  // (searching) بتاعة سواقين تانيين موجودة في state.rides، فالفلتر ده إجباري
  // ومفيش رحلة لسواق تاني تظهر هنا أبداً.
  const walletStart = periodStartMs(walletPeriod)
  const walletMyRides = state.rides
    .filter((r) => r.driverCode === state.driver.code && (r.status === 'completed' || r.status === 'cancelled'))
    .filter((r) => walletRideTime(r) >= walletStart)
    .sort((a, b) => walletRideTime(b) - walletRideTime(a))
  const walletCompleted = walletMyRides.filter((r) => r.status === 'completed')
  const walletCancelled = walletMyRides.filter((r) => r.status === 'cancelled')
  // المكسب = مجموع أجرة الرحلات المكتملة بس — الملغاة مكسبها صفر ومبتدخلش هنا
  const walletEarnings = walletCompleted.reduce((s, r) => s + r.fare, 0)
  // العمولة = مجموع 5% لكل رحلة مكتملة لوحدها — نفس تقريب الخصم اللي بيتسجل
  // على السيرفر عند إنهاء الرحلة (commissionFor)، فالرقم المعروض مطابق للمديونية
  const walletCommission = walletCompleted.reduce((s, r) => s + commissionFor(r.fare), 0)
  const walletNet = Math.round((walletEarnings - walletCommission) * 100) / 100
  const walletShown = walletFilter === 'completed' ? walletCompleted : walletFilter === 'cancelled' ? walletCancelled : walletMyRides

  const walletView = (
    <div className="card">
      <h2><span className="icon-chip green"><IconWallet /></span>محفظة الكابتن</h2>
      <div className="tabs">
        <button className={walletPeriod === 'day' ? 'tab active' : 'tab'} onClick={() => setWalletPeriod('day')}>📅 اليوم</button>
        <button className={walletPeriod === 'week' ? 'tab active' : 'tab'} onClick={() => setWalletPeriod('week')}>🗓️ الأسبوع</button>
        <button className={walletPeriod === 'month' ? 'tab active' : 'tab'} onClick={() => setWalletPeriod('month')}>📆 الشهر</button>
      </div>
      <p className="muted">{periodLabel(walletPeriod)}</p>
      <div className="wallet-hero">
        <div className="wallet-hero-label">مكسبك {walletPeriod === 'day' ? 'النهارده' : walletPeriod === 'week' ? 'الأسبوع ده' : 'الشهر ده'}</div>
        <div className="wallet-hero-value">{money(walletEarnings)}</div>
        <div className="wallet-hero-net">صافي مكسبك بعد العمولة (5%): <b>{money(walletNet)}</b></div>
      </div>
      <div className="grid wallet-stats">
        <div className="stat-card"><div className="stat-num">🛺 {walletCompleted.length}</div><div className="stat-label">رحلة مكتملة</div></div>
        <div className="stat-card"><div className="stat-num">💸 {money(walletCommission)}</div><div className="stat-label">عمولة 5%</div></div>
        <div className="stat-card"><div className="stat-num">❌ {walletCancelled.length}</div><div className="stat-label">رحلة ملغاة (0 ج.م)</div></div>
        <div className="stat-card"><div className="stat-num">💰 {money(state.driver.totalPaid)}</div><div className="stat-label">إجمالي ما سددته</div></div>
      </div>
      <p>المديونية الحالية: <b>{money(state.driver.debt)}</b> من حد أقصى {money(MAX_DEBT_EGP)}</p>
      <div className="progress"><div className="progress-fill" style={{ width: `${Math.min(100, (state.driver.debt / MAX_DEBT_EGP) * 100)}%` }} /></div>
      <p>رصيدك في المحفظة: <b style={{ color: 'var(--green)' }}>{money(state.driver.balance ?? 0)}</b> — لو حوّلت أكتر من مديونيتك الزيادة بتتحفظ هنا، وعمولات الرحلات الجاية (5%) بتتخصم من الرصيد ده الأول قبل ما تتسجل مديونية.</p>
      {isDebtBlocked(state.driver.debt) && <p className="warn">⛔ وصلت للحد الأقصى — مش هتستقبل رحلات جديدة لحد ما تسدد.</p>}
      <h3><span className="icon-chip sm"><IconSwap /></span>حوّل للإدارة</h3>
      <p>محفظة الإدارة: <b>{state.admin.walletNumber || '— لم يحددها الأدمن بعد —'}</b> ({state.admin.walletName || ''})</p>
      <input placeholder="المبلغ المحوّل (جنيه)" inputMode="numeric" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
      {state.driver.debt > 0 && (
        <button className="btn small soft" onClick={() => setPayAmount(String(state.driver.debt))}>
          سدد المديونية كاملة ({money(state.driver.debt)})
        </button>
      )}
      <PhotoPicker onPick={setPayShot} label="اختار صورة التحويل" />
      <p>صورة التحويل بتتضغط تلقائياً قبل الإرسال (الحد حوالي 250 كيلوبايت).</p>
      <button className="btn" disabled={payBusy} onClick={submitPayment}>{payBusy ? 'بيتبعت…' : 'ابعت طلب التحويل + صورة التحويل'}</button>
      <h3><span className="icon-chip sm"><IconHistory /></span>رحلات الفترة ({walletMyRides.length})</h3>
      <div className="row">
        <button className={walletFilter === 'all' ? 'btn small' : 'btn small soft'} onClick={() => setWalletFilter('all')}>الكل ({walletMyRides.length})</button>
        <button className={walletFilter === 'completed' ? 'btn small' : 'btn small soft'} onClick={() => setWalletFilter('completed')}>مكتملة ({walletCompleted.length})</button>
        <button className={walletFilter === 'cancelled' ? 'btn small' : 'btn small soft'} onClick={() => setWalletFilter('cancelled')}>ملغاة ({walletCancelled.length})</button>
      </div>
      {walletShown.length === 0 && <p className="muted">مفيش رحلات في الفترة دي.</p>}
      {walletShown.map((r) => (
        <div key={r.orderNo} className="ride">
          <b>{r.orderNo}</b> — {fmtDate(walletRideTime(r))} {fmtTime(walletRideTime(r))} — {r.status === 'completed' ? <span className="badge green">مكتملة ✅</span> : <span className="badge red">ملغاة ❌</span>}
          <br />من: {r.pickup.label} — إلى: {r.destination.label}
          <br />{r.status === 'completed'
            ? <>الأجرة: <b>{money(r.fare)}</b> — العمولة: {money(commissionFor(r.fare))}</>
            : <>الأجرة: <b>0 ج.م</b> — {r.cancelledBy === 'passenger' ? 'العميل' : 'أنت'} لغيتها{r.cancelReason ? ` — السبب: ${r.cancelReason}` : ''}</>}
        </div>
      ))}
      <h3><span className="icon-chip sm"><IconList /></span>طلباتي</h3>
      {state.payments.filter((p) => p.driverCode === state.driver.code).map((p) => (
        <div key={p.id} className="ride">{p.id} — {money(p.amount)} — {p.status === 'pending' ? 'بانتظار الإدارة' : p.status === 'approved' ? '✅ اتوافق عليه' : '❌ اترفض'}
          {p.screenshotUrl && <img src={p.screenshotUrl} alt="صورة التحويل — اضغط للتكبير" className="shot" onClick={() => setLightbox(p.screenshotUrl)} />}
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

  /** الأدمن يقلب مفتاح الإطلاق (v44) — يشتغل فوراً من غير تحديث للتطبيق:
   *  الركاب بيقروا العلم من السيرفر في كل مرة قبل إنشاء الطلب. */
  async function toggleLaunch() {
    const next = !launch.launched
    setLaunchBusy(true)
    await saveDoc('settings', 'launch', { launched: next, driversTarget: launch.driversTarget })
    setLaunch({ launched: next, driversTarget: launch.driversTarget })
    setLaunchBusy(false)
    showNotice(next ? 'الخدمة اشتغلت للركاب ✅ — الطلبات مفتوحة دلوقتي.' : 'وقّفنا الطلبات مؤقتاً — الركاب هيشوفوا رسالة الانتظار.')
  }

  // (v48) حفظ رقم محفظة الأدمن على السيرفر — قبل كده كان محلي بس على
  // جهاز صلاح، فالسواقين على موبايلاتهم كانوا بيشوفوا «لم يحددها الأدمن بعد».
  function saveAdminWallet() {
    const a = stateRef.current.admin
    void saveAdminSettings({ walletNumber: a.walletNumber, walletName: a.walletName })
    showNotice('رقم المحفظة اتحفظ — السواقين هيشوفوه على موبايلاتهم.')
  }

  const adminView = (
    <div className="card">
      <h2><span className="icon-chip"><IconShield /></span>الإدارة — صلاح</h2>
      <h3><span className="icon-chip sm"><IconWallet /></span>رقم محفظتي</h3>
      <div className="grid">
        <input placeholder="رقم المحفظة" value={state.admin.walletNumber} onChange={(e) => update({ admin: { ...state.admin, walletNumber: e.target.value } })} onBlur={saveAdminWallet} />
        <input placeholder="الاسم على المحفظة" value={state.admin.walletName} onChange={(e) => update({ admin: { ...state.admin, walletName: e.target.value } })} onBlur={saveAdminWallet} />
      </div>
      <button className="btn small" onClick={saveAdminWallet}><IconCheck /> حفظ رقم المحفظة</button>
      <h3><span className="icon-chip sm"><IconSettings /></span>تشغيل الخدمة للركاب 🚀</h3>
      <p className="muted">
        {launch.launched
          ? 'الخدمة شغالة — الركاب يقدروا يطلبوا دلوقتي ✅'
          : `لسه ما اشتغلناش — بنجمع ${launch.driversTarget} كابتن الأول ⏳`}
      </p>
      <p className="muted">مستنيين الإطلاق: {state.launchWaitlist.length} عميل سابوا أرقامهم عشان نبلغهم لما نبدأ.</p>
      <button className="btn" disabled={launchBusy} onClick={() => void toggleLaunch()}>
        {launch.launched ? 'وقّف الطلبات مؤقتاً ⏸️' : 'شغّل الخدمة للركاب 🚀'}
      </button>
      {state.launchWaitlist.length > 0 && (
        <div>
          {[...state.launchWaitlist].sort((a, b) => b.createdAt - a.createdAt).map((w) => (
            <div key={w.id} className="ride">
              {w.name} — <a className="phone-chip" href={`tel:${w.phone}`}><IconPhone /> {w.phone}</a>
              <br />سجّل: {w.createdAt ? fmtTime(w.createdAt) : '—'}
            </div>
          ))}
        </div>
      )}
      <h3><span className="icon-chip sm"><IconWallet /></span>طلبات التحويل الواردة</h3>
      {state.payments.length === 0 && <p>مفيش طلبات تحويل دلوقتي.</p>}
      {state.payments.map((p) => (
        <div key={p.id} className="ride">
          {p.driverName} ({p.driverCode}) — {money(p.amount)} — {p.status}
          {p.screenshotUrl && <img src={p.screenshotUrl} alt="صورة التحويل — اضغط للتكبير" className="shot" onClick={() => setLightbox(p.screenshotUrl)} />}
          {p.status === 'pending' && (
            <div className="row">
              <button className="btn" onClick={() => reviewPayment(p.id, true)}>الفلوس وصلت — موافق ✅</button>
              <button className="btn danger" onClick={() => reviewPayment(p.id, false)}>الفلوس موصلتش — رفض ❌</button>
            </div>
          )}
        </div>
      ))}
      <h3><span className="icon-chip sm"><IconShield /></span>صور بطاقات السواقين للمراجعة</h3>
      {pendingIdCards.length === 0 && <p>مفيش بطاقات مستنية المراجعة.</p>}
      {pendingIdCards.map((d) => (
        <div key={d.code} className="ride">
          {d.name} ({d.code}) — <a className="phone-chip" href={`tel:${d.phone}`}><IconPhone /> {d.phone}</a>
          {d.idCardUrl && <img src={d.idCardUrl} alt="بطاقة السواق — اضغط للتكبير" className="shot" onClick={() => setLightbox(d.idCardUrl)} />}
          <div className="row">
            <button className="btn" onClick={() => reviewDriverIdCard(d.code, 'approved')}>اعتماد البطاقة</button>
            <button className="btn danger" onClick={() => reviewDriverIdCard(d.code, 'rejected')}>رفض البطاقة</button>
          </div>
        </div>
      ))}
      <h3><span className="icon-chip sm"><IconUser /></span>المستخدمون</h3>
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
          {avatar(d.photoUrl, d.name)} <b>{d.name}</b> ({d.code}) — <a className="phone-chip" href={`tel:${d.phone}`}><IconPhone /> {d.phone}</a>
          <br />★ {d.ratingAvg} ({d.ratingCount} تقييم) — {d.plate} {d.model} {d.color}
          <br />مديونية: {money(d.debt)} — رصيد: {money(d.balance)} — إجمالي المسدد: {money(d.totalPaid)}
          <br />البطاقة: {idCardStatusLabel(d.idCardStatus)} — سجّل: {d.createdAt ? fmtTime(d.createdAt) : 'قبل v30 — التاريخ مش معروف'}
          <br /><button className="btn small" onClick={() => { if (confirm(`تصفّر التقييم والمحفظة للسواق ${d.name} (${d.code})؟ الصورة والبطاقة وبياناته هيفضلوا زي ما هم.`)) void saveDoc('drivers', d.code, { ratingAvg: 0, ratingCount: 0, debt: 0, balance: 0, totalPaid: 0 }) }}>تصفير التقييم والمحفظة</button>
          {d.idCardUrl && <img src={d.idCardUrl} alt="بطاقة السواق — اضغط للتكبير" className="shot" onClick={() => setLightbox(d.idCardUrl)} />}
        </div>
      ))}
      {adminUserTab === 'passengers' && adminPassengerUsers.map((p) => (
        <div key={p.code} className="ride">
          {avatar(p.photoUrl, p.name)} <b>{p.name}</b> ({p.code}) — <a className="phone-chip" href={`tel:${p.phone}`}><IconPhone /> {p.phone}</a>
          <br />★ {p.ratingAvg} ({p.ratingCount} تقييم) — سجّل: {p.createdAt ? fmtTime(p.createdAt) : 'قبل v30 — التاريخ مش معروف'}
        </div>
      ))}
      <h3><span className="icon-chip sm"><IconBell /></span>قايمة انتظار التوسع 🔔</h3>
      <p className="muted">عملاء من برّه أسيوط وسوهاج سابوا أرقامهم عشان نبلغهم لما نفتح عندهم: {state.waitlist.length}</p>
      {state.waitlist.length === 0 && <p>مفيش حد مستني التوسع لسه.</p>}
      {[...state.waitlist].sort((a, b) => b.createdAt - a.createdAt).map((w) => (
        <div key={w.id} className="ride">
          {w.name} ({w.code}) — <a className="phone-chip" href={`tel:${w.phone}`}><IconPhone /> {w.phone}</a>
          <br />من: {w.pickupLabel} → إلى: {w.destLabel}
          <br />سجّل: {w.createdAt ? fmtTime(w.createdAt) : '—'}
        </div>
      ))}
      <h3><span className="icon-chip sm"><IconList /></span>كل الرحلات</h3>
      <input placeholder="🔍 ابحث برقم الطلب أو الكود أو الاسم أو الرقم…" value={search} onChange={(e) => setSearch(e.target.value)} />
      {filteredRides.map((r) => (
        <div key={r.orderNo} className="ride">
          <b>{r.orderNo}</b> — {r.passengerName} ({r.passengerCode}) — {r.passengerPhone} — السواق: {r.driverName || '—'} ({r.driverCode || '—'}) — {money(r.fare)} — {r.status}
          <br />من: {r.pickup.label} → إلى: {r.destination.label}
          <br />تقييم الراكب للكابتن: {r.passengerRatingForDriver ?? '—'} — تقييم الكابتن للراكب: {r.driverRatingForPassenger ?? '—'}
        </div>
      ))}
      <button className="btn danger" onClick={() => { if (confirm('متأكد؟ هيمسح كل البيانات المحلية التجريبية.')) update(defaultState()) }}><IconTrash /> مسح البيانات التجريبية</button>
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
      <button className="btn small soft" onClick={() => { setOtpSent(false); setOtpInput('') }}><IconBack /> تغيير الرقم</button>
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
  /** تكبير أي صورة (بطاقة سواق أو سكرين شوت تحويل) بملء الشاشة (v49) —
   *  الضغط على الصورة نفسها مبيقفلهاش (عشان تكبّر وتشوف التفاصيل)،
   *  الخروج بالضغط برّه الصورة أو على زرار ✕ */
  const lightboxModal = lightbox ? (
    <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
      <button className="lightbox-close" onClick={() => setLightbox(null)} aria-label="إغلاق">✕</button>
      <img src={lightbox} alt="صورة مكبّرة" className="lightbox-img" onClick={(e) => e.stopPropagation()} />
      <p className="lightbox-hint">اضغط برّه الصورة للخروج</p>
    </div>
  ) : null
  /** تحديث جوّه التطبيق من غير لينكات: يحمّل الـ APK ويفتح مثبّت أندرويد */
  async function installUpdate(apkUrl: string, expectedSha256?: string) {
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
        // (v48) تحقق من سلامة الـ APK قبل التثبيت — لو الـ sha256 اللي في
        // version.json مش مطابق للملف اللي اتحمّل، مفيش تثبيت (ممكن يكون
        // ملف تالف أو متبدّل). لو version.json مفيهوش sha256، بنكمل زي قبل كده.
        if (expectedSha256) {
          const { data } = await Filesystem.readFile({ path: 'ind-toktok-update.apk', directory: Directory.Cache })
          const actual = await sha256HexOfBase64(typeof data === 'string' ? data : '')
          if (actual && actual.toLowerCase() !== expectedSha256.toLowerCase()) {
            setUpdateError('الملف اللي اتحمّل مش سليم — جرّب «حدّث دلوقتي» تاني.')
            return
          }
        }
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

  /** SHA-256 لملف مقروء Base64 — null لو المتصفح مش بيدعم التشفير. */
  async function sha256HexOfBase64(b64: string): Promise<string | null> {
    try {
      const subtle = (globalThis.crypto as Crypto | undefined)?.subtle
      if (!subtle) return null
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const hash = await subtle.digest('SHA-256', bytes)
      return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
    } catch {
      return null
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
          <button className="btn" disabled={updateBusy} onClick={() => installUpdate(availableUpdate.apkUrl, availableUpdate.sha256)}>{updateBusy ? (updateProgress > 0 ? `بيحمّل التحديث… ${updateProgress}%` : 'بيحمّل التحديث…') : 'حدّث دلوقتي ⬇'}</button>
          <button className="btn small" onClick={dismissUpdate}>بعدين</button>
        </div>
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
  // مودال بوابة الإطلاق (v44) — الخدمة لسه ما اشتغلتش: رسالة ودودة + زر «بلّغني»
  const launchGateModal = launchGate ? (
    <div className="notice-overlay" onClick={() => setLaunchGate(false)}>
      <div className="notice-modal" onClick={(e) => e.stopPropagation()}>
        <div className="notice-icon">⏳</div>
        <p><b>لسه ما اشتغلناش ⏳</b></p>
        <p>بنجمع {launch.driversTarget} كابتن الأول وبعدها هنبدأ الشغل في أسيوط وسوهاج — سجّل رقمك وهنبعتلك أول ما نبدأ.</p>
        <div className="row">
          <button className="btn" onClick={notifyLaunch}>🔔 بلّغني لما نبدأ</button>
          <button className="btn small" onClick={() => setLaunchGate(false)}>تمام</button>
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
            <button className="btn small soft" onClick={() => { setAppRole(null); localStorage.removeItem('indtoktok-app-role'); setRole('passenger') }}><IconBack /> تغيير الدور</button>
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
      {lightboxModal}
      {updateModal}
      {outOfAreaModal}
      {launchGateModal}
      {role === 'passenger' && passengerView}
      {role === 'myRequests' && passengerTripsView}
      {role === 'driver' && driverView}
      {role === 'trips' && driverTripsView}
      {role === 'wallet' && walletView}
      {role === 'profile' && (appRole === 'driver' ? driverProfileView : passengerProfileView)}
      {role === 'admin' && isAdmin && (<><button className="btn small" onClick={() => setRole('driver')}><IconBack /> رجوع للسواق</button>{adminView}</>)}
      {role === 'admin' && !isAdmin && driverView}
      <footer className="footer">
        <p>آخر رحلة: {lastRide ? `${lastRide.orderNo} — ${lastRide.status}` : 'لسه مفيش رحلات'}</p>
        {appRole === 'passenger' && <button className="btn small" onClick={() => chooseRole('driver')}><IconDriver /> أنا كابتن — دخول السواقين</button>}
        {appRole === 'driver' && (
          <div className="footer-links">
            {isAdmin && <button className="btn small" onClick={() => setRole('admin')}><IconShield /> الإدارة</button>}
            <button className="btn small soft" onClick={() => chooseRole('passenger')}><IconSwap /> تبديل — أنا راكب</button>
          </div>
        )}
        <p className="muted">ind toktok — com.indtoktok.app — نسخة مستقلة (Capacitor + Firebase) — الإصدار {APP_VERSION}</p>
      </footer>
    </div>
  )
}
