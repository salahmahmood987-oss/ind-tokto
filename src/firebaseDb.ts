// ---------------------------------------------------------------------------
//  طبقة Firebase — Firestore فقط (بدون Storage)
//  تعمل فقط عندما يلصق صلاح الـ config الحقيقي في src/firebaseConfig.ts.
//  في الوضع التجريبي المحلي، كل الدوال ترجع null/تتجاهل بصمت، والتطبيق
//  يكمل على التخزين المحلي (localStorage) في src/store.ts.
//
//  ⚠️ لا يوجد أي استخدام لـ Firebase Storage هنا: التخزين في المشاريع
//  الجديدة يتطلب خطة Blaze (بطاقة فوترة)، وصلاح اختار عدم إضافتها
//  دلوقتي (قرار 2026-11-12). الصور (بطاقة السواق + سكرين شوت التحويل)
//  تتخزن كـ Data URL مضغوطة داخل مستند Firestore نفسه — انظر
//  src/imageUpload.ts. عند الترقية لـ Blaze لاحقاً ممكن ترحيلها
//  لـ Storage وتبديل الحقول بروابط.
//
//  ملحوظة مهمة (إصلاح 2026-11-12): الاستيراد هنا ثابت (static) عمداً —
//  الاستيراد الديناميكي import('firebase/firestore') كان بيطلع ملف منفصل
//  (chunk) لازم يتحمّل وقت التشغيل، وفي WebView بتاع Capacitor كان
//  بيفشل بصمت فكل عمليات Firestore (حفظ/قراءة/مزامنة) مكانتش بتوصل
//  للسيرفر أصلاً رغم إن القواعد مفتوحة. الاستيراد الثابت بيضم الكود
//  في الحزمة الرئيسية فمفيش تحميل وقت التشغيل.
//
//  مجموعات Firestore المقترحة:
//    passengers/{phone}   — name, phone, code, phoneVerified, ratingAvg...
//    drivers/{code}       — profile + idCardUrl (Base64 مضغوطة) + wallet debt + online
//                           (v48: code = 'D-' + أرقام الهاتف E.164 — الكود نفسه من الرقم،
//                           فمستحيل سواقين يتشاركوا مستند، ومستحيل تصادم هاش)
//    rides/{orderNo}      — ride + offers[] + driver location
//                           (v48: orderNo من عدّاد السيرفر settings/counters.rideSeq —
//                           كل راكب أول رحلة ليه كانت #1001 قبل كده، فالرحلات كانت بتتصادم)
//    settings/counters    — rideSeq: عدّاد أرقام الرحلات (معاملة ذرّية)
//    settings/admin       — admin walletNumber + walletName (v48: بتتحفظ على السيرفر —
//                           قبل كده كانت محلية بس، فالسواقين مبيعرفوش رقم التحويل)
//    settings/launch      — (v44) launched + driversTarget: مفتاح تشغيل الخدمة للركاب
//    launchWaitlist/{id}  — (v44) phone + name + createdAt: عملاء مستنيين الإطلاق
//    waitlist/{id}        — عملاء برّه النطاق سابوا أرقامهم للتوسع
// ---------------------------------------------------------------------------
import { collection, deleteDoc, doc, getDoc, getFirestore, increment, onSnapshot, query, runTransaction, setDoc } from 'firebase/firestore'
import type { Firestore, QueryConstraint } from 'firebase/firestore'
import { isFirebaseConfigured } from './firebaseConfig'
import { getFirebaseApp } from './firebaseApp'
import { preparePhotoForFirestore } from './imageUpload'
import type { DriverProfile, LaunchWaitlistEntry, PassengerProfile, PaymentRequest, Ride, WaitlistEntry } from './types'

export const firebaseEnabled = isFirebaseConfigured

/** يتنادى عند فشل أي عملية Firestore — بيتسجّل في الكونسول بس، من غير
 *  أي رسالة للمستخدم: أخطاء الشبكة العابرة بترجع لوحدها والمزامنة
 *  بتكمل تلقائياً، والرسالة كانت بتزعج المستخدم على الفاضي. */
