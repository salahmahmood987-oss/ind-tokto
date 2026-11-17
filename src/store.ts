import type {
  AdminSettings,
  DriverProfile,
  LaunchWaitlistEntry,
  PassengerProfile,
  PaymentRequest,
  Ride,
  WaitlistEntry,
} from './types'
import { COMMISSION_RATE } from './types'

export interface AppState {
  passenger: PassengerProfile | null
  driver: DriverProfile
  rides: Ride[]
  payments: PaymentRequest[]
  /** كل السواقين المسجلين (مزامنة حية من Firestore — للإدارة فقط) */
  drivers: DriverProfile[]
  /** كل العملاء المسجلين (مزامنة حية من Firestore — للإدارة فقط) */
  passengers: PassengerProfile[]
  /** قايمة انتظار التوسع — عملاء من برّه النطاق سابوا أرقامهم (للإدارة فقط) */
  waitlist: WaitlistEntry[]
  /** قايمة انتظار الإطلاق (v44) — عملاء سابوا أرقامهم عشان نبلغهم لما الخدمة تشتغل (للإدارة فقط) */
  launchWaitlist: LaunchWaitlistEntry[]
  admin: AdminSettings
  /** آخر رقم طلب مستخدم — حقل قديم (محلي فقط). رقم الطلب بقى من عدّاد
   *  السيرفر (nextOrderNumber في firebaseDb) من v48 — كل راكب أول رحلة
   *  ليه كانت #1001 قبل كده، فالرحلات كانت بتتصادم وتتكتب فوق بعض. */
  lastOrderNum: number
  /** آخر كود سواق مستخدم — السواق الجاي D-1002... */
  lastDriverNum: number
}

const KEY = 'indtoktok_state_v1'

function stableCode(prefix: string, phone: string): string {
  let h = 0
  for (const ch of phone) h = (h * 31 + ch.charCodeAt(0)) % 10000
  return `${prefix}-${1000 + h}`
}

/** أرقام الأدمن — الوحيدة اللي بتفتح لوحة الإدارة (صلاح).
 *  (v48: قبل كده زرار «الإدارة» كان ظاهر لأي سواق وبيفتح كل حاجة من غير أي فحص) */
export const ADMIN_PHONES = ['+201550364683', '+201515149075']

/** كود عميل ثابت لنفس رقم الموبايل */
export function clientCodeForPhone(phone: string): string {
  return stableCode('C', phone)
}

/** كود سواق من رقم الموبايل نفسه — D- + أرقام الهاتف (E.164 من غير +).
 *  (v48: الهاش القديم كان 10,000 قيمة بس — مع 100 سواق احتمال التصادم ~39%
 *  ويرجع نفس خلل D-1001 بالظبط. الكود من الرقم نفسه مستحيل يتصادم،
 *  وثابت لنفس الرقم مهما اتسجل من أي جهاز — بشرط تطبيع الرقم بـ toE164Phone
 *  قبل الاشتقاق، وده بيتعمل في finishAuth والترحيل عند الفتح) */
export function driverCodeForPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `D-${digits}`
}

export function defaultDriver(): DriverProfile {
  return {
    name: '',
    phone: '',
    code: 'D-1001',
    plate: '',
    color: '',
    model: '',
    online: false,
    sharingLocation: true,
    ratingAvg: 0,
    ratingCount: 0,
    debt: 0,
    totalPaid: 0,
    balance: 0,
    idCardUrl: null,
    idCardStatus: 'none',
    photoUrl: null,
    currentLat: null,
    currentLng: null,
    createdAt: 0,
  }
}

export function defaultState(): AppState {
  return {
    passenger: null,
    driver: defaultDriver(),
    rides: [],
    payments: [],
    drivers: [],
    passengers: [],
    waitlist: [],
    launchWaitlist: [],
    admin: { walletNumber: '', walletName: '' },
    lastOrderNum: 1000,
    lastDriverNum: 1001,
  }
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaultState()
    const parsed = JSON.parse(raw) as AppState
    // دمج عميق لملف السواق: نسخ قديمة محفوظة قبل إضافة debt/totalPaid
    // كانت هتخليهم undefined — القيم الافتراضية بتملا الناقص
    return {
      ...defaultState(),
      ...parsed,
      driver: { ...defaultState().driver, ...(parsed.driver ?? {}) },
    }
  } catch {
    return defaultState()
  }
}

export function saveState(state: AppState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // بعض المتصفحات الداخلية تحظر التخزين — نكمل بدون حفظ
  }
}

/** عمولة 5% من سعر الرحلة المكتملة */
export function commissionFor(fare: number): number {
  return Math.round(fare * COMMISSION_RATE * 100) / 100
}

/** هل السواق محظور من استقبال رحلات جديدة؟ (وصل لحد المديونية 100 جنيه) */
export function isDebtBlocked(debt: number): boolean {
  return debt >= 100
}

/** سواقون تجريبيون للوضع المحلي فقط — في Firebase الحقيقي، العروض
 *  تأتي من السواقين المسجلين فعلاً (مجموعة drivers في Firestore). */
export const DEMO_DRIVERS = [
  { name: 'أحمد الكابتن', code: 'D-2001', rating: 4.8, plate: 'أ ب ج 1234', color: 'أصفر', model: 'توكتوك 2023' },
  { name: 'محمود السواق', code: 'D-2002', rating: 4.5, plate: 'س ع ص 5678', color: 'أخضر', model: 'توكتوك 2022' },
  { name: 'حسن توكتوك', code: 'D-2003', rating: 4.9, plate: 'ط ظ ع 9012', color: 'أحمر', model: 'توكتوك 2024' },
]
