import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.indtoktok.app',
  appName: 'ind toktok',
  webDir: 'dist',
  backgroundColor: '#fff8ec',
  android: {
    allowMixedContent: true,
  },
  server: {
    // لا يوجد خادم خارجي — التطبيق يعمل محلياً + Firebase عند ربطه
    cleartext: true,
  },
}

export default config
