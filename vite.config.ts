import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // نسخة واحدة من @firebase/app في الحزمة: من غير ده Vite بيحزم
    // 0.16.6 (top level) و0.16.2 (nested تحت firebase/) مع بعض، فيفشل
    // تسجيل مكونات Auth/Firestore على الويب بخطأ
    // "Component auth has not been registered yet".
    dedupe: ['@firebase/app'],
  },
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
