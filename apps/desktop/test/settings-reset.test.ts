// 저장 설정 초기화가 로컬 설정과 로그인 정보를 지운 뒤 재시작하는지 검증한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHANNELS } from '../src/main/ipc';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path: string): string => readFileSync(join(root, path), 'utf-8');

test('저장 설정 초기화 IPC를 preload에만 노출한다', () => {
  assert.equal(CHANNELS.resetSettings, 'app:resetSettings');
  assert.match(
    source('src/preload/index.ts'),
    /resetSettings:\s*\(\): void => ipcRenderer\.send\(CHANNELS\.resetSettings\)/,
  );
});

test('초기화는 설정·로그인 정보·자동 시작을 지우고 재시작한다', () => {
  const main = source('src/main/index.ts');
  const start = main.indexOf('async function resetStoredSettings');
  const end = main.indexOf('// ── System tray', start);
  const reset = main.slice(start, end);

  assert.match(reset, /tokenStore\.clear\(\)/);
  assert.match(reset, /credentialStore\.clear\(\)/);
  assert.match(reset, /applyAutoLaunch\(false\)/);
  assert.match(reset, /resetConfig\(\)/);
  assert.match(reset, /relaunchSelf\(\)/);
  assert.ok(reset.indexOf('resetConfig()') < reset.indexOf('relaunchSelf()'));
  assert.match(source('src/main/config.ts'), /rmSync\(configPath\(\), \{ force: true \}\)/);
});

test('설정 화면은 삭제 범위를 알리고 두 번째 클릭에서만 초기화한다', () => {
  const settings = source('src/renderer/src/views/Settings.tsx');

  assert.match(settings, /저장된 설정 초기화/);
  assert.match(settings, /초기화 및 재시작/);
  assert.match(settings, /저장된 로그인 정보가 모두/);
  assert.match(settings, /if \(!confirmSettingsReset\)/);
  assert.match(settings, /xgen\.appctl\.resetSettings\(\)/);
});

test('저장 설정 초기화는 다른 설정과 동일한 field-row 스타일을 사용한다', () => {
  const settings = source('src/renderer/src/views/Settings.tsx');
  const start = settings.indexOf('저장된 설정 초기화');
  const end = settings.indexOf('업데이트 서버', start);
  const resetSection = settings.slice(start - 80, end);

  assert.match(resetSection, /<div className="field-row">/);
  assert.doesNotMatch(resetSection, /<div className="field">/);
  assert.match(resetSection, /className="small notice-warn"/);
});
