/**
 * XD 와 Dex 는 같은 GitHub 릴리스에 함께 올라간다 — 이름이나 업데이트 정보가 겹치면 조용히 서로를 덮는다.
 * 설치본 설정이 그 경계를 지키는지 본다.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { macDmgUrl, UPDATE_REPO } from '../src/main/update-feed';

const here = join(__dirname, '..');
const xd = parse(readFileSync(join(here, 'electron-builder.yml'), 'utf8'));
const dex = parse(readFileSync(join(here, '../desktop/electron-builder.yml'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

test('정체성이 Dex 와 겹치지 않는다 — 나란히 설치된다', () => {
  assert.equal(xd.appId, 'com.plateerlab.xd');
  assert.notEqual(xd.appId, dex.appId);
  assert.notEqual(xd.productName, dex.productName);
  assert.equal(pkg.name, 'xd', 'Linux 창 클래스(WM_CLASS)가 여기서 온다');
  assert.equal(xd.linux.desktop.entry.StartupWMClass, pkg.name);
  // Wayland 의 app_id(= desktopName 에서 .desktop 을 뗀 것)가 설치되는 xd.desktop 과 같아야 창이 그 항목에 묶인다
  assert.equal(pkg.desktopName, `${pkg.name}.desktop`);
});

test('같은 릴리스에서 업데이트 정보와 산출물 이름이 겹치지 않는다', () => {
  assert.equal(xd.publish.repo, dex.publish.repo, '같은 릴리스에 함께 올라간다');
  assert.equal(xd.publish.channel, 'xd', 'latest*.yml 대신 xd*.yml');
  assert.equal(dex.publish.channel, undefined, 'Dex 는 그대로 latest');
  for (const key of ['linux', 'win', 'mac'] as const) {
    assert.match(xd[key].artifactName, /^XD-/);
    assert.doesNotMatch(dex[key].artifactName, /^XD-/);
  }
  assert.match(xd.mac.artifactName, /\$\{arch\}/, '아키텍처마다 엔진이 달라 dmg 이름에 아키텍처가 들어간다');
});

test('Windows 설치 폴더를 고를 수 있다 — 설치 폴더가 루트 폴더다', () => {
  assert.equal(xd.nsis.oneClick, false);
  assert.equal(xd.nsis.perMachine, false);
  assert.equal(xd.nsis.allowToChangeInstallationDirectory, true);
});

test('Windows 설치본이 처음 사용자별 설치에서 죽지 않는다 — electron-builder 26.12 이상', () => {
  // 26.12 아래의 multiUser.nsh 는 기본 설치 위치를 1024자로 읽어 힙을 넘겨 읽는다 — Windows 11 24H2·Server 2025
  // 에서 설치 프로그램이 바로 0xC0000005 로 죽는다(electron-builder #9769, CI 의 Windows 설치 확인이 겪은 일).
  const lock = JSON.parse(readFileSync(join(here, 'package-lock.json'), 'utf8'));
  const [major, minor] = String(lock.packages['node_modules/app-builder-lib'].version).split('.').map(Number);
  assert.ok(major > 26 || (major === 26 && minor >= 12), `app-builder-lib ${major}.${minor}`);
});

test('설치본에 동봉 엔진이 asar 밖 resources/engine/python 으로 실린다(엔진 자리와 같다)', () => {
  assert.deepEqual(xd.extraResources, [{ from: 'engine/dist/${platform}-${arch}/python', to: 'engine/python' }]);
});

test('Windows 제거·업데이트는 설치본이 깐 것만 지운다(목록은 설치본마다) — 루트의 데이터·사용자 파일은 남는다', async () => {
  assert.equal(xd.nsis.include, 'build/installer.nsh');
  assert.equal(xd.afterPack, 'scripts/after-pack.cjs');
  const nsh = readFileSync(join(here, 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /!macro customRemoveFiles[\s\S]*!insertmacro xdRemoveAppFiles/);
  assert.match(nsh, /!include "\$\{__FILEDIR__\}\\xd-app-files\.nsh"/);
  assert.doesNotMatch(nsh, /RMDir \/r "?\$INSTDIR"?\s*$/m, '설치 폴더를 통째로 지우지 않는다');
  assert.doesNotMatch(nsh, /FindFirst \$0/, '"이것만 빼고 다" 지우기가 아니다');
  // 설치본의 맨 위 항목에서 지울 목록을 만든다
  const out = mkdtempSync(join(tmpdir(), 'xd-afterpack-'));
  const app = join(out, 'win-unpacked');
  mkdirSync(join(app, 'locales'), { recursive: true });
  mkdirSync(join(app, 'resources', 'engine'), { recursive: true });
  writeFileSync(join(app, 'XD.exe'), 'x');
  writeFileSync(join(app, 'ffmpeg.dll'), 'x');
  const res = join(out, 'build');
  mkdirSync(res);
  const hook = require(join(here, 'scripts', 'after-pack.cjs')).default;
  await hook({ electronPlatformName: 'win32', appOutDir: app, packager: { info: { buildResourcesDir: res } } });
  const list = readFileSync(join(res, 'xd-app-files.nsh'), 'utf8');
  // 설치 크기는 electron-builder 가 정의한다 — 다시 정의하면 makensis 가 "already defined" 로 멈춘다
  assert.doesNotMatch(list, /!define\s+ESTIMATED_SIZE/);
  assert.deepEqual(
    list.split('\r\n').filter((l) => /^\s+(Delete|RMDir)/.test(l)).map((l) => l.trim()),
    [
      'Delete "$INSTDIR\\XD.exe"',
      'Delete "$INSTDIR\\ffmpeg.dll"',
      'RMDir /r "$INSTDIR\\locales"',
      'RMDir /r "$INSTDIR\\resources"',
      'Delete "$INSTDIR\\Uninstall XD.exe"',
      'Delete "$INSTDIR\\uninstallerIcon.ico"',
    ],
  );
  // 다른 OS 설치본에는 손대지 않는다
  await hook({ electronPlatformName: 'linux', appOutDir: app, packager: { info: { buildResourcesDir: join(out, 'none') } } });
});

test('업데이트가 보는 곳 = 발행하는 곳, 맥 dmg 이름 = 설치본 이름', () => {
  assert.equal(UPDATE_REPO, `${xd.publish.owner}/${xd.publish.repo}`);
  const name = xd.mac.artifactName.replace('${version}', '1.2.3').replace('${arch}', 'arm64').replace('${ext}', 'dmg');
  assert.equal(macDmgUrl('1.2.3', 'arm64'), `https://github.com/${UPDATE_REPO}/releases/download/v1.2.3/${name}`);
  assert.ok(pkg.dependencies['electron-updater'], '설치본이 업데이트 모듈을 싣는다');
});

test('앱 아이콘이 있다 — build/icon.png 1024px(electron-builder 가 Windows ico·macOS icns 로 바꾼다)', () => {
  const png = readFileSync(join(here, 'build', 'icon.png'));
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
});
