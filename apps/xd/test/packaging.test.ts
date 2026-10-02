/**
 * XD 와 Dex 는 같은 GitHub 릴리스에 함께 올라간다 — 이름이나 업데이트 정보가 겹치면 조용히 서로를 덮는다.
 * 설치본 설정이 그 경계를 지키는지 본다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.equal(xd.linux.desktop.StartupWMClass, pkg.name);
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

test('설치본에 동봉 엔진이 asar 밖 resources/engine/python 으로 실린다(엔진 자리와 같다)', () => {
  assert.deepEqual(xd.extraResources, [{ from: 'engine/dist/${platform}-${arch}/python', to: 'engine/python' }]);
});

test('Windows 제거·업데이트는 설치 폴더(= 루트)의 workspace·.xd 를 남긴다', () => {
  assert.equal(xd.nsis.include, 'build/installer.nsh');
  const nsh = readFileSync(join(here, 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /!macro customRemoveFiles/);
  assert.match(nsh, /StrCmp \$1 "workspace" xd_rm_next/);
  assert.match(nsh, /StrCmp \$1 "\.xd" xd_rm_next/);
  assert.doesNotMatch(nsh, /RMDir \/r "?\$INSTDIR"?\s*$/m, '설치 폴더를 통째로 지우지 않는다');
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
