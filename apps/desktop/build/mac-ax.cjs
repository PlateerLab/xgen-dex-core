// dex-ax(맥 접근성 도우미) 빌드 — 말로 다른 앱을 조작하는 빠른 조작(src/main/fast-act-computer.ts)이 띄운다.
//
// 설치본: afterPack 이 앱의 Contents/Resources/mac-ax/dex-ax 로 빌드한다(서명 전 — 그 뒤 앱 서명에 같이 묶인다).
// 개발 실행: `npm run build:mac-ax` → native/mac-ax/bin/dex-ax (git 에서 제외).
// swiftc(Xcode 명령행 도구)가 없으면 빌드를 건너뛴다 — 이 기능만 꺼지고(도우미 없음) 나머지는 그대로다.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'native', 'mac-ax', 'dex-ax.swift');
const DEV_OUT = path.join(__dirname, '..', 'native', 'mac-ax', 'bin', 'dex-ax');
const MIN_MACOS = '12.0';

function hasSwiftc() {
  try {
    execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** arches: ['arm64'] | ['x64'] | ['arm64', 'x64'](universal → lipo). 성공하면 true. */
function buildMacAx(out, arches) {
  if (process.platform !== 'darwin') return false;
  if (!hasSwiftc()) {
    console.warn('[mac-ax] swiftc 없음 — dex-ax 를 빌드하지 않는다 (다른 앱 조작이 꺼진다)');
    return false;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const parts = arches.map((arch) => {
    const target = `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos${MIN_MACOS}`;
    const file = arches.length === 1 ? out : `${out}-${arch}`;
    execFileSync('xcrun', ['swiftc', '-O', '-target', target, SOURCE, '-o', file], { stdio: 'inherit' });
    return file;
  });
  if (parts.length > 1) {
    execFileSync('lipo', ['-create', ...parts, '-output', out], { stdio: 'inherit' });
    for (const p of parts) fs.rmSync(p, { force: true });
  }
  fs.chmodSync(out, 0o755);
  console.log(`[mac-ax] ${out} (${arches.join('+')})`);
  return true;
}

module.exports = { buildMacAx, DEV_OUT };

if (require.main === module) {
  buildMacAx(DEV_OUT, [process.arch === 'x64' ? 'x64' : 'arm64']);
}
