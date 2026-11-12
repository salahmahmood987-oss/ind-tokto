// ---------------------------------------------------------------------------
//  الصور بدون Firebase Storage — ضغط محلي + Base64 داخل Firestore
//  ----------------------------------------------------------------------------
//  صلاح اختار عدم إضافة بطاقة فوترة / الترقية لـ Blaze دلوقتي، و Firebase
//  Storage في المشاريع الجديدة يتطلب Blaze — فالتطبيق لا يستخدم Storage
//  إطلاقاً. صور البطاقة وصور التحويل تتخزن كـ Data URL مضغوطة (JPEG)
//  داخل مستند Firestore نفسه (حقل idCardUrl / screenshotUrl).
//
//  حدود Firestore: المستند الواحد أقصاه 1 ميجابايت. الهدف هنا أبعد من
//  كده بكتير: الصورة المضغوطة لازم تبقى تحت ~250 كيلوبايت (باينري)،
//  عشان المستند يفضل صغير والقراءة/الكتابة تفضل سريعة ورخيصة.
//  لو الصورة لسه كبيرة بعد الضغط، الطلب يترفض برسالة عربية واضحة.
//
//  مقايضة معروفة: الحل ده مناسب للمقياس الصغير (عشرات/مئات الصور).
//  عند الترقية لـ Blaze لاحقاً، الترحيل سهل: ارفع الـ Data URLs
//  الموجودة لـ Storage مرة واحدة وبدّل الحقول بروابط التخزين.
// ---------------------------------------------------------------------------

/** أقصى حجم مسموح للصورة بعد الضغط (باينري، بالبايت) — هدفنا ~250KB. */
export const MAX_PHOTO_BYTES = 250_000
/** أقصى حجم مسموح لوثيقة Firestore ككل (1MB) — هامش أمان للمستند. */
export const FIRESTORE_DOC_LIMIT_BYTES = 1_048_576

/** يحوّل طول Data URL لحجم باينري تقريبي (Base64 ≈ 4/3 من الباينري). */
export function dataUrlApproxBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return Math.floor(b64.length * 0.75)
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(
        new Error(
          'مقدرناش نقرأ الصورة دي — جرّب صورة JPG عادية من الكاميرا أو المعرض.',
        ),
      )
    }
    img.src = url
  })
}

/** يصغّر الصورة لأقصى ضلع ويحوّلها JPEG بالجودة المطلوبة. */
function compress(img: HTMLImageElement, maxSide: number, quality: number): string {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const width = Math.max(1, Math.round(img.naturalWidth * scale))
  const height = Math.max(1, Math.round(img.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('المتصفح مش قادر يضغط الصورة — جرّب من متصفح تاني.')
  // خلفية بيضاء عشان JPEG مفيهوش شفافية (صور PNG بخلفية شفافة).
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', quality)
}

/**
 * يجهّز صورة (بطاقة أو سكرين شوت تحويل) للتخزين في Firestore:
 * تصغير + ضغط JPEG بمحاولات متدرجة، ويرجع Data URL جاهزة للحفظ.
 * يرمي Error برسالة عربية لو الملف مش صورة أو فضل كبير بعد الضغط.
 */
export async function preparePhotoForFirestore(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('اختار ملف صورة (JPG أو PNG) — الملف ده مش صورة.')
  }
  // حد أولي على حجم الملف الأصلي عشان ما نحاولش نضغط ملف ضخم جداً.
  if (file.size > 20 * 1024 * 1024) {
    throw new Error('الصورة كبيرة أوي (أكبر من 20 ميجا) — اختار صورة أصغر.')
  }
  const img = await loadImage(file)
  // محاولات متدرجة: نبدأ بجودة كويسة، ولو لسه كبيرة نقلل الحجم والجودة.
  const attempts: Array<[number, number]> = [
    [800, 0.7],
    [800, 0.55],
    [600, 0.5],
    [500, 0.45],
  ]
  let lastUrl = ''
  for (const [maxSide, quality] of attempts) {
    lastUrl = compress(img, maxSide, quality)
    if (dataUrlApproxBytes(lastUrl) <= MAX_PHOTO_BYTES) return lastUrl
  }
  const kb = Math.round(dataUrlApproxBytes(lastUrl) / 1024)
  throw new Error(
    `الصورة لسه كبيرة بعد الضغط (${kb} كيلوبايت) — الحد حوالي 250 كيلوبايت. ` +
      'صوّرها من أبعد شوية أو قلل جودة الكاميرا واختارها تاني.',
  )
}