let errorHandler: ((message: string) => void) | null = null
export function setFirestoreErrorHandler(fn: ((message: string) => void) | null) {
  errorHandler = fn
}
function reportError(where: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  console.warn(`Firestore ${where} failed:`, e)
  errorHandler?.(`${where}: ${msg}`)
}

let db: Firestore | null | undefined
function getDb(): Firestore | null {
  if (!isFirebaseConfigured) return null
  if (db === undefined) {
    const app = getFirebaseApp()
    db = app ? getFirestore(app) : null
  }
  return db
}

/** يقرأ مستنداً واحداً من Firestore — null لو مش موجود أو مفيش إعداد. */
export async function loadDoc(
  collectionName: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  try {
    const db = getDb()
    if (!db) return null
    const snap = await getDoc(doc(db, collectionName, id))
    return snap.exists() ? (snap.data() as Record<string, unknown>) : null
  } catch (e) {
    reportError('قراءة', e)
    return null
  }
}

/** يحفظ مستنداً في Firestore عند توفر الإعداد — وإلا يتجاهل. */
export async function saveDoc(
  collectionName: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const db = getDb()
    if (!db) return
    await setDoc(doc(db, collectionName, id), data, { merge: true })
  } catch (e) {
    reportError('حفظ', e)
  }
}

/** يمسح مستنداً من Firestore — للترحيل (v48: نقل مستند سواق من كود قديم لكود جديد). */
export async function deleteDocById(collectionName: string, id: string): Promise<void> {
  try {
    const db = getDb()
    if (!db) return
    await deleteDoc(doc(db, collectionName, id))
  } catch (e) {
    reportError('حذف', e)
  }
}

/**
 * رقم طلب فريد من السيرفر (v48): عدّاد ذرّي في settings/counters.rideSeq —
 * كل رحلة بتاخد رقم جديد من غير تصادم بين الركاب.
 * (البداية #10001 مش #1001: أرقام #1001-#1009 موجودة أصلاً كمستندات
 * رحلات تجريبية من زمن العدّاد المحلي — لو بدأنا من #1001 أول رحلة
 * حقيقية كانت هتكتب فوق رحلة تجريبية قديمة بنفس الرقم.)
 * لو مفيش نت (أوفلاين) يرجع رقم مؤقت فريد `#T<وقت>` — مش هيتصادم مع حد.
 */
export async function nextOrderNumber(): Promise<string> {
  try {
    const db = getDb()
    if (!db) return `#T${Date.now()}`
    const n = await runTransaction(db, async (tx) => {
      const ref = doc(db, 'settings', 'counters')
      const snap = await tx.get(ref)
      const cur = Number(snap.data()?.rideSeq ?? 0)
      tx.set(ref, { rideSeq: increment(1) }, { merge: true })
      return cur + 1
    })
    return `#${10000 + n}`
  } catch (e) {
    reportError('رقم الطلب', e)
    return `#T${Date.now()}`
  }
}

/** يقرأ رقم محفظة الأدمن من السيرفر (settings/admin) — null لو لسه متحددش. */
export async function loadAdminSettings(): Promise<{ walletNumber: string; walletName: string } | null> {
  const docData = await loadDoc('settings', 'admin')
  if (!docData) return null
  return {
    walletNumber: typeof docData.walletNumber === 'string' ? docData.walletNumber : '',
    walletName: typeof docData.walletName === 'string' ? docData.walletName : '',
  }
}

/** يحفظ رقم محفظة الأدمن على السيرفر — عشان السواقين يشوفوه على أي جهاز. */
export async function saveAdminSettings(s: { walletNumber: string; walletName: string }): Promise<void> {
  await saveDoc('settings', 'admin', { walletNumber: s.walletNumber, walletName: s.walletName })
}

/**
 * يجهّز صورة (بطاقة أو سكرين شوت تحويل) للتخزين في Firestore:
 * تصغير لأقصى ضلع 800px + ضغط JPEG، ويرجع Data URL مضغوطة
 * (تحت ~250KB) تتحفظ في حقل المستند مباشرة — بدون Storage إطلاقاً.
 * يرمي Error برسالة عربية لو الصورة مش صورة أو فضلت كبيرة بعد الضغط.
 */
