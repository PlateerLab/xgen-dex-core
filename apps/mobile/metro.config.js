// 모노레포 — @dex/protocol 을 소스로 직접 번들 (데스크톱/구 안드로이드와 동일 방식).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [path.join(repoRoot, 'packages/protocol')];
config.resolver.extraNodeModules = {
  '@dex/protocol': path.join(repoRoot, 'packages/protocol/src/index.ts'),
  // protocol/hash.ts 의 Node 폴백 — RN 에선 shim(crypto.subtle 설치)이 선행되어
  // 절대 실행되지 않지만, metro 는 정적으로 해석하므로 가짜 모듈을 물린다.
  'node:crypto': path.join(projectRoot, 'src/shims/node-crypto.js'),
  // 내장 셸(just-bash/browser, 사용자 PC 접속)의 gzip 명령이 정적으로 부른다 — 휴대폰에서는 쓰지 않는다.
  'node:zlib': path.join(projectRoot, 'src/shims/node-zlib.js'),
};
// 내장 셸의 html-to-markdown 명령만 쓰는 turndown 은 설치돼 있어도 껍데기로 바꿔 끼운다(extraNodeModules 는
// 해석이 실패할 때만 쓰인다). 휴대폰에서는 그 명령을 쓰지 않는다.
const SHIMMED = { turndown: path.join(projectRoot, 'src/shims/turndown.js') };
config.resolver.resolveRequest = (context, moduleName, platform) =>
  SHIMMED[moduleName]
    ? { type: 'sourceFile', filePath: SHIMMED[moduleName] }
    : context.resolveRequest(context, moduleName, platform);
module.exports = config;
