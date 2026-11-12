import { useEffect, useRef, useState } from 'react'
import MapView from './MapView'
import type { MapMode } from './MapView'
import { firebaseEnabled } from './firebaseDb'
import { uploadImageAsDataUrl, saveDoc } from './firebaseDb'
import { isFirebaseConfigured } from './firebaseConfig'
import { otpRemaining, sendOtpCode, verifyOtpCode } from './otp'
import {
  clientCodeForPhone,
  commissionFor,
  DEMO_DRIVERS,
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
import type { LatLng, Offer, Ride, Role } from './types'

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

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState())
  const [role, setRole] = useState<Role>('passenger')
  const [pickup, setPickup] = useState<LatLng | null>(null)
  const [destination, setDestination] = useState<LatLng | null>(null)
  const [pickupLabel, setPickupLabel] = useState('')
  const [destLabel, setDestLabel] = useState('')
  const [pickMode, setPickMode] = useState<MapMode>('pickup')
  const [fareText, setFareText] = useState('25')
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState('')
  // تسجيل العميل + OTP
  const [regName, setRegName] = useState('')
  const [regPhone, setRegPhone] = useState('')
  const [editingPhone, setEditingPhone] = useState(false)
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

  // ---- مشاركة موقع السواق المباشر كل 5 ثواني ----
  useEffect(() => {
    if (!state.driver.sharingLocation || !state.driver.online) return
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
          // بدون GPS: حركة تجريبية قرب نقطة الركوب
          setState((s) => {
            const r = s.rides.find((x) => x.status === 'matched')
            if (!r) return s
            const lat = (r.driverLat ?? r.pickup.lat + 0.01) - 0.001
            const lng = (r.driverLng ?? r.pickup.lng + 0.01) - 0.001
            return {
              ...s,
              driver: { ...s.driver, currentLat: lat, currentLng: lng },
              rides: s.rides.map((x) =>
                x.orderNo === r.orderNo
                  ? { ...x, driverLat: lat, driverLng: lng, driverLocAt: Date.now() }
                  : x,
              ),
            }
          })
        },
        { enableHighAccuracy: true },
      )
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [state.driver.sharingLocation, state.driver.online])

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

  // ---- طلب رحلة ----
  function requestRide() {
    if (!state.passenger) {
      showNotice('سجل برقم تليفونك الأول.')
      return
    }
    if (!pickup || !destination) {
      showNotice('حدد نقطة الركوب والوجهة الأول.')
      return
    }
    const orderNum = state.lastOrderNum + 1
    const ride: Ride = {
      orderNo: `#${orderNum}`,
      passengerCode: state.passenger.code,
      passengerName: state.passenger.name,
      passengerPhone: state.passenger.phone,
      passengerRating: state.passenger.ratingAvg,
      pickup,
      destination,
      fare,
      status: 'searching',
      driverCode: null,
      driverName: null,
      driverLat: null,
      driverLng: null,
      driverLocAt: null,
      offers: [],
      createdAt: Date.now(),
      passengerRatingForDriver: null,
      driverRatingForPassenger: null,
    }
    update({ rides: [...state.rides, ride], lastOrderNum: orderNum })
    void saveDoc('rides', ride.orderNo, ride as unknown as Record<string, unknown>)
    showNotice(`طلبك ${ride.orderNo} اتبعت للسواقين القريبين.`)
    // عروض تجريبية من السواقين (في Firebase الحقيقي تأتي من السواقين فعلاً)
    DEMO_DRIVERS.forEach((d, i) => {
      setTimeout(() => {
        setState((s) => {
          const r = s.rides.find((x) => x.orderNo === ride.orderNo)
          if (!r || r.status !== 'searching') return s
          const offer: Offer = {
            id: `${ride.orderNo}-${d.code}`,
            rideId: ride.orderNo,
            driverCode: d.code,
            driverName: d.name,
            driverRating: d.rating,
            price: Math.max(FARE_MIN, fare + (i === 0 ? 0 : i * 5)),
            etaMinutes: 3 + i * 2,
            plate: d.plate,
            color: d.color,
            model: d.model,
          }
          return {
            ...s,
            rides: s.rides.map((x) =>
              x.orderNo === ride.orderNo ? { ...x, offers: [...x.offers, offer] } : x,
            ),
          }
        })
      }, 2000 + i * 1500)
    })
  }

  function acceptOffer(ride: Ride, offer: Offer) {
    const updated: Ride = {
      ...ride,
      status: 'matched',
      driverCode: offer.driverCode,
      driverName: offer.driverName,
      driverLat: ride.pickup.lat + 0.012,
      driverLng: ride.pickup.lng + 0.012,
      driverLocAt: Date.now(),
    }
    update({ rides: state.rides.map((r) => (r.orderNo === ride.orderNo ? updated : r)) })
    showNotice(`الكابتن ${offer.driverName} في الطريق إليك.`)
  }

  function setRideStatus(orderNo: string, status: Ride['status']) {
    setState((s) => {
      const rides = s.rides.map((r) => (r.orderNo === orderNo ? { ...r, status } : r))
      const ride = rides.find((r) => r.orderNo === orderNo)
      if (status === 'completed' && ride) {
        const commission = commissionFor(ride.fare)
        return { ...s, rides, debt: Math.round((s.debt + commission) * 100) / 100 }
      }
      return { ...s, rides }
    })
  }

  function submitRating(orderNo: string, by: 'passenger' | 'driver', value: number) {
    setState((s) => {
      const rides = s.rides.map((r) => {
        if (r.orderNo !== orderNo) return r
        return by === 'passenger'
          ? { ...r, passengerRatingForDriver: value }
          : { ...r, driverRatingForPassenger: value }
      })
      const ride = rides.find((r) => r.orderNo === orderNo)
      let passenger = s.passenger
      let driver = s.driver
      if (ride && by === 'passenger' && ride.driverCode) {
        const n = driver.ratingCount + 1
        driver = {
          ...driver,
          ratingAvg: Math.round(((driver.ratingAvg * driver.ratingCount + value) / n) * 10) / 10,
          ratingCount: n,
        }
      }
      if (ride && by === 'driver' && passenger) {
        const n = passenger.ratingCount + 1
        passenger = {
          ...passenger,
          ratingAvg:
            Math.round(((passenger.ratingAvg * passenger.ratingCount + value) / n) * 10) / 10,
          ratingCount: n,
        }
      }
      return { ...s, rides, passenger, driver }
    })
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
    try {
      const res = await sendOtpCode(phone)
      if (!res.ok) {
        showNotice(res.message)
        return
      }
      // تحقق فوري (أندرويد): الرقم اتأكد من غير SMS — كمّل التسجيل على طول
      if (res.autoVerified) {
        finishPhoneVerified()
        showNotice(res.message)
        return
      }
      setOtpSent(true)
      showNotice(res.message)
    } finally {
      setOtpBusy(false)
    }
  }

  /** يحفظ ملف العميل بعد تأكيد رقمه (يستخدمه تأكيد الكود والتحقق الفوري). */
  function finishPhoneVerified() {
    const phone = regPhone.trim()
    const profile = {
      name: regName.trim() || 'عميل',
      phone,
      code: clientCodeForPhone(phone),
      phoneVerified: true,
      ratingAvg: 0,
      ratingCount: 0,
    }
    update({ passenger: profile })
    void saveDoc('passengers', phone, profile)
    setEditingPhone(false)
    setOtpSent(false)
    setOtpInput('')
    showNotice(`أهلاً ${profile.name}! رقمك اتأكد وكودك ${profile.code}.`)
  }

  async function verifyOtp() {
    setOtpBusy(true)
    try {
      const res = await verifyOtpCode(otpInput)
      if (!res.ok) {
        showNotice(res.message)
        return
      }
      finishPhoneVerified()
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
    setState((s) => {
      const payment = s.payments.find((p) => p.id === id)
      if (!payment) return s
      const payments = s.payments.map((p) =>
        p.id === id
          ? { ...p, status: (approve ? 'approved' : 'rejected') as 'approved' | 'rejected' }
          : p,
      )
      if (!approve) return { ...s, payments }
      return {
        ...s,
        payments,
        debt: Math.max(0, Math.round((s.debt - payment.amount) * 100) / 100),
        totalPaid: Math.round((s.totalPaid + payment.amount) * 100) / 100,
      }
    })
    showNotice(approve ? 'تمت الموافقة — المديونية اتخصمت فوراً.' : 'تم رفض الطلب.')
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

  const filteredRides = state.rides.filter((r) => {
    const q = search.trim()
    if (!q) return true
    return [r.orderNo, r.passengerCode, r.driverCode || '', r.passengerName, r.passengerPhone]
      .join(' ')
      .includes(q)
  })

  const driverView = (
    <div className="card">
      <h2>🛺 بيانات الكابتن</h2>
      <div className="grid">
        <input placeholder="الاسم" value={state.driver.name} onChange={(e) => update({ driver: { ...state.driver, name: e.target.value } })} />
        <input placeholder="رقم التليفون" value={state.driver.phone} onChange={(e) => update({ driver: { ...state.driver, phone: e.target.value } })} />
        <input placeholder="رقم اللوحة" value={state.driver.plate} onChange={(e) => update({ driver: { ...state.driver, plate: e.target.value } })} />
        <input placeholder="اللون" value={state.driver.color} onChange={(e) => update({ driver: { ...state.driver, color: e.target.value } })} />
        <input placeholder="الموديل" value={state.driver.model} onChange={(e) => update({ driver: { ...state.driver, model: e.target.value } })} />
      </div>
      <p>كود السواق: <b>{state.driver.code}</b> — التقييم: {state.driver.ratingAvg} ★ ({state.driver.ratingCount})</p>
      <label className="row">
        <input type="checkbox" checked={state.driver.online} onChange={(e) => update({ driver: { ...state.driver, online: e.target.checked } })} />
        متاح لاستقبال الرحلات
      </label>
      <label className="row">
        <input type="checkbox" checked={state.driver.sharingLocation} onChange={(e) => update({ driver: { ...state.driver, sharingLocation: e.target.checked } })} />
        مشاركة موقعي مباشرة (يتحدث كل 5 ثواني)
      </label>
      {isDebtBlocked(state.debt) && (
        <p className="warn">⛔ وصلت لحد المديونية ({money(MAX_DEBT_EGP)}) — مش هتستقبل رحلات جديدة لحد ما تسدد.</p>
      )}
      <h3>صورة البطاقة الشخصية</h3>
      <p>الصورة بتتضغط تلقائياً قبل الرفع (الحد حوالي 250 كيلوبايت) وتتحفظ في حسابك.</p>
      <input type="file" accept="image/*" onChange={(e) => setIdCardFile(e.target.files?.[0] || null)} />
      <button className="btn" onClick={uploadIdCard} disabled={!idCardFile}>رفع صورة البطاقة</button>
      {state.driver.idCardUrl && (
        <div>
          <img src={state.driver.idCardUrl} alt="صورة البطاقة" className="shot" />
          <p>حالة البطاقة: {state.driver.idCardStatus === 'pending' ? 'بانتظار المراجعة' : state.driver.idCardStatus}</p>
        </div>
      )}
      <h3>الطلبات الواردة</h3>
      {state.rides.filter((r) => r.status === 'searching').length === 0 && <p>مفيش طلبات دلوقتي.</p>}
      {state.rides.filter((r) => r.status === 'searching').map((r) => (
        <div key={r.orderNo} className="ride">
          <b>{r.orderNo}</b> — {r.passengerName} ({r.passengerCode}) — تقييم العميل: {r.passengerRating} ★
          <br />من: {r.pickup.label} — إلى: {r.destination.label}
          <br />السعر المقترح: <b>{money(r.fare)}</b>
          <br />
          <a className="link" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${r.pickup.lat},${r.pickup.lng}`}>الاتجاهات لنقطة الركوب ↗</a>
          <br />
          <button className="btn" disabled={isDebtBlocked(state.debt) || !state.driver.online} onClick={() => {
            const offer: Offer = { id: `${r.orderNo}-${state.driver.code}`, rideId: r.orderNo, driverCode: state.driver.code, driverName: state.driver.name || 'الكابتن', driverRating: state.driver.ratingAvg, price: r.fare, etaMinutes: 5, plate: state.driver.plate, color: state.driver.color, model: state.driver.model }
            update({ rides: state.rides.map((x) => x.orderNo === r.orderNo ? { ...x, offers: [...x.offers, offer] } : x) })
            showNotice('عرضك اتبعت للعميل.')
          }}>اقبل بالسعر ({money(r.fare)})</button>
        </div>
      ))}
      <h3>رحلتي الحالية</h3>
      {activeRide && activeRide.status !== 'searching' && (
        <div className="ride">
          <b>{activeRide.orderNo}</b> — {activeRide.passengerName} — {activeRide.status === 'matched' ? 'في الطريق للعميل' : activeRide.status === 'driver_arrived' ? 'وصلت للعميل' : 'الرحلة شغالة'}
          <div className="row">
            {activeRide.status === 'matched' && <button className="btn" onClick={() => setRideStatus(activeRide.orderNo, 'driver_arrived')}>وصلت للعميل</button>}
            {activeRide.status === 'driver_arrived' && <button className="btn" onClick={() => setRideStatus(activeRide.orderNo, 'on_trip')}>ابدأ الرحلة</button>}
            {activeRide.status === 'on_trip' && <button className="btn" onClick={() => setRideStatus(activeRide.orderNo, 'completed')}>وصلنا — إنهاء الرحلة</button>}
          </div>
          {activeRide.status === 'completed' && (
            <div>
              <p>قيّم العميل بعد الرحلة:</p>
              {stars(ratePassenger, (n) => { setRatePassenger(n); submitRating(activeRide.orderNo, 'driver', n) })}
            </div>
          )}
        </div>
      )}
    </div>
  )

  const passengerView = (
    <div className="card">
      <h2>🚕 اطلب توكتوك</h2>
      {!state.passenger || editingPhone ? (
        <div className="box">
          <h3>التسجيل برقم التليفون — مرة واحدة بس</h3>
          <input placeholder="الاسم" value={regName} onChange={(e) => setRegName(e.target.value)} />
          <input placeholder="رقم التليفون (11 رقم)" inputMode="tel" value={regPhone} onChange={(e) => setRegPhone(e.target.value)} />
          {/* reCAPTCHA مخفي — Firebase Phone Auth بيحتاجه على الويب */}
          <div id="recaptcha-container" />
          {!otpSent ? (
            <button className="btn" onClick={requestOtp} disabled={otpBusy}>{otpBusy ? 'بيبعت الكود…' : 'ابعت كود التحقق'}</button>
          ) : (
            <div>
              <input placeholder="الكود (6 أرقام)" inputMode="numeric" maxLength={6} value={otpInput} onChange={(e) => setOtpInput(e.target.value.replace(/[^0-9]/g, ''))} />
              <button className="btn" onClick={verifyOtp} disabled={otpBusy}>{otpBusy ? 'بيتأكد…' : 'تأكيد الكود'}</button>
              <p className="muted">📩 الكود اتبعت في رسالة SMS على رقمك — اكتب الكود اللي وصلك، ومش بيظهر جوه التطبيق.</p>
              <p className="muted">حد إرسال الكود: {OTP_MAX_PER_HOUR} أكواد في الساعة لكل رقم — فاضل {otpRemaining(regPhone.trim())} من {OTP_MAX_PER_HOUR} (حد Firebase: 10 رسايل SMS في اليوم لحد ما تضيف فوترة للمشروع).</p>
              <button className="link-btn" onClick={() => { setOtpSent(false); setOtpInput('') }}>تغيير الرقم / طلب كود جديد</button>
            </div>
          )}
          {state.passenger && <button className="link-btn" onClick={() => setEditingPhone(false)}>إلغاء</button>}
        </div>
      ) : (
        <div className="saved-bar">
          👤 {state.passenger.name} — {state.passenger.phone} — كودك: <b>{state.passenger.code}</b> ✓ موثق
          <button className="link-btn" onClick={() => { setRegName(state.passenger?.name || ''); setRegPhone(state.passenger?.phone || ''); setEditingPhone(true) }}>تعديل الرقم</button>
        </div>
      )}

      <div className="grid">
        <div>
          <label>نقطة الركوب</label>
          <input placeholder="منين؟" value={pickupLabel} onChange={(e) => setPickupLabel(e.target.value)} />
          <div className="row">
            <button className="btn small" onClick={() => useMyLocation('pickup')}>📍 موقعي الحالي</button>
            <button className={pickMode === 'pickup' ? 'btn small active' : 'btn small'} onClick={() => setPickMode('pickup')}>حدّد على الخريطة</button>
          </div>
        </div>
        <div>
          <label>الوجهة</label>
          <input placeholder="رايح فين؟" value={destLabel} onChange={(e) => setDestLabel(e.target.value)} />
          <div className="row">
            <button className="btn small" onClick={() => useMyLocation('destination')}>📍 موقعي الحالي</button>
            <button className={pickMode === 'destination' ? 'btn small active' : 'btn small'} onClick={() => setPickMode('destination')}>حدّد على الخريطة</button>
          </div>
        </div>
      </div>

      <MapView
        pickup={pickup}
        destination={destination}
        driver={activeRide?.driverLat && activeRide?.driverLng ? { lat: activeRide.driverLat, lng: activeRide.driverLng, label: activeRide.driverName || 'الكابتن' } : null}
        pickMode={pickMode}
        onPick={onMapPick}
      />
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
      <button className="btn big" onClick={requestRide}>اطلب توكتوك — {money(fare)}</button>

      {activeRide && (
        <div className="ride">
          <b>{activeRide.orderNo}</b> — {activeRide.status === 'searching' ? 'بندور على سواقين…' : activeRide.status === 'matched' ? `الكابتن ${activeRide.driverName} في الطريق إليك 🛺` : activeRide.status}
          {activeRide.driverLocAt && <p className="muted">موقع السواق اتحدّث {new Date(activeRide.driverLocAt).toLocaleTimeString('ar-EG')}</p>}
          {activeRide.status === 'searching' && activeRide.offers.map((o) => (
            <div key={o.id} className="offer">
              <b>{o.driverName}</b> — {o.driverRating} ★ — {o.model} {o.color} ({o.plate}) — يوصل في {o.etaMinutes} دقيقة
              <br />السعر: <b>{money(o.price)}</b>
              <button className="btn" onClick={() => acceptOffer(activeRide, o)}>اختار الكابتن ده</button>
            </div>
          ))}
          {activeRide.status === 'completed' && (
            <div>
              <p>قيّم الكابتن بعد الرحلة (تقييمك يظهر للعميل اللي بعده):</p>
              {stars(rateDriver, (n) => { setRateDriver(n); submitRating(activeRide.orderNo, 'passenger', n) })}
            </div>
          )}
        </div>
      )}
    </div>
  )

  const walletView = (
    <div className="card">
      <h2>💰 محفظة الكابتن</h2>
      <p>المديونية الحالية: <b>{money(state.debt)}</b> من حد أقصى {money(MAX_DEBT_EGP)}</p>
      <div className="progress"><div className="progress-fill" style={{ width: `${Math.min(100, (state.debt / MAX_DEBT_EGP) * 100)}%` }} /></div>
      <p>إجمالي ما سددته: {money(state.totalPaid)} — العمولة 5% من كل رحلة مكتملة تتسجل مديونية تلقائياً.</p>
      {isDebtBlocked(state.debt) && <p className="warn">⛔ وصلت للحد الأقصى — مش هتستقبل رحلات جديدة لحد ما تسدد.</p>}
      <h3>حوّل للإدارة</h3>
      <p>محفظة الإدارة: <b>{state.admin.walletNumber || '— لم يحددها الأدمن بعد —'}</b> ({state.admin.walletName || ''})</p>
      <input placeholder="المبلغ المحوّل (جنيه)" inputMode="numeric" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
      <input type="file" accept="image/*" onChange={(e) => setPayShot(e.target.files?.[0] || null)} />
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

  const adminView = (
    <div className="card">
      <h2>🛡️ الإدارة — صلاح</h2>
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
      {state.driver.idCardUrl ? (
        <div className="ride">
          {state.driver.name} ({state.driver.code}) — حالة البطاقة: {state.driver.idCardStatus}
          <img src={state.driver.idCardUrl} alt="بطاقة السواق" className="shot" />
          <div className="row">
            <button className="btn" onClick={() => update({ driver: { ...state.driver, idCardStatus: 'approved' } })}>اعتماد البطاقة</button>
            <button className="btn danger" onClick={() => update({ driver: { ...state.driver, idCardStatus: 'rejected' } })}>رفض البطاقة</button>
          </div>
        </div>
      ) : <p>مفيش بطاقات مرفوعة دلوقتي.</p>}
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

  return (
    <div className="app" dir="rtl">
      <header className="header">
        <h1>🛺 ind toktok</h1>
        <p className="tagline">توكتوك زي inDrive — الراكب يسمّي سعره والسواقين يعرضوا</p>
        <span className="badge">{isFirebaseConfigured ? '☁️ Firebase متصل' : '🧪 وضع تجريبي محلي — Firebase مش مربوط بعد'}</span>
        {!firebaseEnabled && <p className="muted">للتشغيل الحقيقي: أنشئ مشروع Firebase باسم ind-toktok والصق الـ config في src/firebaseConfig.ts — شوف README.md</p>}
      </header>
      <nav className="tabs">
        <button className={role === 'passenger' ? 'tab active' : 'tab'} onClick={() => setRole('passenger')}>راكب</button>
        <button className={role === 'driver' ? 'tab active' : 'tab'} onClick={() => setRole('driver')}>سواق</button>
        <button className={role === 'driver' ? 'tab active' : 'tab'} onClick={() => setRole('driver')}>محفظة السواق</button>
        <button className={role === 'admin' ? 'tab active' : 'tab'} onClick={() => setRole('admin')}>الإدارة</button>
      </nav>
      {notice && <div className="notice">{notice}</div>}
      {role === 'passenger' && passengerView}
      {role === 'driver' && (
        <>
          {driverView}
          {walletView}
        </>
      )}
      {role === 'admin' && adminView}
      <footer className="footer">
        <p>آخر رحلة: {lastRide ? `${lastRide.orderNo} — ${lastRide.status}` : 'لسه مفيش رحلات'}</p>
        <p className="muted">ind toktok — com.indtoktok.app — نسخة مستقلة (Capacitor + Firebase)</p>
      </footer>
    </div>
  )
}
