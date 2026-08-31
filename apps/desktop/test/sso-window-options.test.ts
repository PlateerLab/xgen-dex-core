// SSO 팝업의 보안 격리와 선택적 DevTools 설정을 확인하는 단위 테스트
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSsoWindowOptions } from '../src/main/sso-window-options';

test('SSO 팝업 디버깅은 기본 보안 격리를 유지한 채 DevTools만 허용한다', () => {
  const options = createSsoWindowOptions('C:\\app\\sso.js', true);

  assert.equal(options.title, 'XGEN SSO 로그인 [디버그]');
  assert.deepEqual(options.webPreferences, {
    preload: 'C:\\app\\sso.js',
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    devTools: true,
  });
});

test('SSO 팝업 디버깅을 끄면 DevTools를 사용할 수 없다', () => {
  const options = createSsoWindowOptions('C:\\app\\sso.js', false);

  assert.equal(options.title, 'XGEN SSO 로그인');
  assert.equal(options.webPreferences?.devTools, false);
});
