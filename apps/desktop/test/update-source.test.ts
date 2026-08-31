// XGEN 다운로드 센터 업데이트 패키지 선택 규칙을 검증한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareVersions,
  selectXgenUpdate,
  windowsNsisLauncherCommand,
  windowsNsisUpdateArgs,
} from '../src/main/update-source';

test('버전 앞의 v와 점 구분 숫자를 비교한다', () => {
  assert.ok(compareVersions('v1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.5.3', 'v1.5.3'), 0);
});

test('현재 OS와 호환되는 가장 높은 Connector 버전을 고른다', () => {
  const packages = [
    { id: 1, product: 'connector', version: '2.0.0', platform: 'windows', original_name: 'connector.exe' },
    { id: 2, product: 'connector', version: '1.8.0', platform: 'macos', original_name: 'connector.dmg' },
    { id: 3, product: 'connector', version: '1.9.0', platform: 'macos', original_name: 'connector.dmg' },
    { id: 4, product: 'extensions', version: '9.0.0', platform: 'macos', original_name: 'extensions.zip' },
  ];
  assert.equal(selectXgenUpdate(packages, 'darwin', '1.5.3')?.id, 3);
  assert.equal(selectXgenUpdate(packages, 'win32', '1.5.3')?.id, 1);
});

test('플랫폼 표기가 없어도 설치 파일 확장자로 판단하고 이전 버전은 제외한다', () => {
  const packages = [
    { id: 1, product: 'connector', version: '1.4.0', original_name: 'old.AppImage' },
    { id: 2, product: 'connector', version: '1.6.0', original_name: 'new.AppImage' },
  ];
  assert.equal(selectXgenUpdate(packages, 'linux', '1.5.3')?.id, 2);
  assert.equal(selectXgenUpdate(packages, 'linux', '1.6.0'), null);
});

test('Windows 설치는 진행 UI를 표시하는 NSIS update 인자를 사용한다', () => {
  assert.deepEqual(windowsNsisUpdateArgs(), ['--updated', '--force-run']);
  assert.equal(
    windowsNsisLauncherCommand(),
    'ping 127.0.0.1 -n 5 > nul & start "" "%XGEN_UPDATE_INSTALLER%" --updated --force-run',
  );
});
