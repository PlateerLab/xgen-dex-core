// sandbox SSO preload의 단일 파일 계약과 디버그 UI 비노출을 검증한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHANNELS } from '../src/main/ipc';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path: string): string => readFileSync(join(root, path), 'utf-8');

test('SSO preload는 공용 모듈 없이 완료 IPC 채널만 직접 사용한다', () => {
  const preload = source('src/preload/sso.ts');

  assert.doesNotMatch(preload, /from ['"]\.\.\/main\/ipc['"]/);
  assert.match(preload, new RegExp(`['"]${CHANNELS.authSsoComplete}['"]`));
});

test('SSO 디버그는 AppData 설정으로만 유지하고 UI에는 노출하지 않는다', () => {
  const setup = source('src/renderer/src/views/ServerSetup.tsx');
  const settings = source('src/renderer/src/views/Settings.tsx');
  const config = source('src/main/config.ts');
  const main = source('src/main/index.ts');

  assert.doesNotMatch(setup, /ssoDebug|SSO 팝업 디버깅/);
  assert.doesNotMatch(settings, /ssoDebug|SSO 팝업 디버깅/);
  assert.match(config, /ssoDebug\?: boolean/);
  assert.match(main, /cfg\.ssoDebug === true/);
  assert.match(main, /openDevTools/);
});
