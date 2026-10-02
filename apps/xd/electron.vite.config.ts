import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * XD 의 빌드 — main·preload·화면은 이 앱의 것이고, Dex 와 같은 **기본 부품**(마크다운·작업 과정·아이콘·스타일)만
 * Dex 렌더러(apps/desktop/src/renderer)에서 그대로 가져온다(DESIGN.md §8, `src/renderer/src/dex.ts`). 그래서 XD 를
 * 빌드하려면 Dex 의 의존(`npm --prefix apps/desktop ci`)이 먼저 깔려 있어야 한다 — 그 부품이 그쪽 node_modules 에서
 * react 등을 찾는다.
 *
 * 공용 패키지(@dex/*)는 Dex 와 같은 방식으로 **소스를 번들**한다(별칭).
 */
const DESKTOP = resolve(__dirname, '../desktop');
const DESKTOP_MODULES = resolve(DESKTOP, 'node_modules');

const dexAliases = [
  // IDE 스타일시트 — 서브경로 정규식보다 먼저(그쪽은 `.ts` 를 붙인다).
  { find: '@dex/ide/ide.css', replacement: resolve(__dirname, '../../packages/ide/src/ide.css') },
  { find: /^@dex\/(protocol|engine|rpc|ide)\/(.*)$/, replacement: resolve(__dirname, '../../packages/$1/src/$2.ts') },
  { find: '@dex/protocol', replacement: resolve(__dirname, '../../packages/protocol/src/index.ts') },
  { find: '@dex/engine', replacement: resolve(__dirname, '../../packages/engine/src/index.ts') },
  { find: '@dex/rpc', replacement: resolve(__dirname, '../../packages/rpc/src/index.ts') },
  { find: '@dex/ide', replacement: resolve(__dirname, '../../packages/ide/src/index.ts') },
];

/**
 * React 는 **한 벌** — Dex 화면 코드·packages/ide·XD 의 화면 코드가 모두 Dex 의 react 를 쓴다. 두 벌이 되면
 * 훅이 깨진다("Invalid hook call").
 */
const reactAliases = [
  { find: /^react-dom(\/.*)?$/, replacement: `${resolve(DESKTOP_MODULES, 'react-dom')}$1` },
  { find: /^react(\/.*)?$/, replacement: `${resolve(DESKTOP_MODULES, 'react')}$1` },
];

export default defineConfig({
  main: {
    resolve: { alias: dexAliases },
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } },
  },
  preload: {
    resolve: { alias: dexAliases },
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: [...dexAliases, ...reactAliases] },
    // 개발 서버가 이 앱 밖(Dex 화면 코드·공용 패키지)을 읽게 한다. 빌드에는 영향이 없다.
    server: { fs: { allow: [resolve(__dirname, '../..')] } },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
    plugins: [react()],
  },
});
