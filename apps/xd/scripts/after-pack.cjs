/**
 * electron-builder afterPack — Windows 설치본의 **지울 목록**을 만든다(build/xd-app-files.nsh).
 *
 * Windows 는 설치 폴더가 곧 XD 루트다. 제거·업데이트는 설치 폴더를 통째로 지우면 안 되고(작업 공간·.xd), "workspace·.xd
 * 를 빼고 다 지우기" 도 안 된다 — 사용자가 이미 쓰던 폴더에 깔았다면 그 사람의 파일까지 지운다. 그래서 **이 설치본이 실제로
 * 까는 것**(풀린 폴더의 맨 위 항목)만 적어 두고 제거는 그것만 지운다(installer.nsh 의 customRemoveFiles).
 * (설치 크기는 electron-builder 가 풀린 앱 크기로 정한다 — ESTIMATED_SIZE. 여기서 다시 정의하면 makensis 가 거절한다.)
 */
const { readdirSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const dir = context.appOutDir;
  const lines = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === 'workspace' || name === '.xd') throw new Error(`설치본에 사용자 데이터 이름(${name})이 있습니다`);
    const isDir = statSync(join(dir, name)).isDirectory();
    lines.push(isDir ? `  RMDir /r "$INSTDIR\\${name}"` : `  Delete "$INSTDIR\\${name}"`);
  }
  // 설치 프로그램이 따로 놓는 것.
  lines.push('  Delete "$INSTDIR\\Uninstall XD.exe"', '  Delete "$INSTDIR\\uninstallerIcon.ico"');
  const out = [
    '; scripts/after-pack.cjs 가 만든다 — 고치지 말 것(설치본마다 다시 만든다).',
    '!macro xdRemoveAppFiles',
    ...lines,
    '!macroend',
    '',
  ].join('\r\n');
  writeFileSync(join(context.packager.info.buildResourcesDir, 'xd-app-files.nsh'), out, 'utf8');
};
