import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      treeshake: {
        // مهم جداً: لازم كل الوحدات تُعامل كأن لها آثار جانبية، وإلا
        // الـ bundler يحذف استدعاءات تسجيل مكونات Firebase
        // (registerAuth / registerFirestore) من الحزمة، فيفشل
        // getAuth/getFirestore بخطأ "Component ... has not been registered yet"
        moduleSideEffects: true,
      },
    },
  },
})
