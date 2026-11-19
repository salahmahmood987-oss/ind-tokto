// ============================================================================
//  مدير مكالمة صوتية واحدة (v52) — WebRTC صوت بس، من غير فيديو.
//  ----------------------------------------------------------------------------
//  الإشارة (offer/answer/ICE) بتتم عبر مستند Firestore calls/{orderNo}
//  (الدوال في firebaseDb.ts). الصوت نفسه مباشر بين الجهازين عبر STUN،
//  وTURN بتاع Metered لما صلاح يبعت المفتاح (turnConfig.ts).
//
//  الطرف اللي بيبدأ المكالمة بيعمل offer وبيكتب المستند بحالة ringing.
//  الطرف التاني بيشوف المستند (اشتراك حي في App.tsx) وبيقبل أو يرفض.
//  القبول بيعمل answer وبيقلب الحالة active. أي طرف بينهي بيكتب ended
//  فالطرف التاني بيقفل على طول. انتهاء الرحلة أو إلغاؤها بينهي المكالمة.
// ============================================================================
import { addCallCandidate, createCallDoc, updateCallDoc } from './firebaseDb'
import { getIceServers } from './turnConfig'
import type { RideCall } from './types'

export type VoiceCallEndReason = 'remote-ended' | 'declined' | 'failed' | 'no-answer'

export type VoiceCallEvent =
  | { type: 'connected' }
  | { type: 'ended'; reason: VoiceCallEndReason }
  | { type: 'error'; message: string }

export interface VoiceCallCallbacks {
  onEvent: (e: VoiceCallEvent) => void
}

/** رسالة عربية واضحة حسب سبب فشل الميكروفون — مش كود تقني */
function micErrorMessage(e: unknown): string {
  if (!navigator.mediaDevices?.getUserMedia) return 'المتصفح مش بيدعم المكالمات الصوتية على الجهاز ده.'
  if (e instanceof DOMException) {
    if (e.name === 'NotAllowedError') return 'المكالمة محتاجة إذن الميكروفون — فعّله من إعدادات التطبيق وحاول تاني.'
    if (e.name === 'NotFoundError') return 'مفيش ميكروفون متاح على الجهاز ده.'
    if (e.name === 'NotReadableError') return 'الميكروفون مشغول بتطبيق تاني — اقفله وحاول تاني.'
  }
  return 'مقدرناش نشغّل الميكروفون — تأكد من الإذن وحاول تاني.'
}

export class VoiceCall {
  private pc: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private remoteAudio: HTMLAudioElement | null = null
  private seenCandidates = new Set<string>()
  private answerApplied = false
  private closed = false
  private failedNotified = false
  private rideId: string
  private myRole: 'passenger' | 'driver'
  private cb: VoiceCallCallbacks
  muted = false

  constructor(rideId: string, myRole: 'passenger' | 'driver', cb: VoiceCallCallbacks) {
    this.rideId = rideId
    this.myRole = myRole
    this.cb = cb
  }

