// ---------------------------------------------------------------------------
// OTP حقيقي — Firebase Phone Auth (signInWithPhoneNumber)
// الكود يتبعت برسالة SMS حقيقية من Firebase على موبايل العميل، و**لا يظهر
// أبداً داخل التطبيق**. لا يوجد كود تجريبي هنا.
//
// مساران:
//   • على أندرويد (تطبيق Capacitor): التحقق **الأصلي** عبر إضافة
//     @capacitor-firebase/authentication — بيستخدم Firebase SDK الأصلي
//     (Play Integrity/SafetyNet)، لأن reCAPTCHA الويب لا يعمل داخل WebView
//     ويفشل بخطأ auth/invalid-app-credential. يتطلب ملف google-services.json
//     في android/app/ وتسجيل بصمة SHA-1 لمفتاح debug في الكونسول.
//   • على الويب: signInWithPhoneNumber مع reCAPTCHA مخفي.
// ---------------------------------------------------------------------------
import { Capacitor } from '@capacitor/core'
import { FirebaseAuthentication } from '@capacitor-firebase/authentication'
import {
  RecaptchaVerifier,
  signInWithCustomToken,
  signInWithPhoneNumber,
} from 'firebase/auth'
import type { ConfirmationResult } from 'firebase/auth'
import { getFirebaseAuth } from './firebaseApp'
import { isFirebaseConfigured } from './firebaseConfig'
import {
  isOtpWorkerConfigured,
  requestOtpFromWorker,
  verifyOtpWithWorker,
} from './otpWorker'
import type { WorkerOtpResponse, WorkerVerifyResponse } from './otpWorker'
import { OTP_MAX_PER_HOUR } from './types'

const OTP_KEY = 'indtoktok_otp_v1'

/**
 * أرقام الاختبار المسجلة في Firebase console — تكمل مسار Firebase
 * الحالي (الكود 123456) بدون مناداة الـ Worker وبدون SMS حقيقي.
 * أي رقم تاني يروح للـ Worker (textbee) لو مضبوط، وإلا لمسار Firebase.
 */
const TEST_NUMBERS = new Set(['+201550364683', '+201515149075'])

/** يحوّل خطأ إرسال الـ Worker لرسالة عربية واضحة. */
function workerSendErrorMessage(w: WorkerOtpResponse): string {
  switch (w.error) {
    case 'rate_limited':
      return (
        w.message || 'وصلت للحد الأقصى — 3 أكواد بس في الساعة للرقم ده.'
      )
    case 'sms_quota':
    case 'daily_cap':
      return 'خلصت رسايل التحقق المسموحة لليوم — حاول بكرة.'
    case 'sms_failed':
    case 'network':
      return 'مقدرناش نبعت الكود دلوقتي — حاول تاني بعد شوية.'
    default:
      return w.message || 'مقدرناش نبعت الكود دلوقتي — حاول تاني بعد شوية.'
  }
}

/** يحوّل خطأ تأكيد الـ Worker لرسالة عربية واضحة. */
function workerVerifyErrorMessage(w: WorkerVerifyResponse): string {
  switch (w.error) {
    case 'invalid_code':
      return w.message || 'الكود غلط — راجع الرسالة وحاول تاني.'
    case 'code_expired':
      return w.message || 'الكود انتهت صلاحيته — اطلب كود جديد.'
    case 'too_many_attempts':
      return w.message || 'محاولات كتير غلط — اطلب كود جديد.'
    case 'network':
      return 'مشكلة في الاتصال بسيرفر الأكواد — تأكد إن النت شغال وحاول تاني.'
    default:
      return w.message || 'الكود غلط — راجع الرسالة وحاول تاني.'
  }
}

/** أوقات طلبات الكود في آخر ساعة (timestamps) لكل رقم — حد التطبيق فقط. */
interface OtpRateRecord {
  requests: number[]
}

function load(): Record<string, OtpRateRecord> {
  try {
    const raw = JSON.parse(localStorage.getItem(OTP_KEY) || '{}') as Record<
      string,
      Partial<OtpRateRecord>
    >
    const out: Record<string, OtpRateRecord> = {}
    for (const [k, v] of Object.entries(raw)) {
      out[k] = { requests: Array.isArray(v.requests) ? v.requests : [] }
    }
    return out
  } catch {
    return {}
  }
}

function save(records: Record<string, OtpRateRecord>) {
  try {
    localStorage.setItem(OTP_KEY, JSON.stringify(records))
  } catch {
    // التخزين محظور في بعض المتصفحات الداخلية — نكمل بدون حفظ العداد
  }
}

