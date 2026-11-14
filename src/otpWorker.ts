// ---------------------------------------------------------------------------
// عميل Cloudflare Worker لأكواد OTP عن طريق textbee SMS.
// الـ Worker (~/workspace/ind-toktok-otp-worker/worker.js) هو اللي بيولّد
// الكود، ويفرض حد 3 أكواد/ساعة، ويبعت الـ SMS من موبايل صلاح، ويتحقق
// من الكود ويرجّع Firebase custom token. التطبيق لا يعرف الكود ولا
// مفتاح textbee أبداً — بس بينادي نقطتين:
//   POST {WORKER_URL}/request-otp { phone }  -> { ok, remaining, ... }
//   POST {WORKER_URL}/verify-otp  { phone, code } -> { ok, customToken }
// رابط الـ Worker علني (مش سر) وبيتضبط وقت البناء بـ VITE_OTP_WORKER_URL.
// لو المتغير مش مضبوط، isOtpWorkerConfigured() ترجع false والتطبيق
// يرجع لمسار Firebase Phone Auth الحالي.
// ---------------------------------------------------------------------------

const WORKER_URL = (
  import.meta.env.VITE_OTP_WORKER_URL as string | undefined
)
  ?.trim()
  .replace(/\/$/, '') || ''

/** هل رابط الـ Worker مضبوط في البناء؟ */
export function isOtpWorkerConfigured(): boolean {
  return WORKER_URL.length > 0
}

export interface WorkerOtpResponse {
  ok: boolean
  e164?: string
  remaining?: number
  waitMinutes?: number
  error?: string
  message?: string
}

export interface WorkerVerifyResponse {
  ok: boolean
  customToken?: string
  error?: string
  message?: string
  attemptsLeft?: number
}

const WORKER_UNREACHABLE =
  'مشكلة في الاتصال بسيرفر الأكواد — تأكد إن النت شغال وحاول تاني.'

async function postJson(
  path: string,
  body: unknown,
): Promise<Record<string, unknown> | null> {
  let res: Response
  try {
    res = await fetch(`${WORKER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return null
  }
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

export async function requestOtpFromWorker(
  phone: string,
): Promise<WorkerOtpResponse> {
  const data = await postJson('/request-otp', { phone })
  if (!data) return { ok: false, error: 'network', message: WORKER_UNREACHABLE }
  return {
    ok: data.ok === true,
    e164: asString(data.e164),
    remaining: asNumber(data.remaining),
    waitMinutes: asNumber(data.waitMinutes),
    error: asString(data.error),
    message: asString(data.message),
  }
}

export async function verifyOtpWithWorker(
  phone: string,
  code: string,
): Promise<WorkerVerifyResponse> {
  const data = await postJson('/verify-otp', { phone, code })
  if (!data) return { ok: false, error: 'network', message: WORKER_UNREACHABLE }
  return {
    ok: data.ok === true,
    customToken: asString(data.customToken),
    error: asString(data.error),
    message: asString(data.message),
    attemptsLeft: asNumber(data.attemptsLeft),
  }
}
