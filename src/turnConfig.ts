// ============================================================================
//  إعدادات ICE للمكالمات الصوتية VoIP (v53)
//  ----------------------------------------------------------------------------
//  • TURN بتاع Metered (Open Relay) شغال دلوقتي بالمفاتيح الحقيقية —
//    بيمرّر الصوت عبر سيرفر وسيط لما الشبكة تمنع الاتصال المباشر.
//    الخطة المجانية 500MB/شهر (حد صارم، من غير بطاقة)، والصوت حوالي
//    0.25MB في الدقيقة.
//  • STUN بتاع Metered شغال كمان للاتصال المباشر.
//  • ملحوظة: المفاتيح الجديدة ممكن تاخد لحد دقيقتين عشان توصل لكل
//    سيرفرات TURN — لو مكالمة فشلت في أول دقيقتين بعد التحديث،
//    جرّب تاني.
// ============================================================================

/** خوادم ICE للمكالمات — STUN + TURN بتاع Metered (مفاتيح حقيقية، v53) */
const iceServers: RTCIceServer[] = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', username: 'b31361534eee8330d31e937c', credential: 'XOETYTUlhgWLF9fn' },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'b31361534eee8330d31e937c', credential: 'XOETYTUlhgWLF9fn' },
  { urls: 'turn:global.relay.metered.ca:443', username: 'b31361534eee8330d31e937c', credential: 'XOETYTUlhgWLF9fn' },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'b31361534eee8330d31e937c', credential: 'XOETYTUlhgWLF9fn' },
]

/** TURN متظبط بالمفاتيح الحقيقية من v53 */
export const isTurnConfigured = true

/** خوادم ICE للاتصال: STUN + TURN بتاع Metered */
export function getIceServers(): RTCIceServer[] {
  return [...iceServers]
}