function pruneRequests(requests: number[], now: number): number[] {
  return requests.filter((t) => now - t < 60 * 60 * 1000)
}

/** يحوّل الأرقام العربية لأرقام لاتينية ويشيل المسافات والشرطات. */
function normalizeDigits(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\s\-()]/g, '')
}

/**
 * يحوّل رقم مصري بصيغ 01xxxxxxxxx أو 1xxxxxxxxx أو 20xxxxxxxxxx
 * إلى صيغة E.164: ‎+20xxxxxxxxxx. يرجع null لو مش رقم مصري صالح.
 */
export function toE164Phone(raw: string): string | null {
  let d = normalizeDigits(raw.trim())
  if (d.startsWith('+')) d = d.slice(1)
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('20') && d.length === 12) return `+${d}`
  if (d.startsWith('0') && d.length === 11) d = `20${d.slice(1)}`
  else if (d.length === 10 && d.startsWith('1')) d = `20${d}`
  else return null
  // رقم موبايل مصري: +20 ثم 1 ثم (0/1/2/5) ثم 8 أرقام
  if (!/^20(10|11|12|15)\d{8}$/.test(d)) return null
  return `+${d}`
}

// ---------------------------------------------------------------------------
// reCAPTCHA مخفي (invisible) — مطلوب من Firebase Phone Auth على الويب.
// عنصر <div id="recaptcha-container"> موجود في شاشة تسجيل العميل في App.tsx.
// ---------------------------------------------------------------------------
let verifier: RecaptchaVerifier | null = null
let confirmation: ConfirmationResult | null = null

function clearVerifier() {
  try {
    verifier?.clear()
  } catch {
    // تجاهل — المتحقق ممكن يكون اتمسح أصلاً
  }
  verifier = null
}

function firebaseErrorMessage(code: string): string {
  switch (code) {
    case 'auth/invalid-phone-number':
      return 'رقم التليفون غير صحيح — اكتب رقم مصري 11 رقم يبدأ بـ 01.'
    case 'auth/missing-phone-number':
      return 'اكتب رقم التليفون الأول.'
    case 'auth/too-many-requests':
      return 'طلبات كتير من نفس الرقم — استنى شوية وحاول تاني.'
    case 'auth/quota-exceeded':
      return 'خلصت رسايل SMS المسموحة لليوم (10 رسايل للمشاريع الجديدة) — ضيف حساب فوترة لمشروع Firebase ind-toktok عشان الحد يترفع.'
    case 'auth/captcha-check-failed':
    case 'auth/recaptcha-not-enabled':
      return 'فشل التحقق الأمني (reCAPTCHA) — تأكد إن النت شغال وحاول تاني.'
    case 'auth/network-request-failed':
      return 'مشكلة في الاتصال بالإنترنت — حاول تاني.'
    case 'auth/app-not-authorized':
    case 'auth/unauthorized-domain':
      return 'الدومين ده مش مصرّح ليه في Firebase — أضف الدومين من Authentication ← Settings ← Authorized domains.'
    case 'auth/invalid-app-credential':
      return 'التحقق الأمني فشل داخل التطبيق (WebView) — جرّب تقفل التطبيق وتفتحه تاني، أو حدّث التطبيق لآخر نسخة.'
    case 'auth/operation-not-allowed':
      return 'تسجيل الدخول بالهاتف مش مفعّل في Firebase — فعّله من Authentication ← Sign-in method ← Phone.'
    case 'auth/web-storage-unsupported':
      return 'التخزين المحلي مش متاح في المتصفح ده — جرّب متصفح تاني.'
    case 'auth/internal-error':
      return `خطأ داخلي من Firebase أثناء إرسال الكود — حاول تاني بعد شوية. (كود الخطأ: ${code})`
    case 'auth/invalid-verification-code':
      return 'الكود غلط — راجع الرسالة وحاول تاني.'
    case 'auth/code-expired':
    case 'auth/session-expired':
      return 'الكود انتهت صلاحيته — اطلب كود جديد.'
    case 'auth/missing-verification-code':
      return 'اكتب الكود اللي وصلك في الرسالة.'
    case 'auth/user-disabled':
      return 'الحساب ده موقوف — كلم الإدارة.'
    default:
      return code
        ? `حصلت مشكلة في إرسال/تأكيد الكود — حاول تاني. (كود الخطأ: ${code})`
        : 'حصلت مشكلة في إرسال/تأكيد الكود — حاول تاني.'
  }
}

function errorCode(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    return String((e as { code: unknown }).code)
  }
  return ''
}

