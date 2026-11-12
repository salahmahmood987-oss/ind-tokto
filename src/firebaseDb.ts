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
