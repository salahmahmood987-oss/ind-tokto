/**
 * نطاق الخدمة: محافظتا أسيوط وسوهاج بكل قراهم.
 *
 * الفحص على مرحلتين:
 *  1. مربع جغرافي سريع (من غير نت) يرفض أي نقطة بعيدة فوراً.
 *  2. تأكيد باسم المحافظة (Nominatim — مجاني) عشان القرى اللي على
 *     حدود المنيا وقنا (الملوي، دشنا...) متتعدّاش بالغلط.
 * لو التأكيد فشل (مفيش نت) بنسمح بالطلب — مينفعش عميل حقيقي يتعطل
 * عشان الشبكة وقعت لحظة الطلب.
 */

export const SERVICE_BBOX = {
  /** جنوب سوهاج (حدود قنا) */
  minLat: 26.0,
  /** شمال أسيوط (حدود المنيا) */
  maxLat: 27.8,
  /** غرب النيل (الصحراء الغربية) */
  minLng: 30.4,
  /** شرق النيل (الصحراء الشرقية) */
  maxLng: 32.6,
}

/** عنوان رسالة برّه النطاق */
export const OUT_OF_AREA_TITLE = 'لسه موصلناش للمكان ده'

/** رسالة برّه النطاق — بتظهر للعميل لما يطلب من برّه أسيوط وسوهاج */
export const OUT_OF_AREA_MESSAGE =
  'خدمة ind toktok شغالة حالياً في أسيوط وسوهاج بس — من المدينة لأي قرية فيهم. وهنوصل لمنطقتك قريب إن شاء الله، دوس «بلّغني» وهنكلمك أول ما نفتح عندك.'

export function isInServiceBBox(lat: number, lng: number): boolean {
  return (
    lat >= SERVICE_BBOX.minLat &&
    lat <= SERVICE_BBOX.maxLat &&
    lng >= SERVICE_BBOX.minLng &&
    lng <= SERVICE_BBOX.maxLng
  )
}

/** يجيب اسم المحافظة من الإحداثيات (Nominatim — مجاني) — null لو فشل. */
async function reverseGovernorate(lat: number, lng: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1&accept-language=en`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = await res.json()
    const state = data?.address?.state as string | undefined
    return state ?? null
  } catch {
    return null
  }
}

const SERVICE_STATES = [/assiut/i, /sohag/i, /أسيوط/, /سوهاج/]

/** النقطة دي جوّه نطاق الخدمة؟ */
export async function isInServiceArea(lat: number, lng: number): Promise<boolean> {
  if (!isInServiceBBox(lat, lng)) return false
  const state = await reverseGovernorate(lat, lng)
  if (!state) return true
  return SERVICE_STATES.some((re) => re.test(state))
}
