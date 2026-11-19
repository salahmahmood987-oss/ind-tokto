// ============================================================================
//  إعدادات ICE للمكالمات الصوتية VoIP (v52)
//  ----------------------------------------------------------------------------
//  • STUN العام بتاع Google شغال على طول — كفاية للمكالمات المباشرة
//    (لما الجهازين يقدروا يوصلوا لبعض مباشرة، وده الغالب).
//  • TURN بتاع Metered (Open Relay) بيشتغل بس لما الشبكة تمنع الاتصال
//    المباشر — بيمرّر الصوت عبر سيرفر وسيط. الخطة المجانية 500MB/شهر
//    (حد صارم، من غير بطاقة)، والصوت حوالي 0.25MB في الدقيقة.
//
//  ⚠️ مفتاح Metered لسه مش موجود — القيم دي PLACEHOLDERS عمداً.
//  صلاح هيبعت مفتاح الـ API لما يعمل حساب مجاني على metered.ca،
//  وساعتها نملا القيم دي. لحد ما يحصل ده التطبيق بيشتغل بـ STUN
//  بس، والمكالمات هتنجح في أغلب الحالات (اتصال مباشر).
//  ❌ ممنوع تخمين أو اختراع أي مفتاح هنا.
// ============================================================================

/** عنوان خادم TURN بتاع Metered — PLACEHOLDER لحد ما صلاح يبعت المفتاح.
 *  الصيغة لما يتملا: 'turns:standard.relay.metered.ca:443' */
export const METERED_TURN_URL = ''

/** اسم المستخدم بتاع TURN — PLACEHOLDER (بييجي من Metered مع المفتاح) */
export const METERED_TURN_USERNAME = ''

/** كلمة السر بتاعة TURN — PLACEHOLDER (بييجي من Metered مع المفتاح) */
export const METERED_TURN_CREDENTIAL = ''

/** true بس لما صلاح يبعت مفتاح Metered ونملا القيم فوق */
export const isTurnConfigured =
  METERED_TURN_URL.trim() !== '' &&
  METERED_TURN_USERNAME.trim() !== '' &&
  METERED_TURN_CREDENTIAL.trim() !== ''

/** خوادم ICE للاتصال: STUN العام دايماً + TURN بتاع Metered لو متظبط */
export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
  if (isTurnConfigured) {
    servers.push({
      urls: METERED_TURN_URL,
      username: METERED_TURN_USERNAME,
      credential: METERED_TURN_CREDENTIAL,
    })
  }
  return servers
}
