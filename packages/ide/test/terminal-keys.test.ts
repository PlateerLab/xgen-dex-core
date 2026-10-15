// 터미널의 복사·붙여넣기 키 — 셸에 보낼 키(Ctrl+C 중단)와 겹치지 않게 가른다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalClipboardKey } from '../src/terminal';

const key = (code: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

test('윈도·리눅스 — Ctrl+V 는 붙여넣기다(셸에 ^V 를 보내지 않는다)', () => {
  assert.equal(terminalClipboardKey(key('KeyV', { ctrl: true }), false, false), 'paste');
  assert.equal(terminalClipboardKey(key('KeyV', { ctrl: true, shift: true }), false, false), 'paste');
  assert.equal(terminalClipboardKey(key('Insert', { shift: true }), false, false), 'paste');
});

test('윈도·리눅스 — Ctrl+C 는 고른 글자가 있을 때만 복사이고, 없으면 셸의 중단이다', () => {
  assert.equal(terminalClipboardKey(key('KeyC', { ctrl: true }), false, true), 'copy');
  assert.equal(terminalClipboardKey(key('KeyC', { ctrl: true }), false, false), null);
  assert.equal(terminalClipboardKey(key('KeyC', { ctrl: true, shift: true }), false, false), 'copy');
  assert.equal(terminalClipboardKey(key('Insert', { ctrl: true }), false, true), 'copy');
});

test('맥 — ⌘C·⌘V 만 클립보드이고 Ctrl 키는 모두 셸의 것이다', () => {
  assert.equal(terminalClipboardKey(key('KeyV', { meta: true }), true, false), 'paste');
  assert.equal(terminalClipboardKey(key('KeyC', { meta: true }), true, true), 'copy');
  assert.equal(terminalClipboardKey(key('KeyC', { meta: true }), true, false), null);
  assert.equal(terminalClipboardKey(key('KeyV', { ctrl: true }), true, false), null);
  assert.equal(terminalClipboardKey(key('KeyC', { ctrl: true }), true, true), null);
});

test('Alt 가 섞이면 셸로 보낸다', () => {
  assert.equal(terminalClipboardKey(key('KeyV', { ctrl: true, alt: true }), false, false), null);
  assert.equal(terminalClipboardKey(key('KeyV', { meta: true, alt: true }), true, false), null);
});
