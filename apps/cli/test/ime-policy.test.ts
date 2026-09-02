import assert from 'node:assert/strict';
import test from 'node:test';
import { imePolicy } from '../src/tui/ime-policy';

test('macOS 는 Caps Lock 과 시스템 입력기를 쓴다', () => {
  assert.deepEqual(imePolicy('darwin'), { native: true, shortcut: 'Caps Lock' });
});

test('Linux와 Windows는 기존 CLI 조합기를 유지한다', () => {
  assert.deepEqual(imePolicy('linux'), { native: false, shortcut: 'Ctrl+Space' });
  assert.deepEqual(imePolicy('win32'), { native: false, shortcut: 'Ctrl+Space' });
});
