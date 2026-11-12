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
//    rides/{orderNo}      — ride + offers[] + driver location
//    payments/{id}        — driver payment requests + screenshotUrl (Base64 مضغوطة)
//    settings/admin       — admin walletNumber + walletName
// ---------------------------------------------------------------------------
import { collection, doc, getDoc, getFirestore, onSnapshot, setDoc } from 'firebase/firestore'
import type { Firestore } from 'firebase/firestore'
import { isFirebaseConfigured } from './firebaseConfig'
import { getFirebaseApp } from './firebaseApp'
import { preparePhotoForFirestore } from './imageUpload'
import type { PaymentRequest, Ride } from './types'

export const firebaseEnabled = isFirebaseConfigured

/** يتنادى عند فشل أي عملية Firestore — التطبيق بيسجّلها وبيعرضها للمستخدم. */
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
export function subscribeRides(cb: (rides: Ride[]) => void): () => void {
  try {
    const db = getDb()
    if (!db) return () => {}
    const unsub = onSnapshot(
      collection(db, 'rides'),
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
export function subscribePayments(cb: (payments: PaymentRequest[]) => void): () => void {
  try {
    const db = getDb()
    if (!db) return () => {}
    const unsub = onSnapshot(
      collection(db, 'payments'),
      (snap) => cb(snap.docs.map((d) => normalizePayment(d.id, d.data() as Record<string, unknown>))),
      (err) => reportError('مزامنة التحويلات', err),
    )
    return () => unsub()
  } catch (e) {
    reportError('مزامنة التحويلات', e)
    return () => {}
  }
}
