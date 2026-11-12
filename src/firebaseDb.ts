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
//  مجموعات Firestore المقترحة:
//    passengers/{phone}   — name, phone, code, phoneVerified, ratingAvg...
//    drivers/{code}       — profile + idCardUrl (Base64 مضغوطة) + wallet debt + online
//    rides/{orderNo}      — ride + offers[] + driver location
//    payments/{id}        — driver payment requests + screenshotUrl (Base64 مضغوطة)
//    settings/admin       — admin walletNumber + walletName
// ---------------------------------------------------------------------------
import { isFirebaseConfigured } from './firebaseConfig'
import { getFirebaseApp } from './firebaseApp'
import { preparePhotoForFirestore } from './imageUpload'
import type { Ride } from './types'

export const firebaseEnabled = isFirebaseConfigured

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any
let dbPromise: Promise<AnyDb> | null = null

async function getDb(): Promise<AnyDb> {
  if (!isFirebaseConfigured) return null
  if (!dbPromise) {
    dbPromise = (async () => {
      const { getFirestore } = await import('firebase/firestore')
      return getFirestore(getFirebaseApp()!)
    })()
  }
  return dbPromise
}

/** يقرأ مستنداً واحداً من Firestore — null لو مش موجود أو مفيش إعداد. */
export async function loadDoc(
  collection: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  try {
    const db = await getDb()
    if (!db) return null
    const { doc, getDoc } = await import('firebase/firestore')
    const snap = await getDoc(doc(db, collection, id))
    return snap.exists() ? (snap.data() as Record<string, unknown>) : null
  } catch (e) {
    console.warn('Firestore load failed (demo mode continues):', e)
    return null
  }
}

/** يحفظ مستنداً في Firestore عند توفر الإعداد — وإلا يتجاهل. */
export async function saveDoc(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const db = await getDb()
    if (!db) return
    const { doc, setDoc } = await import('firebase/firestore')
    await setDoc(doc(db, collection, id), data, { merge: true })
  } catch (e) {
    console.warn('Firestore save failed (demo mode continues):', e)
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
    driverLat: d.driverLat ?? null,
    driverLng: d.driverLng ?? null,
    driverLocAt: d.driverLocAt ?? null,
    offers: d.offers ?? [],
    createdAt: d.createdAt ?? Date.now(),
    acceptedAt: d.acceptedAt ?? null,
    arrivedAt: d.arrivedAt ?? null,
    completedAt: d.completedAt ?? null,
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
  let unsub: (() => void) | null = null
  let cancelled = false
  ;(async () => {
    try {
      const db = await getDb()
      if (!db || cancelled) return
      const { collection, onSnapshot } = await import('firebase/firestore')
      unsub = onSnapshot(
        collection(db, 'rides'),
        (snap) => cb(snap.docs.map((d) => normalizeRide(d.id, d.data() as Record<string, unknown>))),
        (err) => console.warn('Firestore rides listen failed:', err),
      )
    } catch (e) {
      console.warn('Firestore rides listen failed:', e)
    }
  })()
  return () => {
    cancelled = true
    unsub?.()
  }
}
