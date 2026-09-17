/**
 * 끌어다 놓기 — 깊이 세기와 파일 판별.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DropTracker, dragHasFiles } from '../src/renderer/src/views/chat-drop';

test('파일을 들고 있을 때만 받는다', () => {
  assert.equal(dragHasFiles(['Files']), true);
  assert.equal(dragHasFiles(['text/plain']), false);
  assert.equal(dragHasFiles(undefined), false);
});

test('자식 요소를 지나도 안내가 깜빡이지 않는다', () => {
  const t = new DropTracker();
  assert.equal(t.enter(), true, '처음 들어올 때만 켠다');
  assert.equal(t.enter(), false, '자식 위로 들어온 것은 새로 켜지 않는다');
  assert.equal(t.leave(), false, '자식을 벗어난 것은 끄지 않는다');
  assert.equal(t.active, true);
  assert.equal(t.leave(), true, '전부 벗어나면 끈다');
  assert.equal(t.active, false);
});

test('놓은 뒤에는 깊이가 0 으로 돌아간다 — 남은 dragleave 가 오지 않기 때문', () => {
  const t = new DropTracker();
  t.enter();
  t.enter();
  t.reset();
  assert.equal(t.active, false);
  assert.equal(t.enter(), true, '다음 드래그를 다시 받을 수 있다');
});

test('깊이는 음수가 되지 않는다 — 짝이 맞지 않는 dragleave 가 와도', () => {
  const t = new DropTracker();
  assert.equal(t.leave(), true);
  assert.equal(t.enter(), true);
});