export interface OtpSendResult {
  ok: boolean
  /** صيغة E.164 اللي اتبعت عليها الكود، مثل ‎+2010... */
  e164?: string
  remaining: number
  /** دقائق الانتظار عند رفض الطلب */
  waitMinutes?: number
  /** true لو Firebase أكّد الرقم تلقائياً بدون SMS (تحقق فوري على أندرويد) */
  autoVerified?: boolean
  message: string
}

// verificationId للتحقق الأصلي (أندرويد) — بديل ConfirmationResult للويب.
let nativeVerificationId: string | null = null

type NativeSendOutcome =
  | { kind: 'sent'; verificationId: string }
  | { kind: 'completed' }
  | { kind: 'failed'; message: string; code?: string }

/**
 * يبدأ التحقق الأصلي وينتظر أول حدث: كود اتبعت، أو تحقق فوري، أو فشل.
 * لازم نسجّل المستمعين قبل مناداة signInWithPhoneNumber عشان الحدث ما يضيعش.
 */
async function nativeSendOtp(e164: string): Promise<NativeSendOutcome> {
  return new Promise<NativeSendOutcome>((resolve) => {
    let done = false
    const handles: { remove: () => Promise<void> }[] = []
    const finish = (o: NativeSendOutcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      // إزالة المستمعين لازم ما ترميش أي خطأ يكسّر الـ Promise أبداً
      for (const h of handles) {
        try {
          void h.remove().catch(() => {})
        } catch {
          // تجاهل
        }
      }
      resolve(o)
    }
    const timer = setTimeout(
      () =>
        finish({
          kind: 'failed',
          message: 'انتهت مهلة انتظار رد Firebase (45 ثانية) — تأكد إن النت شغال وحاول تاني.',
        }),
      45_000,
    )
    void (async () => {
      try {
        handles.push(
          await FirebaseAuthentication.addListener('phoneCodeSent', (e) =>
            finish({ kind: 'sent', verificationId: e.verificationId }),
          ),
        )
        handles.push(
          await FirebaseAuthentication.addListener(
            'phoneVerificationCompleted',
            () => finish({ kind: 'completed' }),
          ),
        )
        handles.push(
          await FirebaseAuthentication.addListener(
            'phoneVerificationFailed',
            (e) =>
              finish({
                kind: 'failed',
                message: e.message || 'فشل التحقق من رقم الهاتف.',
                code: e.code,
              }),
          ),
        )
        await FirebaseAuthentication.signInWithPhoneNumber({
          phoneNumber: e164,
        })
      } catch (e) {
        console.warn('Native Firebase Phone Auth send failed:', e)
        finish({
          kind: 'failed',
          message: firebaseErrorMessage(errorCode(e)),
          code: errorCode(e),
        })
      }
    })()
  })
}

/**
 * يطلب كود تحقق حقيقي برسالة SMS. يطبق حد التطبيق (3 في الساعة لكل رقم)
 * قبل مناداة Firebase، فلا يتحرق SMS على الفاضي.
 */