export async function uploadImageAsDataUrl(file: File): Promise<string> {
  return preparePhotoForFirestore(file)
}

/** يحوّل مستند رحلة من Firestore لكائن Ride كامل (مع قيم افتراضية للحقول الجديدة). */
function normalizeRide(id: string, data: Record<string, unknown>): Ride {
  const d = data as unknown as Partial<Ride>
  return {
    orderNo: d.orderNo ?? id,
    passengerCode: d.passengerCode ?? '',
    passengerName: d.passengerName ?? 'عميل',
    passengerPhone: d.passengerPhone ?? '',
    passengerRating: d.passengerRating ?? 0,
    pickup: d.pickup ?? { lat: 0, lng: 0, label: '' },
    destination: d.destination ?? { lat: 0, lng: 0, label: '' },
    fare: d.fare ?? 0,
    status: d.status ?? 'searching',
    driverCode: d.driverCode ?? null,
    driverName: d.driverName ?? null,
    driverPhone: d.driverPhone ?? null,
    driverLat: d.driverLat ?? null,
    driverLng: d.driverLng ?? null,
    driverLocAt: d.driverLocAt ?? null,
    offers: d.offers ?? [],
    createdAt: d.createdAt ?? Date.now(),
    acceptedAt: d.acceptedAt ?? null,
    arrivedAt: d.arrivedAt ?? null,
    completedAt: d.completedAt ?? null,
    cancelledAt: d.cancelledAt ?? null,
    cancelReason: d.cancelReason ?? null,
    cancelledBy: d.cancelledBy ?? null,
    passengerPhotoUrl: d.passengerPhotoUrl ?? null,
    driverPhotoUrl: d.driverPhotoUrl ?? null,
    passengerRatingForDriver: d.passengerRatingForDriver ?? null,
    driverRatingForPassenger: d.driverRatingForPassenger ?? null,
  }
}

/**
 * اشتراك حي في مجموعة الرحلات: أي طلب جديد أو تغيير حالة من جهاز تاني
 * يوصل فوراً للجهاز ده — وده اللي بيخلي طلب العميل يظهر ويرن عند السواق.
 * يرجع دالة إلغاء الاشتراك. في الوضع التجريبي المحلي يرجع دالة فاضية.
 */
export function subscribeRides(cb: (rides: Ride[]) => void, constraints?: QueryConstraint[]): () => void {
  try {
    const db = getDb()
    if (!db) return () => {}
    const q = constraints && constraints.length > 0
      ? query(collection(db, 'rides'), ...constraints)
      : collection(db, 'rides')
    const unsub = onSnapshot(
      q,
      (snap) => cb(snap.docs.map((d) => normalizeRide(d.id, d.data() as Record<string, unknown>))),
      (err) => reportError('مزامنة الرحلات', err),
    )
    return () => unsub()
  } catch (e) {
    reportError('مزامنة الرحلات', e)
    return () => {}
  }
}

function normalizePayment(id: string, data: Record<string, unknown>): PaymentRequest {
  const d = data as unknown as Partial<PaymentRequest>
  return {
    id: d.id ?? id,
    driverCode: d.driverCode ?? '',
    driverName: d.driverName ?? 'الكابتن',
    amount: d.amount ?? 0,
    screenshotUrl: d.screenshotUrl ?? '',
    status: d.status ?? 'pending',
    createdAt: d.createdAt ?? Date.now(),
  }
}

/**
 * اشتراك حي في طلبات التحويل: طلب سداد من سواق على جهاز تاني
 * يوصل فوراً لشاشة الإدارة — من غيره الأدمن مبيشوفش غير طلبات جهازه.
 */
export function subscribePayments(cb: (payments: PaymentRequest[]) => void, constraints?: QueryConstraint[]): () => void {
  try {
    const db = getDb()
    if (!db) return () => {}
    const q = constraints && constraints.length > 0
      ? query(collection(db, 'payments'), ...constraints)
      : collection(db, 'payments')
    const unsub = onSnapshot(
      q,
      (snap) => cb(snap.docs.map((d) => normalizePayment(d.id, d.data() as Record<string, unknown>))),
      (err) => reportError('مزامنة التحويلات', err),
    )
    return () => unsub()
  } catch (e) {
    reportError('مزامنة التحويلات', e)
    return () => {}
  }
}

