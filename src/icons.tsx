// أيقونات SVG حديثة بدل الإيموجي — خط رفيع وألوان متناسقة مع التطبيق.
import type { JSX } from 'react'

type IconProps = { className?: string }

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className ? `ic ${className}` : 'ic'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** راكب — شخص */
export function IconUser(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
    </Svg>
  )
}

/** سواق — عجلة قيادة */
export function IconDriver(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 14.2 12 20.5M5.5 14.5 10.2 13M18.5 14.5 13.8 13" />
    </Svg>
  )
}

/** محفظة */
export function IconWallet(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20 7H5a2 2 0 0 1 0-4h13v4" />
      <path d="M20 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
      <path d="M20 12h-4a1.5 1.5 0 0 0 0 3h4" />
    </Svg>
  )
}

/** إدارة — درع */
export function IconShield(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6L12 3z" />
      <path d="m9 11.5 2.2 2.2L15.5 9.5" />
    </Svg>
  )
}

/** دبوس موقع */
export function IconPin(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.6" />
    </Svg>
  )
}

/** هاتف */
export function IconPhone(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5 4h4l1.5 4.5L8 10.5a12 12 0 0 0 5.5 5.5l2-2.5L20 15v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
    </Svg>
  )
}

/** صح */
export function IconCheck(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" />
    </Svg>
  )
}

/** قائمة طلبات */
export function IconList(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12" />
      <circle cx="4" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="17.5" r="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** سجل الرحلات — ساعة بعقارب */
export function IconHistory(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.5 12a8.5 8.5 0 1 1 2.5 6" />
      <path d="M3.5 12H7l-1.5 2.5" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  )
}
