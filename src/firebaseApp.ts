// ---------------------------------------------------------------------------
//  نسخة Firebase واحدة مشتركة (Singleton) — لتفادي خطأ
//  "Firebase App named '[DEFAULT]' already exists" عند استدعاء
//  initializeApp أكثر من مرة (Auth + Firestore).
//  كل الوحدات (otp.ts / firebaseDb.ts) تأخذ التطبيق من هنا.
//  ملحوظة: لا يوجد Storage في التطبيق — الصور Base64 داخل Firestore.
// ---------------------------------------------------------------------------
import { getApp, getApps, initializeApp } from 'firebase/app'
import type { FirebaseApp } from 'firebase/app'
// استيراد جانبي: يضمن تنفيذ تسجيل مكون Auth عند تحميل الحزمة
// (حماية إضافية مع moduleSideEffects في vite.config.ts)
import 'firebase/auth'
import { getAuth } from 'firebase/auth'
import type { Auth } from 'firebase/auth'
import { firebaseConfig, isFirebaseConfigured } from './firebaseConfig'

/** نسخة Firebase الوحيدة، أو null إذا لم يلصق صلاح الـ config بعد. */
export function getFirebaseApp(): FirebaseApp | null {
  if (!isFirebaseConfigured) return null
  return getApps().length ? getApp() : initializeApp(firebaseConfig)
}

/** Firebase Auth لنفس النسخة، أو null بدون config. */
export function getFirebaseAuth(): Auth | null {
  const app = getFirebaseApp()
  return app ? getAuth(app) : null
}
