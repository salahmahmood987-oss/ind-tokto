import type {
  AdminSettings,
  DriverProfile,
  PassengerProfile,
  PaymentRequest,
  Ride,
} from './types'
import { COMMISSION_RATE } from './types'

export interface AppState {
  passenger: PassengerProfile | null
  driver: DriverProfile
  rides: Ride[]
  payments: PaymentRequest[]
  admin: AdminSettings
  /** آخر رقم طلب مستخدم — الطلب الجاي #1001 ثم #1002... */
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

/** كود عميل ثابت لنفس رقم الموبايل */
export function clientCodeForPhone(phone: string): string {
  return stableCode('C', phone)
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
    sharingLocation: false,
    ratingAvg: 0,
    ratingCount: 0,
    debt: 0,
    totalPaid: 0,
    idCardUrl: null,
    idCardStatus: 'none',
    photoUrl: null,
    currentLat: null,
    currentLng: null,
  }
}

export function defaultState(): AppState {
  return {
    passenger: null,
    driver: defaultDriver(),
    rides: [],
    payments: [],
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