  /** يطلب الميكروفون — بيرمي Error برسالة عربية لو اترفض أو مش متاح */
  private async requestMic(): Promise<MediaStream> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-getUserMedia')
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
    } catch (e) {
      throw new Error(micErrorMessage(e))
    }
  }

  /** يبني اتصال WebRTC جديد ويوصّل مساراته (الميكروفون + صوت الطرف التاني) */
  private makePc(side: 'caller' | 'callee'): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: getIceServers() })
    pc.onicecandidate = (e) => {
      if (e.candidate) void addCallCandidate(this.rideId, side, e.candidate.toJSON())
    }
    pc.ontrack = (e) => {
      const stream = e.streams[0]
      if (!stream) return
      if (!this.remoteAudio) {
        this.remoteAudio = new Audio()
        this.remoteAudio.autoplay = true
      }
      this.remoteAudio.srcObject = stream
      void this.remoteAudio.play().catch(() => { /* التشغيل بيبدأ مع أول صوت */ })
    }
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState
      if (s === 'connected') this.cb.onEvent({ type: 'connected' })
      if (s === 'failed' && !this.failedNotified) {
        this.failedNotified = true
        this.cb.onEvent({ type: 'error', message: 'تعذّر الاتصال الصوتي — تأكد من النت وحاول تاني.' })
        void this.end()
      }
    }
    return pc
  }

  /** يضيف تراكات الميكروفون للاتصال */
  private addLocalTracks(pc: RTCPeerConnection, stream: MediaStream) {
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream)
  }

  /**
   * بدء مكالمة (المتصل): ميكروفون + offer + مستند calls بحالة ringing.
   * بيرمي Error برسالة عربية لو الميكروفون اترفض أو مفيش اتصال بالسيرفر.
   */
  async start(myName: string): Promise<void> {
    const stream = await this.requestMic()
    this.localStream = stream
    const pc = this.makePc('caller')
    this.pc = pc
    this.addLocalTracks(pc, stream)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const ok = await createCallDoc({
      rideId: this.rideId,
      status: 'ringing',
      callerRole: this.myRole,
      callerName: myName,
      offer: { type: offer.type, sdp: offer.sdp ?? '' },
      answer: null,
      callerCandidates: [],
      calleeCandidates: [],
      updatedAt: Date.now(),
    })
    if (!ok) {
      this.closeLocal()
      throw new Error('مفيش اتصال بالسيرفر — تأكد من النت وحاول تاني.')
    }
  }

  /**
   * قبول مكالمة واردة (الطرف التاني): ميكروفون + answer + الحالة active.
   * بيرمي Error برسالة عربية لو الميكروفون اترفض.
   */
  async accept(doc: RideCall): Promise<void> {
    if (!doc.offer) throw new Error('المكالمة دي انتهت — حاول تاني.')
    const stream = await this.requestMic()
    this.localStream = stream
    const pc = this.makePc('callee')
    this.pc = pc
    this.addLocalTracks(pc, stream)
    await pc.setRemoteDescription(new RTCSessionDescription({ type: doc.offer.type as RTCSdpType, sdp: doc.offer.sdp }))
    this.applyRemoteCandidates(doc.callerCandidates)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await updateCallDoc(this.rideId, {
      answer: { type: answer.type, sdp: answer.sdp ?? '' },
      status: 'active',
    })
  }

  /** المتصل: يطبّق إجابة الطرف التاني + مرشحيه (مرة واحدة بس) */
  async applyAnswer(doc: RideCall): Promise<void> {
    if (this.answerApplied || !this.pc || !doc.answer) return
    this.answerApplied = true
    try {
      if (this.pc.signalingState !== 'stable') {
        await this.pc.setRemoteDescription(new RTCSessionDescription({ type: doc.answer.type as RTCSdpType, sdp: doc.answer.sdp }))
      }
      this.applyRemoteCandidates(doc.calleeCandidates)
    } catch {
      // الإجابة وصلت متأخرة أو الاتصال اتقفل — التجاهل آمن
    }
  }

  /** يضيف مرشحي ICE من الطرف التاني — من غير تكرار */
  applyRemoteCandidates(cands: RTCIceCandidateInit[]): void {
    if (!this.pc) return
    for (const c of cands) {
      const key = c.candidate ?? JSON.stringify(c)
      if (!key || this.seenCandidates.has(key)) continue
      this.seenCandidates.add(key)
      void this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => { /* مرشح قديم — تجاهل */ })
    }
  }

  /** رفض مكالمة واردة — بيبلّغ الطرف التاني وبيقفل محلياً */
  async decline(): Promise<void> {
    await updateCallDoc(this.rideId, { status: 'declined' })
    this.closeLocal()
  }

  /** إنهاء المكالمة — بيبلّغ الطرف التاني وبيقفل محلياً */
  async end(): Promise<void> {
    await updateCallDoc(this.rideId, { status: 'ended' })
    this.closeLocal()
    this.cb.onEvent({ type: 'ended', reason: 'remote-ended' })
  }

  /** قفل محلي بس (من غير كتابة على السيرفر) — لما الطرف التاني أنهى خلاص */
  closeLocal(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.localStream?.getTracks().forEach((t) => t.stop())
    } catch { /* ignore */ }
    this.localStream = null
    try {
      this.pc?.close()
    } catch { /* ignore */ }
    this.pc = null
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null
      this.remoteAudio = null
    }
  }

  /** كتم/إلغاء كتم الميكروفون — بيرجع الحالة الجديدة (true = مكتوم) */
  toggleMute(): boolean {
    this.muted = !this.muted
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !this.muted
    })
    return this.muted
  }

  /**
   * تبديل السماعة الخارجية — محاولة best-effort عبر setSinkId.
   * على أندرويد الـ WebView مش بيدعم تبديل مخرج الصوت من الويب،
   * فبيرجع false وساعتها الواجهة بتوضّح ده للمستخدم.
   */
  async setSpeaker(on: boolean): Promise<boolean> {
    const audio = this.remoteAudio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> } | null
    if (!audio || typeof audio.setSinkId !== 'function') return false
    try {
      await audio.setSinkId(on ? 'default' : '')
      return true
    } catch {
      return false
    }
  }
}