/** يحوّل مستند سواق من Firestore لملف سواق كامل (تاريخ التسجيل 0 لو مش موجود). */
function normalizeDriver(id: string, data: Record<string, unknown>): DriverProfile {
  const d = data as unknown as Partial<DriverProfile>
  return {
    name: d.name ?? 'كابتن',
    phone: d.phone ?? '',
    code: d.code ?? id,
    plate: d.plate ?? '',
    color: d.color ?? '',
    model: d.model ?? '',
    online: d.online ?? false,
    sharingLocation: d.sharingLocation ?? false,
    ratingAvg: d.ratingAvg ?? 0,
    ratingCount: d.ratingCount ?? 0,
    createdAt: d.createdAt ?? 0,
    debt: d.debt ?? 0,
    totalPaid: d.totalPaid ?? 0,
    balance: d.balance ?? 0,
    idCardUrl: d.idCardUrl ?? null,
    photoUrl: d.photoUrl ?? null,
    idCardStatus: d.idCardStatus ?? 'none',
    currentLat: d.currentLat ?? null,
    currentLng: d.currentLng ?? null,
  }
}

/** يحوّل مستند عميل من Firestore لملف عميل كامل (تاريخ التسجيل 0 لو مش موجود). */
function normalizePassenger(id: string, data: Record<string, unknown>): PassengerProfile {
  const d = data as unknown as Partial<PassengerProfile>
  return {
    name: d.name ?? 'عميل',
    phone: d.phone ?? id,
    code: d.code ?? '',
    phoneVerified: d.phoneVerified ?? false,
    photoUrl: d.photoUrl ?? null,
    ratingAvg: d.ratingAvg ?? 0,
    ratingCount: d.ratingCount ?? 0,
    createdAt: d.createdAt ?? 0,
  }
}

/**
 * اشتراك حي في السواقين المسجلين — للإدارة بس: أي سواق جديد يسجل
 * يظهر فوراً في قسم المستخدمين عند الأدمن.
 */
export function subscribeDrivers(cb: (drivers: DriverProfile[]) => void, constraints?: QueryConstraint[]): () => void {
  try {
    const db = getDb()
    if (!db) return () => {}
    const q = constraints && constraints.length > 0
      ? query(collection(db, 'drivers'), ...constraints)
      : collection(db, 'drivers')
    const unsub = onSnapshot(
      q,
      (snap) => cb(snap.docs.map((d) => normalizeDriver(d.id, d.data() as Record<string, unknown>))),
      (err) => reportError('مزامنة السواقين', err),
    )
    return () => unsub()
  } catch (e) {
    reportError('مزامنة السواقين', e)
    return () => {}
  }
}

/**
 * اشتراك حي في العملاء المسجلين — للإدارة بس: أي عميل جديد يسجل
 * يظهر فوراً في قسم المستخدمين عند الأدمن.
 */
export function subscribePassengers(cb: (passengers: PassengerProfile[]) => void): () => void {
  try {
    const db = getDb()
    if (!db) return () => {}
    const unsub = onSnapshot(
      collection(db, 'passengers'),
      (snap) => cb(snap.docs.map((d) => normalizePassenger(d.id, d.data() as Record<string, unknown>))),
      (err) => reportError('مزامنة العملاء', err),
    )
    return () => unsub()
  } catch (e) {
    reportError('مزامنة العملاء', e)
    return () => {}
  }
}

/**
 * يقرأ إعدادات الإطلاق (settings/launch) — مستند مش موجود = لسه ما
 * اشتغلناش (launched=false) وهدف السواقين 100. القواعد مفتوحة
 * (allow read, write: if true) فأي عميل موثّق يقدر يقراه.
 */
export async function loadLaunch(): Promise<{ launched: boolean; driversTarget: number }> {
  const docData = await loadDoc('settings', 'launch')
  return {
    launched: docData?.launched === true,
    driversTarget: typeof docData?.driversTarget === 'number' ? docData.driversTarget : 100,
  }
}

