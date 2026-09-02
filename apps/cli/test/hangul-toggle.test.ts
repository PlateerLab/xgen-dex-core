/**
 * 한/영을 바꾸는 키.
 *
 * 같은 Ctrl+Space 라도 터미널에 따라 다른 모습으로 도착한다. 예전 방식에서는 NUL 이
 * 와서 ink 이 ctrl + `` ` `` 로 읽고, Kitty 키보드 프로토콜에서는 **ctrl 이 붙은
 * 공백**으로 온다. 앞의 것만 보고 있었더니 kitty 에서는 한글을 켜지도 끄지도 못했다 —
 * 모드 표시는 켜져 있는데 아무 키도 듣지 않는 상태가 됐다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isHangulToggle } from '../src/tui/ime-text-input';

const key = (flags: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {}): {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
} => ({ ctrl: false, meta: false, shift: false, ...flags });

test('예전 방식 터미널의 Ctrl+Space', () => {
  // ink 은 NUL 을 ctrl + '`' 로 읽는다.
  assert.equal(isHangulToggle('`', key({ ctrl: true })), true);
});

test('Kitty 프로토콜의 Ctrl+Space', () => {
  // 여기서는 ctrl 이 붙은 공백으로 온다. 이것을 놓쳐서 kitty 에서 안 먹었다.
  assert.equal(isHangulToggle(' ', key({ ctrl: true })), true);
});

test('macOS 시스템 IME 모드에서는 Ctrl+Space를 CLI가 함께 처리하지 않는다', () => {
  assert.equal(isHangulToggle('`', key({ ctrl: true }), true), false);
  assert.equal(isHangulToggle(' ', key({ ctrl: true }), true), false);
});

test('Ctrl+L — 터미널이나 tmux 가 Ctrl+Space 를 채갈 때', () => {
  assert.equal(isHangulToggle('l', key({ ctrl: true })), true);
});

test('Alt+Space — 한/영 키가 놓인 자리', () => {
  assert.equal(isHangulToggle(' ', key({ meta: true })), true);
});

test('Shift+Space — 리눅스 입력기의 오랜 한/영 자리', () => {
  assert.equal(isHangulToggle(' ', key({ shift: true })), true);
});

test('그냥 공백은 바꾸지 않는다', () => {
  // 이것이 걸리면 띄어쓰기를 할 때마다 한/영이 뒤집혀 글을 쓸 수가 없다.
  assert.equal(isHangulToggle(' ', key()), false);
});

test('보통 글자는 바꾸지 않는다', () => {
  assert.equal(isHangulToggle('a', key()), false);
  assert.equal(isHangulToggle('A', key({ shift: true })), false);
  assert.equal(isHangulToggle('l', key()), false, 'Ctrl 없는 l 은 그냥 글자다');
  assert.equal(isHangulToggle('`', key()), false);
});

test('다른 Ctrl 조합은 건드리지 않는다', () => {
  // Ctrl+K 명령 팔레트, Ctrl+H 기록 같은 것들이 여기 걸리면 안 된다.
  for (const character of ['k', 'h', 'p', 'n', 'q']) {
    assert.equal(isHangulToggle(character, key({ ctrl: true })), false, `Ctrl+${character}`);
  }
});
