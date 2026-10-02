/**
 * XD 와 Dex 는 같은 GitHub 릴리스에 함께 올라간다 — 이름이나 업데이트 정보가 겹치면 조용히 서로를 덮는다.
 * 설치본 설정이 그 경계를 지키는지 본다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

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
