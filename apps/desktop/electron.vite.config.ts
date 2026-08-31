import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * 공용 패키지는 **소스로 번들**한다 (런타임 의존이 아니다).
 *
 * node_modules 심링크나 버전 올림을 쓰지 않는 이유: electron-builder 는 패키징할
 * 때 심링크된 로컬 의존을 다루기 까다롭고, 버전 올림은 "코어를 고쳤는데 앱은 옛
 * 것을 쓰는" 상태 — 이 저장소가 없애려는 바로 그 상태 — 를 되살린다.
 * 세 앱 모두 번들러를 쓰므로 별칭이면 충분하다.
 */
const dexAliases = {
  '@dex/protocol': resolve(__dirname, '../../packages/protocol/src/index.ts'),
  '@dex/engine': resolve(__dirname, '../../packages/engine/src/index.ts'),
  '@dex/rpc': resolve(__dirname, '../../packages/rpc/src/index.ts'),
};

/** `@dex/protocol/browser` 같은 서브경로. 별칭은 정확 일치라 정규식으로 받는다. */
const dexSubpathAlias = {
  find: /^@dex\/(protocol|engine|rpc)\/(.*)$/,
  replacement: resolve(__dirname, '../../packages/$1/src/$2.ts'),
};

const deploymentDefaultDefines = Object.fromEntries(
  [
    'XGEN_DEFAULT_SERVER_URL',
    'XGEN_DEFAULT_ALLOW_PRIVATE_CERTIFICATE',
    'XGEN_DEFAULT_SSO_ENABLED',
    'XGEN_DEFAULT_SSO_PATH',
    'XGEN_DEFAULT_UPDATE_SERVER',
  ].map((name) => [`process.env.${name}`, JSON.stringify(process.env[name] ?? '')]),
);

/** 객체 별칭을 vite 의 배열 형태로 — 서브경로 정규식과 같이 쓰려면 배열이어야 한다. */
function aliasEntries() {
  return Object.entries(dexAliases).map(([find, replacement]) => ({ find, replacement }));
}

export default defineConfig({
  main: {
    define: deploymentDefaultDefines,
    resolve: { alias: [dexSubpathAlias, ...aliasEntries()] },
    plugins: [externalizeDepsPlugin()],
    // keytar (native), ws + the MCP SDK (spawns stdio children / ESM) must stay
    // external so they resolve from node_modules at runtime.
    // bufferutil/utf-8-validate: ws 의 optional native 가속 — ws 가 번들되면
    // rollup 이 lazy require 를 깨진 스텁으로 인라인해 첫 WS 프레임에서
    // `bufferUtil.mask is not a function` 이 터진다 (geny-connector 0.19.3
    // 실사고). ws 가 external 인 지금도 방어적으로 명시한다.
    // electron-updater/chokidar/picomatch 는 externalizeDepsPlugin 이 처리하지만
    // 명시해 회귀를 차단한다.
    build: {
      rollupOptions: {
        // 진입점 둘. fuse-host 는 **별도 프로세스**로 실행되는 FUSE 마운트
        // 호스트다 — Electron 메인에서 FUSE 네이티브를 직접 다루면 그쪽
        // 크래시(SIGSEGV)가 앱 전체를 죽인다.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'fuse-host': resolve(__dirname, 'src/main/fuse-host.ts'),
        },
        external: [
          'keytar',
          'ws',
          'bufferutil',
          'utf-8-validate',
          '@modelcontextprotocol/sdk',
          'electron-updater',
          'chokidar',
          'picomatch',
        ],
      },
    },
  },
  preload: {
    resolve: { alias: [dexSubpathAlias, ...aliasEntries()] },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          sso: resolve('src/preload/sso.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: [dexSubpathAlias, ...aliasEntries()] },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          overlay: resolve('src/renderer/overlay.html'),
          quickchat: resolve('src/renderer/quickchat.html'),
          // 잠긴 아바타의 컨트롤 창 (별도 창이라 별도 진입점).
          chip: resolve('src/renderer/chip.html'),
        },
      },
    },
    plugins: [react()],
  },
});