/**
 * اشتراك حي في قايمة انتظار الإطلاق — للإدارة بس: أي عميل ساب رقمه
 * عشان نبلغه لما الخدمة تشتغل يظهر فوراً عند الأدمن.
 */
export function subscribeLaunchWaitlist(cb: (entries: LaunchWaitlistEntry[]) => void): () => void {
  try {
    const db = getDb()
    if (!db) return () => {}
    const unsub = onSnapshot(
      collection(db, 'launchWaitlist'),
      (snap) => cb(snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>
        return {
          id: d.id,
          phone: String(data.phone ?? ''),
          name: String(data.name ?? ''),
          createdAt: (data.createdAt as number) ?? 0,
        } as LaunchWaitlistEntry
      })),
      (err) => reportError('مزامنة قايمة انتظار الإطلاق', err),
    )
    return () => unsub()
  } catch (e) {
    reportError('مزامنة قايمة انتظار الإطلاق', e)
    return () => {}
  }
}

/**
 * اشتراك حي في قايمة انتظار التوسع — للإدارة بس: أي عميل من برّه النطاق
 * ساب رقمه يظهر فوراً عند الأدمن.
 */
export function subscribeWaitlist(cb: (entries: WaitlistEntry[]) => void): () => void {
  try {
    const db = getDb()
    if (!db) return () => {}
    const unsub = onSnapshot(
      collection(db, 'waitlist'),
      (snap) => cb(snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>
        return {
          id: d.id,
          phone: String(data.phone ?? ''),
          name: String(data.name ?? ''),
          code: String(data.code ?? ''),
          pickupLabel: String(data.pickupLabel ?? ''),
          destLabel: String(data.destLabel ?? ''),
          createdAt: (data.createdAt as number) ?? 0,
        } as WaitlistEntry
      })),
      (err) => reportError('مزامنة قايمة الانتظار', err),
    )
    return () => unsub()
  } catch (e) {
    reportError('مزامنة قايمة الانتظار', e)
    return () => {}
  }
}

/**
 * اعتماد طلب تحويل في معاملة ذرّية (v48): الطلب لازم يكون لسه pending
 * جوّه المعاملة نفسها — فاعتماد مرتين (جهازين أو ضغطتين) مستحيل،
 * وخصم المديونية بيتحسب من أحدث قراءة على السيرفر، مش من حالة قديمة.
 */
export async function approvePaymentTx(
  paymentId: string,
): Promise<{ ok: boolean; alreadyReviewed?: boolean; debt?: number; balance?: number; totalPaid?: number; remainder?: number }> {
  try {
    const db = getDb()
    if (!db) return { ok: false }
    const result = await runTransaction(db, async (tx) => {
      const payRef = doc(db, 'payments', paymentId)
      const paySnap = await tx.get(payRef)
      if (!paySnap.exists()) throw new Error('payment-missing')
      const pay = paySnap.data() as Partial<PaymentRequest>
      if (pay.status !== 'pending') throw new Error('already-reviewed')
      const driverCode = String(pay.driverCode ?? '')
      const amount = Number(pay.amount ?? 0)
      const dRef = doc(db, 'drivers', driverCode)
      const dSnap = await tx.get(dRef)
      const curDebt = Number(dSnap.data()?.debt ?? 0)
      const curPaid = Number(dSnap.data()?.totalPaid ?? 0)
      const curBalance = Number(dSnap.data()?.balance ?? 0)
      const toDebt = Math.min(amount, curDebt)
      const remainder = Math.round((amount - toDebt) * 100) / 100
      const debt = Math.round((curDebt - toDebt) * 100) / 100
      const balance = Math.round((curBalance + remainder) * 100) / 100
      const totalPaid = Math.round((curPaid + amount) * 100) / 100
      tx.update(payRef, { status: 'approved' })
      tx.set(dRef, { debt, balance, totalPaid }, { merge: true })
      return { debt, balance, totalPaid, remainder }
    })
    return { ok: true, ...result }
  } catch (e) {
    if (e instanceof Error && e.message === 'already-reviewed') return { ok: false, alreadyReviewed: true }
    reportError('اعتماد التحويل', e)
    return { ok: false }
  }
}

