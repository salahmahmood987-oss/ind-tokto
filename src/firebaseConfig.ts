// ============================================================================
//  إعدادات Firebase — ind toktok
//  IMPORTANT / مهم جداً:
//  1) صلاح ينشئ مشروع Firebase جديد باسم ind-toktok في نفس حسابه
//     (console.firebase.google.com) — ولا يلمس مشروع "تاجر جمله" القديم.
//  2) يفعّل في المشروع الجديد: Firestore Database + Authentication (Phone)
//     فقط — Storage مش مطلوب: التخزين في المشاريع الجديدة يتطلب خطة
//     Blaze (بطاقة فوترة)، وصلاح اختار عدم إضافتها دلوقتي (2026-11-12).
//     الصور تتخزن مضغوطة Base64 داخل Firestore — انظر src/imageUpload.ts.
//  3) من Project settings > Your apps > Web app (</>) ينسخ الـ config
//     ويلصقه هنا بدل القيم النائبة PASTE_... أدناه.
//  ✅ تم: صلاح بعت الـ config الحقيقي لمشروع ind-toktok واتحط هنا.
//     التطبيق دلوقتي متصل بـ Firestore / Auth بتاع المشروع (بدون Storage).
//     لو اتمسح الـ config ورجع للقيم النائبة، التطبيق يرجع تلقائياً
//     لـ "الوضع التجريبي المحلي" (البيانات على الجهاز، وإرسال OTP
//     يترفض برسالة توضح إن إعداد Firebase مش موجود).
// ============================================================================

export interface FirebaseWebConfig {
  apiKey: string
  authDomain: string
  projectId: string
  storageBucket: string
  messagingSenderId: string
  appId: string
}

export const firebaseConfig: FirebaseWebConfig = {
  apiKey: 'AIzaSyCX8_UlpC9kPeMkEvDCMM34df6eJyaxpYM',
  authDomain: 'ind-toktok.firebaseapp.com',
  projectId: 'ind-toktok',
  storageBucket: 'ind-toktok.firebasestorage.app',
  messagingSenderId: '61718594476',
  appId: '1:61718594476:web:7c98fb5add70514aa5f009',
}

/** true فقط عندما يلصق صلاح الـ config الحقيقي لمشروع ind-toktok. */
export const isFirebaseConfigured =
  firebaseConfig.apiKey !== 'PASTE_YOUR_API_KEY_HERE' &&
  firebaseConfig.projectId !== 'PASTE_YOUR_PROJECT_ID_HERE'

// ============================================================================
//  OTP حقيقي — Firebase Phone Auth (اختاره صلاح 2026-11-12 بدل Twilio)
//  ----------------------------------------------------------------------------
//  الكود يتبعت برسالة SMS حقيقية من Firebase نفسه (signInWithPhoneNumber
//  مع reCAPTCHA مخفي) — انظر src/otp.ts. الكود لا يظهر أبداً داخل التطبيق.
//
//  حدود لازم صلاح يعرفها:
//  • حد التطبيق: 3 أكواد في الساعة لكل رقم (src/otp.ts — قبل مناداة
//    Firebase، عشان ما نحرقش رسايل على الفاضي).
//  • حد Firebase للمشاريع الجديدة: **10 رسايل SMS في اليوم** لحد ما يضيف
//    حساب فوترة (Blaze) لمشروع ind-toktok من الكونسول، وبعدها الحد بيرتفع.
//  • ملف functions/index.js (هيكل Twilio) **مش مستخدم دلوقتي** — اتحفظ
//    كمرجع فقط، لأن صلاح اختار Firebase Phone Auth بدل Twilio.
// ============================================================================
export const SMS_PROVIDER_TODO =
  'Real OTP via Firebase Phone Auth (see src/otp.ts). Firebase new-project limit: 10 SMS/day until billing is added to project ind-toktok.'
