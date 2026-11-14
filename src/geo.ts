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

/** نتيجة تأكيد المحافظة: الاسم + الكود الرسمي ISO (الأدق) */
interface GovernorateInfo {
  state: string | null
  iso: string | null
}

/**
 * يجيب اسم المحافظة من الإحداثيات (Nominatim — مجاني) — null لو فشل.
 *
 * ⚠️ درس من v33: Nominatim بيكتب أسيوط "Asyut" وسوهاج "Suhaj" بالإنجليزي
 * (مش Assiut/Sohag) — فالمطابقة بالاسم لوحده كانت بترفض كل الطلبات الصح.
 * الكود الرسمي ISO3166-2 هو الأدق: أسيوط EG-AST، سوهاج EG-SHG.
 */
async function reverseGovernorate(lat: number, lng: number): Promise<GovernorateInfo | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1&accept-language=en`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = await res.json()
    const address = data?.address ?? {}
    return {
      state: typeof address.state === 'string' ? address.state : null,
      iso: typeof address['ISO3166-2-lvl4'] === 'string' ? address['ISO3166-2-lvl4'] : null,
    }
  } catch {
    return null
  }
}

/** أسيوط وسوهاج — بالكود الرسمي ISO أولاً، وبعدين بالاسم بكل تهجئاته */
const SERVICE_ISOS = new Set(['EG-AST', 'EG-SHG'])
const SERVICE_STATES = [/assiut|asyut|أسيوط/i, /sohag|suhaj|سوهاج/i]

/** النقطة دي جوّه نطاق الخدمة؟ */
export async function isInServiceArea(lat: number, lng: number): Promise<boolean> {
  if (!isInServiceBBox(lat, lng)) return false
  const info = await reverseGovernorate(lat, lng)
  if (!info) return true
  const iso = info.iso
  if (iso && SERVICE_ISOS.has(iso)) return true
  const state = info.state
  if (state && SERVICE_STATES.some((re) => re.test(state))) return true
  // لو مفيش اسم محافظة ولا كود (منطقة ناقصة البيانات) بنسمح — المربع هو الفيصل
  if (!iso && !state) return true
  return false
}
