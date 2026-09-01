import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 데스크톱과 같은 방식 — 프로토콜을 소스로 직접 번들한다 (fetch 주입식
      // 브라우저 호환 계층이라 WebView 에서 그대로 돈다).
      '@dex/protocol': resolve(__dirname, '../../packages/protocol/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      // hash.ts 의 Node 폴백 — WebView 는 crypto.subtle 이 있어 실행되지 않는다.
      external: ['node:crypto'],
    },
  },
});