export async function sendOtpCode(phone: string): Promise<OtpSendResult> {
  if (!isFirebaseConfigured) {
    return {
      ok: false,
      remaining: 0,
      message: 'إعداد Firebase مش موجود في التطبيق — الصق الـ config في src/firebaseConfig.ts.',
    }
  }
  const e164 = toE164Phone(phone)
  if (!e164) {
    return {
      ok: false,
      remaining: otpRemaining(phone),
      message: 'رقم التليفون غير صحيح — اكتب رقم مصري 11 رقم يبدأ بـ 01.',
    }
  }

  // حد التطبيق: 3 في الساعة لكل رقم (قبل Firebase)
  const now = Date.now()
  const records = load()
  const rec = records[phone] || { requests: [] }
  const recent = pruneRequests(rec.requests, now)
  if (recent.length >= OTP_MAX_PER_HOUR) {
    const oldest = Math.min(...recent)
    const waitMs = 60 * 60 * 1000 - (now - oldest)
    const waitMinutes = Math.max(1, Math.ceil(waitMs / 60000))
    records[phone] = { requests: recent }
    save(records)
    return {
      ok: false,
      remaining: 0,
      waitMinutes,
      message: `وصلت للحد الأقصى — 3 أكواد بس في الساعة للرقم ده. استنى ${waitMinutes} دقيقة وحاول تاني.`,
    }
  }

  // --- أرقام غير الاختبار + Worker مضبوط: الكود SMS عن طريق textbee ---
  // الـ Worker بيولّد الكود ويبعت الـ SMS وبيفرض حد 3/ساعة من عنده كمان.
  // حد التطبيق المحلي اللي فوق يفضل خط دفاع أول، والتسجيل في
  // localStorage يتم بعد نجاح الإرسال بس (كما هو في مسار Firebase).
  if (!TEST_NUMBERS.has(e164) && isOtpWorkerConfigured()) {
    const w = await requestOtpFromWorker(e164)
    if (!w.ok) {
      return {
        ok: false,
        remaining: OTP_MAX_PER_HOUR - recent.length,
        waitMinutes: w.waitMinutes,
        message: workerSendErrorMessage(w),
      }
    }
    records[phone] = { requests: [...recent, now] }
    save(records)
    const remaining = OTP_MAX_PER_HOUR - recent.length - 1
    return {
      ok: true,
      e164,
      remaining,
      message:
        w.message ||
        `الكود اتبعت في رسالة SMS على ${e164} — اكتب الكود اللي وصلك (6 أرقام). فاضل ${remaining} من 3 طلبات في الساعة.`,
    }
  }

  // --- أندرويد: تحقق أصلي (Native) عبر إضافة Capacitor Firebase ---
  // في الإضافة v8: signInWithPhoneNumber لا ترجع verificationId مباشرة،
  // بل ترسل أحداث: phoneCodeSent (فيه verificationId) أو
  // phoneVerificationCompleted (تحقق فوري/تلقائي) أو phoneVerificationFailed.
  // ملحوظة: المسار الأصلي مش محتاج نسخة Auth من JS SDK أصلاً — الإضافة
  // الأصلية بتتعامل مع Firebase مباشرة، فمش بنستدعي getFirebaseAuth هنا
  // عشان أي مشكلة في JS SDK ما توقّفش إرسال الكود.
  if (Capacitor.isNativePlatform()) {
    let outcome: Awaited<ReturnType<typeof nativeSendOtp>>
    try {
      outcome = await nativeSendOtp(e164)
    } catch (e) {
      // أمان إضافي: nativeSendOtp مش مفروض يرمي أبداً، لكن لو رمى لازم
      // الخطأ يظهر للمستخدم برسالة واضحة بدل ما الزرار يسكت.
      console.warn('nativeSendOtp threw:', e)
      const msg =
        typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : 'خطأ غير معروف'
      return {
        ok: false,
        remaining: OTP_MAX_PER_HOUR - recent.length,
        message: `فشل إرسال الكود: ${msg.slice(0, 200)}`,
      }
    }
    if (outcome.kind === 'failed') {
      nativeVerificationId = null
      // بنعرض رسالة Firebase الأصلية مع الرسالة العربية عشان نعرف السبب الدقيق
      const raw = outcome.message ? ` (التفاصيل: ${outcome.message.slice(0, 220)})` : ''
      return {
        ok: false,
        remaining: OTP_MAX_PER_HOUR - recent.length,
        message: outcome.code
          ? `${firebaseErrorMessage(outcome.code)}${raw}`
          : outcome.message,
      }
    }
    // سجّل الطلب بعد الإرسال الناجح بس (مش على الفشل)
    records[phone] = { requests: [...recent, now] }
    save(records)
    const remaining = OTP_MAX_PER_HOUR - recent.length - 1
    if (outcome.kind === 'completed') {
      // تحقق فوري: Firebase أكّد الرقم وسجّل الدخول بدون SMS
      nativeVerificationId = null
      return {
        ok: true,
        e164,
        remaining,
        autoVerified: true,
        message: 'تم تأكيد رقمك تلقائياً بنجاح.',
      }
    }
    nativeVerificationId = outcome.verificationId
    return {
      ok: true,
      e164,
      remaining,
      message: `الكود اتبعت في رسالة SMS على ${e164} — اكتب الكود اللي وصلك (6 أرقام). فاضل ${remaining} من 3 طلبات في الساعة.`,
    }
  }

  // --- الويب: signInWithPhoneNumber مع reCAPTCHA مخفي ---
  // مسار الويب بس هو اللي محتاج نسخة Auth من JS SDK
  const auth = getFirebaseAuth()
  if (!auth) {
    return { ok: false, remaining: 0, message: 'Firebase Auth مش متاح دلوقتي — حاول تاني.' }
  }
  try {
    if (!verifier) {
      verifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
        size: 'invisible',
      })
    }
    await verifier.render()
    confirmation = await signInWithPhoneNumber(auth, e164, verifier)

    // سجّل الطلب بعد الإرسال الناجح بس (مش على الفشل)
    records[phone] = { requests: [...recent, now] }
    save(records)
    const remaining = OTP_MAX_PER_HOUR - recent.length - 1
    return {
      ok: true,
      e164,
      remaining,
      message: `الكود اتبعت في رسالة SMS على ${e164} — اكتب الكود اللي وصلك (6 أرقام). فاضل ${remaining} من 3 طلبات في الساعة.`,
    }
  } catch (e) {
    console.warn('Firebase Phone Auth send failed:', e)
    clearVerifier()
    confirmation = null
    return {
      ok: false,
      remaining: OTP_MAX_PER_HOUR - recent.length,
      message: firebaseErrorMessage(errorCode(e)),
    }
  }
}

