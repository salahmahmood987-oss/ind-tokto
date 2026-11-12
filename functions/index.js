// ============================================================================
//  ⚠️ غير مستخدم دلوقتي — صلاح اختار Firebase Phone Auth (2026-11-12)
//  بدل Twilio، والـ OTP الحقيقي شغال من src/otp.ts عبر Firebase Auth.
//  الملف ده هيكل جاهز محفوظ كمرجع بس، ومش مفعّل ولا يتنشر.
// ============================================================================
//  Firebase Cloud Function — إرسال كود OTP برسالة SMS عادية (Twilio SMS API)
//  SMS_PROVIDER_TODO — هذا الملف هيكل جاهز، وليس مفعّلاً بعد.
//
//  خطوات التفعيل (بعد إنشاء مشروع Firebase ind-toktok):
//  1) cd functions && npm install firebase-functions firebase-admin twilio
//  2) احفظ مفاتيح Twilio كـ secrets (لا تضعها في الكود أبداً):
//       firebase functions:secrets:set TWILIO_SID
//       firebase functions:secrets:set TWILIO_TOKEN
//       firebase functions:secrets:set TWILIO_FROM   (رقم الإرسال)
//  3) firebase deploy --only functions
//  4) في src/otp.ts بدّل sendOtpCode() لتنادي هذه الـ Function بدل
//     توليد الكود محلياً، واحذف عرض الكود التجريبي من التطبيق.
//
//  الحد الصارم الذي اختاره صلاح: 3 أكواد في الساعة لكل رقم تليفون.
//  يُحفظ العداد في Firestore: otpRateLimits/{phone}.
// ============================================================================
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { defineSecret } = require('firebase-functions/params')
const admin = require('firebase-admin')

admin.initializeApp()

const twilioSid = defineSecret('TWILIO_SID')
const twilioToken = defineSecret('TWILIO_TOKEN')
const twilioFrom = defineSecret('TWILIO_FROM')

const OTP_MAX_PER_HOUR = 3
const OTP_VALID_MINUTES = 10

exports.sendOtp = onCall(
  { secrets: [twilioSid, twilioToken, twilioFrom] },
  async (request) => {
    const phone = String(request.data.phone || '').trim()
    if (!/^01[0-9]{9}$/.test(phone)) {
      throw new HttpsError('invalid-argument', 'رقم تليفون مصري غير صحيح')
    }
    const db = admin.firestore()
    const ref = db.collection('otpRateLimits').doc(phone)
    const now = Date.now()
    const hourAgo = now - 60 * 60 * 1000

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const data = snap.exists ? snap.data() : { requests: [] }
      const recent = (data.requests || []).filter((t) => t > hourAgo)
      if (recent.length >= OTP_MAX_PER_HOUR) {
        const oldest = Math.min(...recent)
        const waitMinutes = Math.max(
          1,
          Math.ceil((60 * 60 * 1000 - (now - oldest)) / 60000),
        )
        return { ok: false, waitMinutes }
      }
      const code = String(Math.floor(1000 + Math.random() * 9000))
      tx.set(ref, {
        requests: [...recent, now],
        code,
        expiresAt: now + OTP_VALID_MINUTES * 60 * 1000,
      })
      return { ok: true, code }
    })

    if (!result.ok) {
      throw new HttpsError(
        'resource-exhausted',
        `وصلت للحد الأقصى — 3 أكواد بس في الساعة. استنى ${result.waitMinutes} دقيقة.`,
      )
    }

    // إرسال SMS عادية عبر Twilio (وليس Twilio Verify — صلاح اختار العادية)
    const twilio = require('twilio')(twilioSid.value(), twilioToken.value())
    await twilio.messages.create({
      from: twilioFrom.value(),
      to: `+2${phone}`,
      body: `كود ind toktok: ${result.code} — صالح 10 دقائق.`,
    })
    return { ok: true, remaining: OTP_MAX_PER_HOUR - 1 }
  },
)
