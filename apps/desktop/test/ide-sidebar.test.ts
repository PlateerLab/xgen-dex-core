/**
 * [IDE] 로 보는 동안 앱 사이드바를 접고, 채팅으로 돌아오면 우리가 접은 것만 다시 편다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { onIdeViewChange, onSidebarToggle } from '../src/renderer/src/views/ide-sidebar';

test('IDE 로 바뀌면 열려 있던 사이드바를 접는다', () => {
  assert.deepEqual(onIdeViewChange(false, true, { collapsed: false, autoCollapsed: false }), {
    collapsed: true,
    autoCollapsed: true,
  });
});

test('채팅으로 돌아오면 우리가 접은 사이드바를 다시 편다', () => {
  assert.deepEqual(onIdeViewChange(true, false, { collapsed: true, autoCollapsed: true }), {
    collapsed: false,
    autoCollapsed: false,
  });
});

test('원래 접혀 있던 사이드바는 돌아와도 접힌 채다', () => {
  const inIde = onIdeViewChange(false, true, { collapsed: true, autoCollapsed: false });
  assert.deepEqual(inIde, { collapsed: true, autoCollapsed: false });
  assert.deepEqual(onIdeViewChange(true, false, inIde), { collapsed: true, autoCollapsed: false });
});

test('IDE 에서 사용자가 사이드바를 열었으면 그 선택을 따른다', () => {
  let s = onIdeViewChange(false, true, { collapsed: false, autoCollapsed: false });
  s = onSidebarToggle(true, false, s);
  assert.deepEqual(s, { collapsed: false, autoCollapsed: false });
  // 다시 접고 채팅으로 돌아와도 펴지 않는다 — 접은 것은 사용자다.
  s = onSidebarToggle(true, true, s);
  assert.deepEqual(onIdeViewChange(true, false, s), { collapsed: true, autoCollapsed: false });
});

test('전환이 없으면 그대로다', () => {
  const s = { collapsed: false, autoCollapsed: false };
  assert.equal(onIdeViewChange(false, false, s), s);
  assert.equal(onIdeViewChange(true, true, { collapsed: true, autoCollapsed: true }).autoCollapsed, true);
});
