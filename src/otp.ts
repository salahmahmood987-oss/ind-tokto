// ---------------------------------------------------------------------------
// OTP حقيقي — Firebase Phone Auth (signInWithPhoneNumber)
// الكود يتبعت برسالة SMS حقيقية من Firebase على موبايل العميل، و**لا يظهر
// أبداً داخل التطبيق**. لا يوجد كود تجريبي هنا.
//
// المسار:
//   1) sendOtpCode(phone) — يحوّل الرقم لصيغة E.164 (+20...)، يتأكد من حد
//      التطبيق (3 طلبات في الساعة لكل رقم — قبل ما ننادي Firebase عشان
//      ما نحرقش رسايل SMS)، ثم signInWithPhoneNumber مع reCAPTCHA مخفي.
//   2) verifyOtpCode(code) — يستدعي ConfirmationResult.confirm(code).
//
// حدود Firebase نفسها: المشاريع الجديدة ليها حد **10 رسايل SMS في اليوم**
// لحد ما يضيف صلاح حساب فوترة (Blaze) للمشروع من الكونسول، وبعدها الحد
// بيرتفع والدفع بيكون حسب الاستخدام. خطأ auth/quota-exceeded معناه إن
// الحد اليومي خلص.
// ---------------------------------------------------------------------------
import { RecaptchaVerifier, signInWithPhoneNumber } from 'firebase/auth'
import type { ConfirmationResult } from 'firebase/auth'
import { getFirebaseAuth } from './firebaseApp'
import { isFirebaseConfigured } from './firebaseConfig'
import { OTP_MAX_PER_HOUR } from './types'

const OTP_KEY = 'indtoktok_otp_v1'

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
      return 'الدومين ده مش مصرّح ليه في Firebase — أضف الدومين من Authentication ← Settings ← Authorized domains.'
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
      return 'حصلت مشكلة في إرسال/تأكيد الكود — حاول تاني.'
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
  message: string
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

/** يتأكد من الكود اللي وصلك في رسالة SMS (6 أرقام). */
export async function verifyOtpCode(
  input: string,
): Promise<{ ok: boolean; message: string }> {
  const code = normalizeDigits(input.trim())
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, message: 'الكود 6 أرقام — اكتب الكود اللي وصلك في رسالة SMS.' }
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