/**
 * يتأكد من الكود اللي وصلك في رسالة SMS (6 أرقام).
 * `phone` اختياري: مسار الـ Worker (textbee) يحتاجه، أما مسار Firebase
 * فيعتمد على حالة الوحدة (nativeVerificationId / confirmation) فقط.
 */
export async function verifyOtpCode(
  input: string,
  phone?: string,
): Promise<{ ok: boolean; message: string }> {
  const code = normalizeDigits(input.trim())
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, message: 'الكود 6 أرقام — اكتب الكود اللي وصلك في رسالة SMS.' }
  }
  // --- مسار الـ Worker (أرقام غير الاختبار): الكود اتبعت عن طريق textbee ---
  // يتفرع هنا بس لو مفيش حالة Firebase معلّقة (أرقام الاختبار بتوصل
  // هنا ولها nativeVerificationId/confirmation من مسار Firebase).
  const e164 = phone ? toE164Phone(phone) : null
  if (
    e164 &&
    !TEST_NUMBERS.has(e164) &&
    isOtpWorkerConfigured() &&
    !nativeVerificationId &&
    !confirmation
  ) {
    const w = await verifyOtpWithWorker(e164, code)
    if (!w.ok) {
      return { ok: false, message: workerVerifyErrorMessage(w) }
    }
    if (!w.customToken) {
      return {
        ok: false,
        message:
          'تم تأكيد الكود، بس حصلت مشكلة في تسجيل الدخول — اطلب كود جديد وحاول تاني.',
      }
    }
    // ثبّت جلسة Firebase بالـ custom token (JS SDK — نفس النسخة اللي
    // بيستخدمها Firestore). الكود اتأكد عند الـ Worker خلاص؛ لو تثبيت
    // الجلسة فشل، الدخول يكمل عادي لأن finishAuth مبني على رقم
    // التليفون مش على Auth — والتحذير يتسجل للتشخيص.
    const auth = getFirebaseAuth()
    if (auth) {
      try {
        await signInWithCustomToken(auth, w.customToken)
      } catch (e) {
        console.warn('signInWithCustomToken failed after Worker OTP verify:', e)
      }
    } else {
      console.warn('Worker OTP verified but Firebase Auth is not available.')
    }
    return { ok: true, message: 'تم تأكيد رقمك بنجاح.' }
  }
  // --- أندرويد: تأكيد أصلي ---
  if (Capacitor.isNativePlatform()) {
    if (!nativeVerificationId) {
      return { ok: false, message: 'اطلب كود الأول — دوس «ابعت كود التحقق».' }
    }
    try {
      await FirebaseAuthentication.confirmVerificationCode({
        verificationId: nativeVerificationId,
        verificationCode: code,
      })
      nativeVerificationId = null
      return { ok: true, message: 'تم تأكيد رقمك بنجاح.' }
    } catch (e) {
      console.warn('Native Firebase Phone Auth confirm failed:', e)
      const errCode = errorCode(e)
      if (errCode === 'auth/code-expired' || errCode === 'auth/session-expired') {
        nativeVerificationId = null
      }
      return { ok: false, message: firebaseErrorMessage(errCode) }
    }
  }
  if (!confirmation) {
    return { ok: false, message: 'اطلب كود الأول — دوس «ابعت كود التحقق».' }
  }
  try {
    await confirmation.confirm(code)
    clearVerifier()
    confirmation = null
    return { ok: true, message: 'تم تأكيد رقمك بنجاح.' }
  } catch (e) {
    console.warn('Firebase Phone Auth confirm failed:', e)
    const errCode = errorCode(e)
    if (errCode === 'auth/code-expired' || errCode === 'auth/session-expired') {
      confirmation = null
      clearVerifier()
    }
    return { ok: false, message: firebaseErrorMessage(errCode) }
  }
}

/** كم طلب كود فاضل للرقم ده في الساعة الحالية؟ */
export function otpRemaining(phone: string): number {
  const rec = load()[phone.trim()]
  if (!rec) return OTP_MAX_PER_HOUR
  return Math.max(
    0,
    OTP_MAX_PER_HOUR - pruneRequests(rec.requests, Date.now()).length,
  )
}
