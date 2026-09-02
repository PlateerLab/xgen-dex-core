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
};
module.exports = config;
