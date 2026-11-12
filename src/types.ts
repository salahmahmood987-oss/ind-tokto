export interface LatLng {
  lat: number
  lng: number
  label: string
}

export type Role = 'passenger' | 'driver' | 'wallet' | 'admin'

export interface PassengerProfile {
  name: string
  phone: string
  /** كود عميل ثابت لنفس رقم الموبايل، مثل C-1002 */
  code: string
  phoneVerified: boolean
  ratingAvg: number
  ratingCount: number
}

export interface DriverProfile {
  name: string
  phone: string
  /** كود سواق مثل D-1001 */
  code: string
  plate: string
  color: string
  model: string
  online: boolean
  sharingLocation: boolean
  ratingAvg: number
  ratingCount: number
  /** صورة البطاقة: Data URL مضغوطة (JPEG) مخزنة داخل مستند Firestore — بدون Storage */
  idCardUrl: string | null
  idCardStatus: 'none' | 'pending' | 'approved' | 'rejected'
  currentLat: number | null
  currentLng: number | null
}

export type RideStatus =
  | 'searching'
  | 'matched'
  | 'driver_arrived'
  | 'on_trip'
  | 'completed'
  | 'cancelled'

export interface Offer {
  id: string
  rideId: string
  driverCode: string
  driverName: string
  driverRating: number
  price: number
  etaMinutes: number
  plate: string
  color: string
  model: string
}

export interface Ride {
  /** رقم الطلب مثل #1001 */
  orderNo: string
  passengerCode: string
  passengerName: string
  passengerPhone: string
  passengerRating: number
  pickup: LatLng
  destination: LatLng
  fare: number
  status: RideStatus
  driverCode: string | null
  driverName: string | null
  driverLat: number | null
  driverLng: number | null
  driverLocAt: number | null
  offers: Offer[]
  createdAt: number
  /** تقييم الراكب للكابتن بعد الرحلة */
  passengerRatingForDriver: number | null
  /** تقييم الكابتن للراكب بعد الرحلة */
  driverRatingForPassenger: number | null
}

export interface PaymentRequest {
  id: string
  driverCode: string
  driverName: string
  amount: number
  /** صورة التحويل: Data URL مضغوطة (JPEG) مخزنة داخل مستند Firestore — بدون Storage */
  screenshotUrl: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
}

export interface AdminSettings {
  walletNumber: string
  walletName: string
}

export const COMMISSION_RATE = 0.05 // عمولة 5%
export const MAX_DEBT_EGP = 100 // حد المديونية 100 جنيه
export const OTP_MAX_PER_HOUR = 3 // حد طلبات الكود: 3 في الساعة لكل رقم
export const OTP_VALID_MINUTES = 10 // صلاحية الكود (للعرض فقط — Firebase يدير صلاحية كوده بنفسه)
export const OTP_CODE_LENGTH = 6 // كود Firebase Phone Auth: 6 أرقام يوصلوا برسالة SMS
export const FARE_MIN = 5
export const FARE_MAX = 500