/**
 * تسجيل تقييم في معاملة ذرّية (v48): التقييم لنفس الرحلة مرة واحدة بس
 * (الحارس جوّه المعاملة)، والمتوسط والعداد بيتحسبوا من أحدث قراءة —
 * تقييمان متزامنان لنفس السواق مبيضيّعوش بعض.
 */
export async function applyRatingTx(
  orderNo: string,
  by: 'passenger' | 'driver',
  value: number,
): Promise<{ ok: boolean; reason?: string; ratingAvg?: number; ratingCount?: number }> {
  try {
    const db = getDb()
    if (!db) return { ok: false, reason: 'no-firebase' }
    const result = await runTransaction(db, async (tx) => {
      const rideRef = doc(db, 'rides', orderNo)
      const rideSnap = await tx.get(rideRef)
      if (!rideSnap.exists()) throw new Error('ride-missing')
      const ride = rideSnap.data() as Partial<Ride>
      if (by === 'passenger') {
        if (ride.passengerRatingForDriver != null) throw new Error('already-rated')
        const driverCode = ride.driverCode as string | null
        if (!driverCode) throw new Error('no-driver')
        tx.update(rideRef, { passengerRatingForDriver: value })
        const dRef = doc(db, 'drivers', driverCode)
        const dSnap = await tx.get(dRef)
        const avg = Number(dSnap.data()?.ratingAvg ?? 0)
        const count = Number(dSnap.data()?.ratingCount ?? 0)
        const n = count + 1
        const ratingAvg = Math.round(((avg * count + value) / n) * 10) / 10
        tx.set(dRef, { ratingAvg, ratingCount: n }, { merge: true })
        return { ratingAvg, ratingCount: n }
      } else {
        if (ride.driverRatingForPassenger != null) throw new Error('already-rated')
        const passengerPhone = ride.passengerPhone as string | null
        if (!passengerPhone) throw new Error('no-passenger')
        tx.update(rideRef, { driverRatingForPassenger: value })
        const pRef = doc(db, 'passengers', passengerPhone)
        const pSnap = await tx.get(pRef)
        const avg = Number(pSnap.data()?.ratingAvg ?? 0)
        const count = Number(pSnap.data()?.ratingCount ?? 0)
        const n = count + 1
        const ratingAvg = Math.round(((avg * count + value) / n) * 10) / 10
        tx.set(pRef, { ratingAvg, ratingCount: n }, { merge: true })
        return { ratingAvg, ratingCount: n }
      }
    })
    return { ok: true, ...result }
  } catch (e) {
    if (e instanceof Error && e.message === 'already-rated') return { ok: false, reason: 'already-rated' }
    reportError('التقييم', e)
    return { ok: false, reason: 'error' }
  }
}

/**
 * خصم عمولة 5% من محفظة السواق في معاملة ذرّية (v48): بتتخصم من الرصيد
 * الأول (من أحدث قراءة على السيرفر)، والباقي مديونية — فإنهاء رحلة
 * من جهازين في نفس اللحظة مبيخصمش العمولة مرتين من رصيد قديم.
 */
export async function applyCommissionTx(
  driverCode: string,
  commission: number,
): Promise<{ ok: boolean; debt?: number; balance?: number }> {
  try {
    const db = getDb()
    if (!db) return { ok: false }
    const result = await runTransaction(db, async (tx) => {
      const dRef = doc(db, 'drivers', driverCode)
      const dSnap = await tx.get(dRef)
      const curBalance = Number(dSnap.data()?.balance ?? 0)
      const curDebt = Number(dSnap.data()?.debt ?? 0)
      const fromBalance = Math.min(curBalance, commission)
      const balance = Math.round((curBalance - fromBalance) * 100) / 100
      const debt = Math.round((curDebt + commission - fromBalance) * 100) / 100
      tx.set(dRef, { debt, balance }, { merge: true })
      return { debt, balance }
    })
    return { ok: true, ...result }
  } catch (e) {
    reportError('العمولة', e)
    return { ok: false }
  }
}
